/**
 * Bearer-authed REST endpoints for agents, complementing the MCP tools for
 * artifacts too large to pass through a tool call.
 *
 * POST /api/publish: multipart/form-data upload so agents can publish large
 * artifacts straight from disk (e.g. via curl) instead of inlining megabytes
 * of HTML or base64 into an MCP tool call. Same caps and behavior as the
 * publish_artifact MCP tool. Fields: title (required), exactly one of html /
 * markdown (file part or text field), document_id (optional), visibility
 * (optional, 'team' | 'public'), assets (repeated file parts; each part's
 * filename is the reference name used in the HTML, its content-type the mime).
 *
 * GET /api/docs/:slug/raw: the stored source of a version exactly as it was
 * published — HTML, or Markdown for markdown-published versions (no
 * annotator, no inlined assets) — the download target the get_artifact MCP
 * tool points at when the artifact is too large to inline.
 */

import { Buffer } from 'node:buffer';

import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { bearerAuth } from '../middleware.js';
import type { IncomingAsset } from '../services/assets.js';
import { isDocumentVisibility } from '../services/documents.js';
import { publishArtifact } from '../services/publish.js';
import { findDocumentInTeam, findVersion } from './api.js';

export const publishRoutes = new Hono<AppEnv>();

publishRoutes.use('/api/publish', bearerAuth());
publishRoutes.use('/api/docs/:slug/raw', bearerAuth());

publishRoutes.get('/api/docs/:slug/raw', (c) => {
  const db = c.get('db');
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

publishRoutes.post('/api/publish', async (c) => {
  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    return c.json({ error: 'expected a multipart/form-data or form-encoded body' }, 400);
  }

  const titleField = body['title'];
  const title = typeof titleField === 'string' ? titleField.trim() : '';
  if (!title || title.length > 300) {
    return c.json({ error: 'title is required (text field, max 300 chars)' }, 400);
  }

  const documentIdField = body['document_id'];
  if (documentIdField !== undefined && typeof documentIdField !== 'string') {
    return c.json({ error: 'document_id must be a text field' }, 400);
  }
  const documentId = documentIdField === '' ? undefined : documentIdField;

  const visibilityField = body['visibility'];
  if (visibilityField !== undefined && visibilityField !== '' && !isDocumentVisibility(visibilityField)) {
    return c.json({ error: 'visibility must be "team", "public" or "private"' }, 400);
  }
  const visibility = visibilityField === '' || visibilityField === undefined ? undefined : visibilityField;

  // Repeated fields arrive as arrays under parseBody({ all: true }); a
  // duplicated html/markdown part must fail loudly, not fall through as
  // "absent" and hand the win to the other format.
  if (Array.isArray(body['html']) || Array.isArray(body['markdown'])) {
    return c.json({ error: 'html and markdown must each be a single file part or text field' }, 400);
  }
  const readPart = async (field: string | File | undefined): Promise<string | undefined> => {
    if (typeof field === 'string') return field;
    if (field instanceof File) return field.text();
    return undefined;
  };
  const html = await readPart(body['html']);
  const markdown = await readPart(body['markdown']);
  if ((html === undefined) === (markdown === undefined)) {
    return c.json({ error: 'provide exactly one of html or markdown (a single file part or text field)' }, 400);
  }
  const source = html ?? markdown!;
  if (source.length === 0) return c.json({ error: `${html !== undefined ? 'html' : 'markdown'} is empty` }, 400);

  const assetsField = body['assets'];
  const parts = Array.isArray(assetsField) ? assetsField : assetsField !== undefined ? [assetsField] : [];
  const assets: IncomingAsset[] = [];
  for (const part of parts) {
    if (!(part instanceof File)) return c.json({ error: 'every assets part must be a file' }, 400);
    assets.push({
      name: part.name,
      mime: part.type || 'application/octet-stream',
      data: Buffer.from(await part.arrayBuffer()),
    });
  }

  const user = c.get('user');
  const outcome = publishArtifact(c.get('db'), c.get('config'), user, c.get('tokenTeamId'), { title, html, markdown, documentId, visibility, assets });
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);

  return c.json({
    url: outcome.url,
    document_id: outcome.documentId,
    version: outcome.versionNumber,
    orphaned_comments: outcome.orphaned,
  });
});
