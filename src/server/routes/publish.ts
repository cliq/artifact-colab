/**
 * Bearer-authed REST endpoints for agents, complementing the MCP tools for
 * artifacts too large to pass through a tool call.
 *
 * POST /api/publish: multipart/form-data upload so agents can publish large
 * artifacts straight from disk (e.g. via curl) instead of inlining megabytes
 * of HTML or base64 into an MCP tool call. Same caps and behavior as the
 * publish_artifact MCP tool. Fields: title (required), exactly one of html /
 * markdown (file part or text field), document_id (optional), visibility
 * (optional, 'team' | 'public'), project (optional text; empty clears it), assets (repeated file parts; each part's
 * filename is the reference name used in the HTML, its content-type the mime).
 *
 * GET /api/docs/:slug/raw: the stored source of a version exactly as it was
 * published — HTML, or Markdown for markdown-published versions (no
 * annotator, no inlined assets) — the download target the get_artifact MCP
 * tool points at when the artifact is too large to inline.
 */

import { Buffer } from 'node:buffer';

import { Hono, type Context } from 'hono';

import { getTokenAuth, touchToken } from '../auth.js';
import type { AppEnv } from '../context.js';
import { bearerAuth, sessionAuth } from '../middleware.js';
import type { IncomingAsset } from '../services/assets.js';
import { isDocumentVisibility } from '../services/documents.js';
import { publishArtifact, publishDocumentVersion, type PublishInput } from '../services/publish.js';
import { findDocumentInTeam, findVersion } from './api.js';

export const publishRoutes = new Hono<AppEnv>();

publishRoutes.use('/api/publish', bearerAuth());
publishRoutes.use('/api/docs/:slug/raw', bearerAuth());

publishRoutes.get('/api/docs/:slug/raw', (c) => {
  const db = c.get('db');
  touchToken(db, c.get('token').id, new Date());
  const doc = findDocumentInTeam(db, c.req.param('slug'), c.get('tokenTeamId'), c.get('user').id);
  if (!doc) return c.json({ error: 'not found' }, 404);

  const versionParam = c.req.query('version');
  let number: number | undefined;
  if (versionParam !== undefined) {
    number = Number(versionParam);
    if (!Number.isInteger(number) || number < 1) return c.json({ error: 'version must be a positive integer' }, 400);
  }

  const version = findVersion(db, doc, number);
  if (!version) return c.json({ error: number !== undefined ? `no version ${number}` : 'no published version' }, 404);

  if (version.sourceMarkdown !== null) {
    return c.body(version.sourceMarkdown, 200, { 'content-type': 'text/markdown; charset=utf-8' });
  }
  return c.body(version.html, 200, { 'content-type': 'text/html; charset=utf-8' });
});

/** One multipart parser for bearer publishing and artifact-specific session uploads. */
type SessionPublishInput = Omit<PublishInput, 'documentId' | 'visibility' | 'project'> & {
  documentId?: undefined;
  visibility?: undefined;
  project?: undefined;
};

async function readPublishForm(c: Context<AppEnv>, allowProject: true): Promise<PublishInput | { error: string }>;
async function readPublishForm(c: Context<AppEnv>, allowProject: false): Promise<SessionPublishInput | { error: string }>;
async function readPublishForm(c: Context<AppEnv>, allowProject: boolean): Promise<PublishInput | { error: string }> {
  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    return { error: 'expected a multipart/form-data or form-encoded body' };
  }

  const titleField = body['title'];
  const title = typeof titleField === 'string' ? titleField.trim() : '';
  if (!title || title.length > 300) {
    return { error: 'title is required (text field, max 300 chars)' };
  }

  const documentIdField = body['document_id'];
  if (documentIdField !== undefined && typeof documentIdField !== 'string') {
    return { error: 'document_id must be a text field' };
  }
  const documentId = documentIdField === '' ? undefined : documentIdField;

  const visibilityField = body['visibility'];
  if (visibilityField !== undefined && visibilityField !== '' && !isDocumentVisibility(visibilityField)) {
    return { error: 'visibility must be "team", "public" or "private"' };
  }
  const visibility = visibilityField === '' || visibilityField === undefined ? undefined : visibilityField;

  const projectField = body['project'];
  if (!allowProject && projectField !== undefined) {
    return { error: 'this endpoint only updates content; project cannot be changed' };
  }
  let project: string | null | undefined;
  if (allowProject && projectField !== undefined) {
    if (Array.isArray(projectField) || projectField instanceof File) {
      return { error: 'project must be a single text field' };
    }
    if (projectField === '') {
      project = null;
    } else if (projectField.trim() === '') {
      return { error: 'project must not be whitespace-only' };
    } else {
      project = projectField;
    }
  }

  // Repeated fields arrive as arrays under parseBody({ all: true }); a
  // duplicated html/markdown part must fail loudly, not fall through as
  // "absent" and hand the win to the other format.
  if (Array.isArray(body['html']) || Array.isArray(body['markdown'])) {
    return { error: 'html and markdown must each be a single file part or text field' };
  }
  const readPart = async (field: string | File | undefined): Promise<string | undefined> => {
    if (typeof field === 'string') return field;
    if (field instanceof File) return field.text();
    return undefined;
  };
  const html = await readPart(body['html']);
  const markdown = await readPart(body['markdown']);
  if ((html === undefined) === (markdown === undefined)) {
    return { error: 'provide exactly one of html or markdown (a single file part or text field)' };
  }
  const source = html ?? markdown!;
  if (source.length === 0) return { error: `${html !== undefined ? 'html' : 'markdown'} is empty` };

  const assetsField = body['assets'];
  const parts = Array.isArray(assetsField) ? assetsField : assetsField !== undefined ? [assetsField] : [];
  const assets: IncomingAsset[] = [];
  for (const part of parts) {
    if (!(part instanceof File)) return { error: 'every assets part must be a file' };
    assets.push({
      name: part.name,
      mime: part.type || 'application/octet-stream',
      data: Buffer.from(await part.arrayBuffer()),
    });
  }

  return { title, html, markdown, documentId, visibility, project, assets };
}

publishRoutes.post('/api/publish', async (c) => {
  const input = await readPublishForm(c, true);
  if ('error' in input) return c.json(input, 400);
  // Revalidate a bearer after its body streams; revocation must also prevent new documents.
  const header = c.req.header('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const auth = getTokenAuth(c.get('db'), bearer, new Date());
  if (!auth) return c.json({ error: 'invalid or revoked token' }, 401);
  touchToken(c.get('db'), auth.token.id, new Date());
  const outcome = publishArtifact(c.get('db'), c.get('config'), auth.user, auth.token.teamId, input);
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({
    url: outcome.url,
    document_id: outcome.documentId,
    version: outcome.versionNumber,
    orphaned_comments: outcome.orphaned,
    project: outcome.project,
    project_created: outcome.projectCreated,
  });
});

publishRoutes.post('/api/docs/:slug/versions', sessionAuth({ redirect: false }), async (c) => {
  const input = await readPublishForm(c, false);
  if ('error' in input) return c.json(input, 400);
  if (input.documentId !== undefined || input.visibility !== undefined) return c.json({ error: 'this endpoint only updates the addressed artifact; visibility cannot be changed' }, 400);
  const outcome = publishDocumentVersion(c.get('db'), c.get('config'), c.get('user'), c.req.param('slug'), input);
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ url: outcome.url, document_id: outcome.documentId, version: outcome.versionNumber, orphaned_comments: outcome.orphaned });
});
