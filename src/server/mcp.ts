/**
 * MCP endpoint (Streamable HTTP, stateless) exposing publish_artifact,
 * get_artifact, get_comments, resolve_comment, and delete_artifact. Auth is a personal access token via
 * `Authorization: Bearer` — the bearerAuth middleware resolves the user, and
 * the user rides into the per-request McpServer instance through
 * `authInfo.extra` (createMcpHandler calls the factory once per request).
 */

import { createMcpHandler, type AuthInfo, type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { z } from 'zod';

import type { Config } from './config.js';
import type { AppEnv } from './context.js';
import type { DB } from './db/index.js';
import type { User } from './db/schema.js';
import { comments } from './db/schema.js';
import { bearerAuth } from './middleware.js';
import {
  buildThread,
  exportContext,
  findDocumentInTeam,
  findOwnedTopLevelComment,
  findVersion,
  sortTopLevel,
  topLevelCommentsFor,
} from './routes/api.js';
import { assetsForDocument } from './services/assets.js';
import type { IncomingAsset } from './services/assets.js';
import { deleteDocumentCascade } from './services/documents.js';
import { publishArtifact } from './services/publish.js';

import { and, eq } from 'drizzle-orm';

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function buildMcpServer(deps: { db: DB; config: Config }, user: User, teamId: string): McpServer {
  const { db, config } = deps;
  const server = new McpServer({ name: 'artifact-colab', version: '1.0.0' });

  server.registerTool(
    'publish_artifact',
    {
      title: 'Publish artifact',
      description:
        'Publish a self-contained HTML artifact. Prefer HTML for new artifacts — a designed page is what the team expects to review. ' +
        'Alternatively, pass `markdown` instead of `html` when that fits the workflow better: the content already lives in Markdown, ' +
        'you want to spend fewer tokens, or a cleanly typeset document is all that is needed — the server renders it to a clean HTML page ' +
        'and hands your Markdown source back from get_artifact when you revise. ' +
        'Without document_id, creates a new document and returns its shareable URL. ' +
        'With document_id, appends a new version to that document; existing comments re-anchor onto the new version where their quoted text still exists. ' +
        'Binary files (screenshots, images) go in `assets` instead of being inlined: reference each one from the HTML by its exact name ' +
        '(e.g. <img src="shots/bar.png">, or ![alt](shots/bar.png) in Markdown) and the server substitutes it when rendering. ' +
        'For files too large to inline in a tool call, publish from disk instead — POST multipart/form-data to ' +
        `${config.baseUrl}/api/publish with the same bearer token: curl -X POST ${config.baseUrl}/api/publish ` +
        '-H "Authorization: Bearer $TOKEN" -F title="..." -F html=@page.html -F "assets=@bar.png;filename=shots/bar.png" ' +
        '(pass -F markdown=@page.md instead of the html part to publish Markdown; document_id and visibility are optional form fields; ' +
        'each asset filename is its reference name; $TOKEN is the same token ' +
        'this MCP server is configured with, e.g. in the Authorization header of its entry in your MCP config).',
      inputSchema: z.object({
        title: z.string().min(1).max(300).describe('Human-readable document title'),
        html: z.string().min(1).optional().describe('Complete HTML for the artifact (max 5 MB); exactly one of html/markdown'),
        markdown: z.string().min(1).optional().describe('Markdown (GFM) source (max 5 MB); exactly one of html/markdown'),
        document_id: z.string().optional().describe('Existing document ID to publish a new version of'),
        visibility: z
          .enum(['team', 'public'])
          .optional()
          .describe(
            "Who can open the URL: 'team' (members only, the default for new documents) or 'public' (anyone signed in on the instance who has the link). Omitted on a republish keeps the document's current setting",
          ),
        assets: z
          .array(
            z.object({
              name: z.string().describe('Reference name used in src attributes, e.g. "shots/bar.png"'),
              mime_type: z.string().describe('e.g. "image/png"'),
              data_base64: z.string().describe('Base64-encoded file contents (4 MB max each, 20 MB total)'),
            }),
          )
          .optional()
          .describe('Files referenced by the HTML; re-uploading a name replaces it for the whole document'),
      }),
    },
    async ({ title, html, markdown, document_id, visibility, assets: incomingAssets }) => {
      const decodedAssets: IncomingAsset[] = [];
      for (const a of incomingAssets ?? []) {
        const data = Buffer.from(a.data_base64, 'base64');
        if (data.length === 0) return toolError(`asset ${a.name} is empty or not valid base64`);
        decodedAssets.push({ name: a.name, mime: a.mime_type, data });
      }

      const outcome = publishArtifact(db, config, user, teamId, {
        title,
        html,
        markdown,
        documentId: document_id,
        visibility,
        assets: decodedAssets,
      });
      if (!outcome.ok) return toolError(outcome.error);

      const lines = [
        `Published "${title}" as version ${outcome.versionNumber}: ${outcome.url}`,
        `document_id: ${outcome.documentId}`,
      ];
      if (visibility === 'public') {
        lines.push('The URL is shareable with anyone signed in on this instance.');
      }
      if (outcome.orphaned > 0) {
        const n = outcome.orphaned;
        lines.push(`${n} previously-anchored comment${n === 1 ? '' : 's'} no longer match and ${n === 1 ? 'is' : 'are'} orphaned.`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    },
  );

  // Above this size the source is not returned inline; the tool hands back a
  // curl command against /api/docs/:slug/raw instead — the server decides,
  // so the client never has to guess whether an artifact is "too big".
  const INLINE_HTML_LIMIT = 50 * 1024;

  server.registerTool(
    'get_artifact',
    {
      title: 'Get artifact',
      description:
        'Fetch the published source of a document, exactly as it was published — HTML, or Markdown for versions published via `markdown` ' +
        '(latest version unless a version number is given). ' +
        'Small artifacts are returned inline; for larger ones the result is a ready-to-run curl command that downloads the ' +
        'source to disk instead — run it as given.',
      inputSchema: z.object({
        document_id: z.string(),
        version: z.number().int().positive().optional().describe('Version number to fetch; omit for the current version'),
      }),
    },
    async ({ document_id, version }) => {
      const doc = findDocumentInTeam(db, document_id, teamId);
      if (!doc) return toolError(`unknown document_id: ${document_id}`);

      const row = findVersion(db, doc, version);
      if (!row) {
        return toolError(
          version !== undefined ? `document ${doc.id} has no version ${version}` : `document ${doc.id} has no published version`,
        );
      }

      const isMarkdown = row.sourceMarkdown !== null;
      const source = row.sourceMarkdown ?? row.html;
      const assetNames = assetsForDocument(db, doc.id).map((a) => a.name);
      const headerLines = [`"${doc.title}" — version ${row.number} of ${doc.id}${isMarkdown ? ' (published as Markdown)' : ''}`];
      if (doc.visibility === 'public') {
        headerLines.push('Visibility: public (anyone signed in on the instance can open the URL).');
      }
      if (assetNames.length > 0) {
        headerLines.push(`Referenced assets (stored separately, substituted when rendering): ${assetNames.join(', ')}`);
      }

      const bytes = Buffer.byteLength(source, 'utf8');
      if (bytes <= INLINE_HTML_LIMIT) {
        return {
          content: [
            { type: 'text', text: headerLines.join('\n') },
            { type: 'text', text: source },
          ],
        };
      }

      const rawUrl = `${config.baseUrl}/api/docs/${doc.id}/raw?version=${row.number}`;
      headerLines.push(
        `The ${isMarkdown ? 'Markdown' : 'HTML'} is ${Math.round(bytes / 1024)} KB — too large to return inline. Download it with:`,
        `curl -H "Authorization: Bearer $TOKEN" "${rawUrl}" -o artifact.${isMarkdown ? 'md' : 'html'}`,
        '($TOKEN is the same token this MCP server is configured with, e.g. in the Authorization header of its entry in your MCP config.)',
      );
      return { content: [{ type: 'text', text: headerLines.join('\n') }] };
    },
  );

  server.registerTool(
    'get_comments',
    {
      title: 'Get comments',
      description:
        'Fetch comment threads on a document as structured JSON: quoted text, anchor context, author, replies, resolution status, ' +
        "and each comment's anchor state on the current version (anchored / ambiguous / orphaned).",
      inputSchema: z.object({
        document_id: z.string(),
        status: z.enum(['open', 'resolved']).optional().describe('Filter by thread status; omit for all'),
      }),
    },
    async ({ document_id, status }) => {
      const doc = findDocumentInTeam(db, document_id, teamId);
      if (!doc) return toolError(`unknown document_id: ${document_id}`);
      let topLevel = sortTopLevel(topLevelCommentsFor(db, doc.id));
      if (status) topLevel = topLevel.filter((c) => c.status === status);
      const threads = topLevel.map((c) => buildThread(db, c, doc.currentVersionId ?? undefined, doc.teamId));
      const ctx = exportContext(db, config.baseUrl, doc);
      const payload = {
        document: {
          id: doc.id,
          title: doc.title,
          url: ctx.url,
          version: ctx.versionNumber,
          versionUrl: ctx.versionUrl,
        },
        comments: threads,
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve comment',
      description: 'Mark a top-level comment thread as resolved (e.g. after addressing it in a republished version).',
      inputSchema: z.object({ comment_id: z.string() }),
    },
    async ({ comment_id }) => {
      const owned = findOwnedTopLevelComment(db, comment_id, { teamId });
      if (!owned) return toolError(`unknown comment_id (or not a top-level comment): ${comment_id}`);
      db.update(comments)
        .set({ status: 'resolved', resolvedAt: new Date(), resolvedBy: user.id })
        .where(and(eq(comments.id, comment_id), eq(comments.documentId, owned.document.id)))
        .run();
      return { content: [{ type: 'text', text: `Comment ${comment_id} resolved.` }] };
    },
  );

  server.registerTool(
    'delete_artifact',
    {
      title: 'Delete artifact',
      description:
        'Permanently delete a document you created, along with all its versions, comments, and assets. ' +
        'Only documents created by the user this token belongs to can be deleted. This cannot be undone.',
      inputSchema: z.object({ document_id: z.string() }),
    },
    async ({ document_id }) => {
      const doc = findDocumentInTeam(db, document_id, teamId);
      if (!doc) return toolError(`unknown document_id: ${document_id}`);
      if (doc.createdBy !== user.id) {
        return toolError(`document ${document_id} was created by another user; only its creator can delete it`);
      }
      deleteDocumentCascade(db, doc.id);
      return { content: [{ type: 'text', text: `Deleted "${doc.title}" (${doc.id}) and all its versions, comments, and assets.` }] };
    },
  );

  return server;
}

export function mcpRoutes(deps: { db: DB; config: Config }): Hono<AppEnv> {
  const handler = createMcpHandler((ctx) => {
    const user = ctx.authInfo?.extra?.user as User | undefined;
    const teamId = ctx.authInfo?.extra?.teamId as string | undefined;
    if (!user || !teamId) throw new Error('mcp handler invoked without an authenticated user');
    return buildMcpServer(deps, user, teamId);
  });

  const routes = new Hono<AppEnv>();
  routes.use('/mcp', bearerAuth());
  routes.use('/mcp/*', bearerAuth());
  routes.all('/mcp', (c) => {
    const user = c.get('user');
    const authInfo: AuthInfo = { token: '', clientId: user.id, scopes: [], extra: { user, teamId: c.get('tokenTeamId') } };
    return handler.fetch(c.req.raw, { authInfo });
  });
  return routes;
}
