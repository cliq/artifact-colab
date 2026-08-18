/**
 * Documents/comments REST API. Every document lookup is scoped in the query
 * itself — team membership, widened to any signed-in user for documents with
 * visibility 'public'. A document the requester can't see is indistinguishable
 * from a document that doesn't exist, so it 404s rather than 403s.
 */

import { randomBytes } from 'node:crypto';

import { and, asc, eq, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '../context.js';
import type { DB } from '../db/index.js';
import { comments, commentAnchorStates, documents, teamMembers, users, versions, type Comment, type Document, type Version } from '../db/schema.js';
import { computeForComment, computeForCommentVersion } from '../services/anchorStates.js';
import { gravatarUrl } from '../services/gravatar.js';
import { autoWatch } from '../services/watches.js';

const anchorSchema = z.object({
  v: z.literal(1),
  exact: z.string(),
  prefix: z.string(),
  suffix: z.string(),
  start: z.number().int().nonnegative(),
  docLength: z.number().int().nonnegative(),
});

const createCommentSchema = z.object({
  body: z.string().min(1).max(10000),
  quotedText: z.string().max(10000),
  anchor: anchorSchema,
  versionId: z.string().min(1),
});

const replySchema = z.object({ body: z.string().min(1).max(10000) });

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/**
 * The document, if the user is a member of its team; membership is part of the
 * query so outsiders see a 404. Private documents match only for their creator
 * — a teammate can't act on (or even confirm the existence of) someone else's
 * private document.
 */
export function findDocumentForUser(db: DB, slug: string, userId: string): Document | undefined {
  const row = db
    .select({ document: documents })
    .from(documents)
    .innerJoin(teamMembers, and(eq(teamMembers.teamId, documents.teamId), eq(teamMembers.userId, userId)))
    .where(and(eq(documents.id, slug), or(ne(documents.visibility, 'private'), eq(documents.createdBy, userId))))
    .get();
  return row?.document;
}

export interface ViewerDocument {
  document: Document;
  /** False for a signed-in user reaching a public document from outside its team. */
  isMember: boolean;
}

/**
 * Read/interact access: team members always, any signed-in user when the
 * document is public, only the creator when it is private. Non-matches stay
 * indistinguishable from nonexistent documents (404), including public
 * documents flipped back to team-only and private documents' teammates.
 * Member-gated actions (delete, share toggle) use `findDocumentForUser`.
 */
export function findDocumentForViewer(db: DB, slug: string, userId: string): ViewerDocument | undefined {
  const row = db
    .select({ document: documents, memberId: teamMembers.userId })
    .from(documents)
    .leftJoin(teamMembers, and(eq(teamMembers.teamId, documents.teamId), eq(teamMembers.userId, userId)))
    .where(
      and(
        eq(documents.id, slug),
        or(
          and(eq(documents.visibility, 'private'), eq(documents.createdBy, userId)),
          and(ne(documents.visibility, 'private'), or(isNotNull(teamMembers.userId), eq(documents.visibility, 'public'))),
        ),
      ),
    )
    .get();
  return row ? { document: row.document, isMember: row.memberId !== null } : undefined;
}

/**
 * The document, if it belongs to the given team — the scope check for
 * bearer-token (team-scoped) access. `userId` is the token's user: private
 * documents match only for their creator, so a teammate's token can't read or
 * republish them.
 */
export function findDocumentInTeam(db: DB, slug: string, teamId: string, userId: string): Document | undefined {
  return db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, slug),
        eq(documents.teamId, teamId),
        or(ne(documents.visibility, 'private'), eq(documents.createdBy, userId)),
      ),
    )
    .get();
}

/** A document's version by number, or its current version when no number is given. */
export function findVersion(db: DB, doc: Document, number?: number): Version | undefined {
  if (number !== undefined) {
    return db.select().from(versions).where(and(eq(versions.documentId, doc.id), eq(versions.number, number))).get();
  }
  if (!doc.currentVersionId) return undefined;
  return db.select().from(versions).where(eq(versions.id, doc.currentVersionId)).get();
}

function emailFor(db: DB, userId: string | null): string | null {
  if (!userId) return null;
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  return row?.email ?? null;
}

export interface AuthorDTO {
  email: string;
  /** Profile display name; null until the user sets one — clients fall back to the email. */
  name: string | null;
  avatarUrl: string;
  /** True when the author is not (or no longer) a member of the document's team — a public-doc guest. */
  isGuest: boolean;
}

function authorFor(db: DB, userId: string, teamId: string): AuthorDTO {
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  const email = row?.email ?? '';
  const member = db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  return { email, name: row?.name ?? null, avatarUrl: gravatarUrl(email), isGuest: member === undefined };
}

function parseAnchorJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface ThreadReplyDTO {
  id: string;
  body: string;
  author: AuthorDTO;
  createdAt: Date;
}

interface AnchorStateDTO {
  state: string;
  start: number | null;
  end: number | null;
}

export interface ThreadDTO {
  id: string;
  body: string;
  quotedText: string;
  anchor: unknown;
  status: string;
  author: AuthorDTO;
  createdAt: Date;
  createdVersionId: string;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  anchorState: AnchorStateDTO | null;
  replies: ThreadReplyDTO[];
}

/** Build the full thread DTO for a top-level comment, including its anchor state for `versionId`. */
export function buildThread(db: DB, comment: Comment, versionId: string | undefined, teamId: string): ThreadDTO {
  const anchorStateRow = versionId
    ? db
        .select()
        .from(commentAnchorStates)
        .where(and(eq(commentAnchorStates.commentId, comment.id), eq(commentAnchorStates.versionId, versionId)))
        .get()
    : undefined;

  const replyRows = db.select().from(comments).where(eq(comments.parentId, comment.id)).orderBy(asc(comments.createdAt)).all();

  return {
    id: comment.id,
    body: comment.body,
    quotedText: comment.quotedText,
    anchor: parseAnchorJson(comment.anchor),
    status: comment.status,
    author: authorFor(db, comment.authorId, teamId),
    createdAt: comment.createdAt,
    createdVersionId: comment.createdVersionId,
    resolvedAt: comment.resolvedAt,
    resolvedBy: emailFor(db, comment.resolvedBy),
    anchorState: anchorStateRow
      ? { state: anchorStateRow.state, start: anchorStateRow.start, end: anchorStateRow.end }
      : null,
    replies: replyRows.map((reply) => ({
      id: reply.id,
      body: reply.body,
      author: authorFor(db, reply.authorId, teamId),
      createdAt: reply.createdAt,
    })),
  };
}

/** Open threads first, then resolved; each group keeps its `createdAt` ascending order. */
export function sortTopLevel(rows: Comment[]): Comment[] {
  return [...rows.filter((row) => row.status !== 'resolved'), ...rows.filter((row) => row.status === 'resolved')];
}

export function topLevelCommentsFor(db: DB, documentId: string): Comment[] {
  return db
    .select()
    .from(comments)
    .where(and(eq(comments.documentId, documentId), isNull(comments.parentId)))
    .orderBy(asc(comments.createdAt))
    .all();
}

/** A top-level comment on a document the user can access (viewer access — public docs included), or undefined. */
export function findOwnedTopLevelComment(
  db: DB,
  commentId: string,
  access: { userId: string } | { teamId: string; userId: string },
): { comment: Comment; document: Document } | undefined {
  const comment = db.select().from(comments).where(eq(comments.id, commentId)).get();
  if (!comment || comment.parentId !== null) return undefined;

  const document =
    'teamId' in access
      ? findDocumentInTeam(db, comment.documentId, access.teamId, access.userId)
      : findDocumentForViewer(db, comment.documentId, access.userId)?.document;
  if (!document) return undefined;

  return { comment, document };
}

export const apiRoutes = new Hono<AppEnv>();

apiRoutes.get('/api/docs/:slug', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const doc = findDocumentForViewer(db, c.req.param('slug'), user.id)?.document;
  if (!doc) return c.json({ error: 'not found' }, 404);

  const versionRows = db.select().from(versions).where(eq(versions.documentId, doc.id)).orderBy(asc(versions.number)).all();

  return c.json({
    document: {
      id: doc.id,
      title: doc.title,
      teamId: doc.teamId,
      visibility: doc.visibility,
      createdAt: doc.createdAt,
      currentVersionId: doc.currentVersionId,
    },
    versions: versionRows.map((version) => ({ id: version.id, number: version.number, publishedAt: version.publishedAt })),
  });
});

apiRoutes.get('/api/docs/:slug/comments', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const doc = findDocumentForViewer(db, c.req.param('slug'), user.id)?.document;
  if (!doc) return c.json({ error: 'not found' }, 404);

  const versionId = c.req.query('version') ?? doc.currentVersionId ?? undefined;
  const threads = sortTopLevel(topLevelCommentsFor(db, doc.id)).map((row) => buildThread(db, row, versionId, doc.teamId));

  return c.json({ comments: threads });
});

apiRoutes.post('/api/docs/:slug/comments', async (c) => {
  const db = c.get('db');
  const user = c.get('user');

  // Body first, access second: the DB is synchronous, so checking after the
  // last await keeps check-and-act atomic — a revoke landing while the body
  // streams in can't resurrect access (or the outsider's watch via autoWatch).
  const parsed = createCommentSchema.safeParse(await readJson(c));

  const doc = findDocumentForViewer(db, c.req.param('slug'), user.id)?.document;
  if (!doc) return c.json({ error: 'not found' }, 404);
  if (!parsed.success) return c.json({ error: 'invalid comment' }, 400);

  const version = db
    .select()
    .from(versions)
    .where(and(eq(versions.id, parsed.data.versionId), eq(versions.documentId, doc.id)))
    .get();
  if (!version) return c.json({ error: 'invalid version' }, 400);

  if (parsed.data.quotedText.trim().length === 0) {
    return c.json({ error: 'quotedText is required' }, 400);
  }

  const id = randomBytes(8).toString('hex');
  const now = new Date();
  db.insert(comments)
    .values({
      id,
      documentId: doc.id,
      parentId: null,
      authorId: user.id,
      body: parsed.data.body,
      quotedText: parsed.data.quotedText,
      anchor: JSON.stringify(parsed.data.anchor),
      status: 'open',
      createdVersionId: version.id,
      createdAt: now,
      resolvedAt: null,
      resolvedBy: null,
    })
    .run();

  // The state against the version it was created on, plus the state against
  // the document's current version (the two may already be the same row).
  computeForCommentVersion(db, id, version.id);
  computeForComment(db, id);
  autoWatch(db, doc.id, user.id, now);

  const created = db.select().from(comments).where(eq(comments.id, id)).get();
  if (!created) return c.json({ error: 'internal error' }, 500);

  return c.json(buildThread(db, created, version.id, doc.teamId), 201);
});

apiRoutes.post('/api/comments/:id/replies', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const parentId = c.req.param('id');

  // Body first, access second — same revocation-race guard as comment create.
  const parsed = replySchema.safeParse(await readJson(c));

  const parent = db.select().from(comments).where(eq(comments.id, parentId)).get();
  if (!parent || parent.parentId !== null) return c.json({ error: 'not found' }, 404);

  const doc = findDocumentForViewer(db, parent.documentId, user.id)?.document;
  if (!doc) return c.json({ error: 'not found' }, 404);

  if (!parsed.success) return c.json({ error: 'invalid reply' }, 400);

  const id = randomBytes(8).toString('hex');
  const now = new Date();
  db.insert(comments)
    .values({
      id,
      documentId: parent.documentId,
      parentId: parent.id,
      authorId: user.id,
      body: parsed.data.body,
      // Replies don't carry their own anchor; the schema's columns are NOT NULL.
      quotedText: '',
      anchor: 'null',
      status: 'open',
      createdVersionId: parent.createdVersionId,
      createdAt: now,
      resolvedAt: null,
      resolvedBy: null,
    })
    .run();

  autoWatch(db, parent.documentId, user.id, now);

  return c.json({ id, body: parsed.data.body, author: authorFor(db, user.id, doc.teamId), createdAt: now }, 201);
});

apiRoutes.post('/api/comments/:id/resolve', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const found = findOwnedTopLevelComment(db, c.req.param('id'), { userId: user.id });
  if (!found) return c.json({ error: 'not found' }, 404);

  const now = new Date();
  db.update(comments)
    .set({ status: 'resolved', resolvedAt: now, resolvedBy: user.id })
    .where(eq(comments.id, found.comment.id))
    .run();

  const updated = db.select().from(comments).where(eq(comments.id, found.comment.id)).get();
  if (!updated) return c.json({ error: 'internal error' }, 500);

  return c.json(buildThread(db, updated, found.document.currentVersionId ?? undefined, found.document.teamId));
});

apiRoutes.post('/api/comments/:id/reopen', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const found = findOwnedTopLevelComment(db, c.req.param('id'), { userId: user.id });
  if (!found) return c.json({ error: 'not found' }, 404);

  db.update(comments).set({ status: 'open', resolvedAt: null, resolvedBy: null }).where(eq(comments.id, found.comment.id)).run();

  const updated = db.select().from(comments).where(eq(comments.id, found.comment.id)).get();
  if (!updated) return c.json({ error: 'internal error' }, 500);

  return c.json(buildThread(db, updated, found.document.currentVersionId ?? undefined, found.document.teamId));
});

/**
 * Links + version info for exports, so an agent reading the export can open
 * the exact version the comments refer to (the pinned URL keeps pointing at
 * it even after a republish).
 */
export function exportContext(db: DB, baseUrl: string, doc: Document): {
  url: string;
  versionNumber: number | null;
  versionUrl: string | null;
} {
  const url = `${baseUrl}/d/${doc.id}`;
  const current = doc.currentVersionId
    ? db.select({ number: versions.number }).from(versions).where(eq(versions.id, doc.currentVersionId)).get()
    : undefined;
  return {
    url,
    versionNumber: current?.number ?? null,
    versionUrl: current ? `${url}?version=${current.number}` : null,
  };
}

apiRoutes.get('/api/docs/:slug/export.json', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const config = c.get('config');
  const doc = findDocumentForViewer(db, c.req.param('slug'), user.id)?.document;
  if (!doc) return c.json({ error: 'not found' }, 404);

  const versionId = doc.currentVersionId ?? undefined;
  const threads = sortTopLevel(topLevelCommentsFor(db, doc.id)).map((row) => buildThread(db, row, versionId, doc.teamId));
  const ctx = exportContext(db, config.baseUrl, doc);

  return c.json({
    document: {
      id: doc.id,
      title: doc.title,
      url: ctx.url,
      version: ctx.versionNumber,
      versionUrl: ctx.versionUrl,
    },
    exportedAt: new Date(),
    comments: threads,
  });
});

apiRoutes.get('/api/docs/:slug/export.md', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const config = c.get('config');
  const doc = findDocumentForViewer(db, c.req.param('slug'), user.id)?.document;
  if (!doc) return c.json({ error: 'not found' }, 404);

  const versionId = doc.currentVersionId ?? undefined;
  const threads = sortTopLevel(topLevelCommentsFor(db, doc.id)).map((row) => buildThread(db, row, versionId, doc.teamId));
  const open = threads.filter((thread) => thread.status !== 'resolved');
  const resolved = threads.filter((thread) => thread.status === 'resolved');

  const ctx = exportContext(db, config.baseUrl, doc);
  const lines: string[] = [
    `# Comments on ${doc.title}`,
    '',
    `Artifact: ${ctx.versionUrl ?? ctx.url}${ctx.versionNumber !== null ? ` (version ${ctx.versionNumber})` : ''}`,
    `Anchor states (anchored/ambiguous/orphaned) refer to that version.`,
    '',
  ];
  const renderSection = (title: string, items: ThreadDTO[]): void => {
    lines.push(`## ${title}`, '');
    for (const thread of items) {
      const state = thread.anchorState?.state ?? 'orphaned';
      lines.push(`- **${thread.author.email}** on "${thread.quotedText}" (${state}): ${thread.body}`);
      for (const reply of thread.replies) {
        lines.push(`  - **${reply.author.email}**: ${reply.body}`);
      }
    }
    lines.push('');
  };
  renderSection('Open', open);
  renderSection('Resolved', resolved);

  return c.text(lines.join('\n'), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});
