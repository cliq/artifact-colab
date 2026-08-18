/**
 * Viewer page route (/d/:slug) and the client bundle (/static/viewer.js).
 * The raw artifact HTML is served separately by routes/frame.ts with its own
 * sandbox headers.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asc, count, eq, isNull, and } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { comments, versions, type Document } from '../db/schema.js';
import { csrfTokenFor } from '../middleware.js';
import { DocumentDeletePage, DocumentPage } from '../pages/document.js';
import { safeLocalPath } from '../safeRedirect.js';
import { deleteDocumentCascade, isDocumentVisibility, setDocumentVisibility } from '../services/documents.js';
import { isTeamAdmin } from '../services/teams.js';
import { isWatching, setWatching } from '../services/watches.js';
import { findDocumentForUser, findDocumentForViewer } from './api.js';

let viewerJsCache: string | null = null;

function getViewerJs(): string {
  if (viewerJsCache !== null) return viewerJsCache;
  try {
    viewerJsCache = readFileSync(join(process.cwd(), 'dist', 'viewer.js'), 'utf8');
  } catch {
    console.warn('dist/viewer.js not found — run npm run build:client');
    viewerJsCache = '';
  }
  return viewerJsCache;
}

/** Test hook: force a re-read of the viewer bundle. */
export function resetViewerCache(): void {
  viewerJsCache = null;
}

export const documentRoutes = new Hono<AppEnv>();

/**
 * True when the signed-in user may delete this document: its author, or an
 * admin of its team. Callers must already have established membership
 * (`findDocumentForUser`) — a public document's creator who left the team is a
 * guest, not an owner.
 */
export function canDeleteDocument(c: Context<AppEnv>, doc: Document): boolean {
  const user = c.get('user');
  return doc.createdBy === user.id || isTeamAdmin(c.get('db'), doc.teamId, user.id);
}

/** The document, if the requester may delete it, or null → the caller must 404 (matching the admin surfaces). */
function deletableDocument(c: Context<AppEnv>, slug: string): Document | null {
  const doc = findDocumentForUser(c.get('db'), slug, c.get('user').id);
  if (!doc || !canDeleteDocument(c, doc)) return null;
  return doc;
}

documentRoutes.get('/static/viewer.js', (c) =>
  c.body(getViewerJs(), 200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-cache',
  }),
);

documentRoutes.get('/d/:slug', (c) => {
  const user = c.get('user');
  const db = c.get('db');
  const config = c.get('config');
  const slug = c.req.param('slug');

  const access = findDocumentForViewer(db, slug, user.id);
  if (!access) return c.notFound();
  const doc = access.document;

  const versionRows = db
    .select({ id: versions.id, number: versions.number, publishedAt: versions.publishedAt })
    .from(versions)
    .where(eq(versions.documentId, doc.id))
    .orderBy(asc(versions.number))
    .all();
  if (versionRows.length === 0) return c.notFound();

  const versionParam = c.req.query('version');
  let shown = versionRows.find((v) => v.id === doc.currentVersionId) ?? versionRows[versionRows.length - 1]!;
  if (versionParam !== undefined) {
    const number = Number.parseInt(versionParam, 10);
    const requested = versionRows.find((v) => v.number === number);
    if (!requested) return c.notFound();
    shown = requested;
  }

  const csrfToken = csrfTokenFor(c);
  return c.html(
    <DocumentPage
      user={user}
      csrfToken={csrfToken}
      document={doc}
      versions={versionRows}
      shownVersion={shown}
      watching={isWatching(db, doc.id, user.id)}
      canDelete={access.isMember && canDeleteDocument(c, doc)}
      isMember={access.isMember}
      shareUrl={`${config.baseUrl}/d/${doc.id}`}
    />,
  );
});

// Any member may toggle team/public (consistent with the flat publish/comment
// model); only the creator may make a document private. Non-members 404 like
// every other member-gated action.
documentRoutes.post('/d/:slug/share', async (c) => {
  const user = c.get('user');
  const db = c.get('db');

  // Body first, membership second: the DB is synchronous, so checking after
  // the last await keeps check-and-act atomic — a member removed while the
  // form body streams in can't resume and expose team content.
  const body = await c.req.parseBody();

  const doc = findDocumentForUser(db, c.req.param('slug'), user.id);
  if (!doc) return c.notFound();

  const visibility = body['visibility'];
  if (!isDocumentVisibility(visibility)) return c.text('visibility must be "team", "public" or "private"', 400);
  if (visibility === 'private' && doc.createdBy !== user.id) {
    return c.text('only the creator of a document can make it private', 403);
  }
  setDocumentVisibility(db, doc, visibility);

  const requested = typeof body['next'] === 'string' ? body['next'] : undefined;
  return c.redirect(safeLocalPath(requested) ?? `/d/${doc.id}`, 302);
});

documentRoutes.get('/d/:slug/delete', (c) => {
  const doc = deletableDocument(c, c.req.param('slug'));
  if (!doc) return c.notFound();
  const db = c.get('db');

  const counts = {
    versions: db.select({ value: count() }).from(versions).where(eq(versions.documentId, doc.id)).all()[0]!.value,
    comments: db
      .select({ value: count() })
      .from(comments)
      .where(and(eq(comments.documentId, doc.id), isNull(comments.parentId)))
      .all()[0]!.value,
  };
  return c.html(<DocumentDeletePage user={c.get('user')} csrfToken={csrfTokenFor(c)} document={doc} counts={counts} />);
});

documentRoutes.post('/d/:slug/delete', (c) => {
  const doc = deletableDocument(c, c.req.param('slug'));
  if (!doc) return c.notFound();

  deleteDocumentCascade(c.get('db'), doc.id);
  return c.redirect('/', 302);
});

documentRoutes.post('/d/:slug/watch', async (c) => {
  const user = c.get('user');
  const db = c.get('db');
  const slug = c.req.param('slug');

  // Body first, access second — same revocation-race guard as the share route.
  const body = await c.req.parseBody();

  const doc = findDocumentForViewer(db, slug, user.id)?.document;
  if (!doc) return c.notFound();

  setWatching(db, doc.id, user.id, body['watching'] === 'true', new Date());

  const requested = typeof body['next'] === 'string' ? body['next'] : undefined;
  return c.redirect(safeLocalPath(requested) ?? `/d/${doc.id}`, 302);
});
