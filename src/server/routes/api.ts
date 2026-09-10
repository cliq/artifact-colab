/**
 * Documents/comments REST API. Every document lookup is scoped in the query
 * itself — team membership, widened to any signed-in user for documents with
 * visibility 'public'. A document the requester can't see is indistinguishable
 * from a document that doesn't exist, so it 404s rather than 403s.
 */

import { and, asc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '../context.js';
import type { DB } from '../db/index.js';
import { comments, commentAnchorStates, commentReactions, documents, teamMembers, users, versions, type Comment, type Document, type Version } from '../db/schema.js';
import { isReactionEmoji, REACTION_EMOJIS } from '../../shared/reactions.js';
import { assetsForDocument, relinkAssets, stripBaseHref } from '../services/assets.js';
import { createReply, createThreadComment } from '../services/comments.js';
import { gravatarUrl } from '../services/gravatar.js';
import { resolveMentions } from '../services/watches.js';
import { buildZip, type ZipEntry } from '../services/zip.js';

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
 * document is public, only the creator — while still a member — when it is
 * private. A creator removed from the team loses private access like any other
 * revoked member (same convention as public docs: an ex-member creator is a
 * guest, not an owner). Non-matches stay indistinguishable from nonexistent
 * documents (404), including public documents flipped back to team-only and
 * private documents' teammates. Member-gated actions (delete, share toggle)
 * use `findDocumentForUser`.
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
          and(eq(documents.visibility, 'private'), eq(documents.createdBy, userId), isNotNull(teamMembers.userId)),
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
  /**
   * Set when the comment was posted by an agent through the MCP endpoint: the
   * access token it authenticated with (label as it read at posting time).
   * Null for comments written in the web UI.
   */
  viaToken: { id: string; label: string } | null;
}

/** The token attribution stored on a comment row, as the DTO exposes it. */
function viaTokenOf(comment: Pick<Comment, 'viaTokenId' | 'viaTokenLabel'>): AuthorDTO['viaToken'] {
  if (comment.viaTokenId === null && comment.viaTokenLabel === null) return null;
  return { id: comment.viaTokenId ?? '', label: comment.viaTokenLabel ?? '' };
}

function authorFor(db: DB, comment: Pick<Comment, 'authorId' | 'viaTokenId' | 'viaTokenLabel'>, teamId: string): AuthorDTO {
  const userId = comment.authorId;
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  const email = row?.email ?? '';
  const member = db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  return { email, name: row?.name ?? null, avatarUrl: gravatarUrl(email), isGuest: member === undefined, viaToken: viaTokenOf(comment) };
}

function parseAnchorJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** One emoji's reactions on a comment, grouped: who (display names) and whether the requesting viewer is among them. */
export interface ReactionDTO {
  emoji: string;
  count: number;
  /** Display names (profile name, else email), in reaction order. */
  users: string[];
  reactedByMe: boolean;
}

/**
 * A teammate the comment body mentions as `@email`. The client paints those
 * tokens as chips showing the display name; emails the body names that don't
 * resolve to a member are not listed and stay plain text.
 */
export interface MentionDTO {
  email: string;
  name: string | null;
}

function mentionsFor(db: DB, body: string, teamId: string): MentionDTO[] {
  return resolveMentions(db, teamId, body).map((user) => ({ email: user.email, name: user.name }));
}

interface ThreadReplyDTO {
  id: string;
  body: string;
  author: AuthorDTO;
  createdAt: Date;
  reactions: ReactionDTO[];
  mentions: MentionDTO[];
}

/**
 * Reactions for a thread and its replies in one query, grouped per comment
 * in palette order. `viewerId` marks the viewer's own reactions; omitted for
 * exports and agents.
 */
function reactionsFor(db: DB, commentIds: string[], viewerId: string | undefined): Map<string, ReactionDTO[]> {
  const grouped = new Map<string, ReactionDTO[]>();
  if (commentIds.length === 0) return grouped;
  const rows = db
    .select({
      commentId: commentReactions.commentId,
      userId: commentReactions.userId,
      emoji: commentReactions.emoji,
      name: users.name,
      email: users.email,
    })
    .from(commentReactions)
    .innerJoin(users, eq(users.id, commentReactions.userId))
    .where(inArray(commentReactions.commentId, commentIds))
    .orderBy(asc(commentReactions.createdAt))
    .all();
  for (const row of rows) {
    const list = grouped.get(row.commentId) ?? [];
    let entry = list.find((r) => r.emoji === row.emoji);
    if (!entry) {
      entry = { emoji: row.emoji, count: 0, users: [], reactedByMe: false };
      list.push(entry);
    }
    entry.count += 1;
    entry.users.push(row.name?.trim() || row.email);
    if (row.userId === viewerId) entry.reactedByMe = true;
    grouped.set(row.commentId, list);
  }
  const order = (emoji: string): number => (REACTION_EMOJIS as readonly string[]).indexOf(emoji);
  for (const list of grouped.values()) list.sort((a, b) => order(a.emoji) - order(b.emoji));
  return grouped;
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
  reactions: ReactionDTO[];
  mentions: MentionDTO[];
  replies: ThreadReplyDTO[];
}

/**
 * Build the full thread DTO for a top-level comment, including its anchor
 * state for `versionId`. `viewerId` flags the viewer's own reactions.
 */
export function buildThread(db: DB, comment: Comment, versionId: string | undefined, teamId: string, viewerId?: string): ThreadDTO {
  const anchorStateRow = versionId
    ? db
        .select()
        .from(commentAnchorStates)
        .where(and(eq(commentAnchorStates.commentId, comment.id), eq(commentAnchorStates.versionId, versionId)))
        .get()
    : undefined;

  const replyRows = db.select().from(comments).where(eq(comments.parentId, comment.id)).orderBy(asc(comments.createdAt)).all();
  const reactions = reactionsFor(db, [comment.id, ...replyRows.map((reply) => reply.id)], viewerId);

  return {
    id: comment.id,
    body: comment.body,
    quotedText: comment.quotedText,
    anchor: parseAnchorJson(comment.anchor),
    status: comment.status,
    author: authorFor(db, comment, teamId),
    createdAt: comment.createdAt,
    createdVersionId: comment.createdVersionId,
    resolvedAt: comment.resolvedAt,
    resolvedBy: emailFor(db, comment.resolvedBy),
    anchorState: anchorStateRow
      ? { state: anchorStateRow.state, start: anchorStateRow.start, end: anchorStateRow.end }
      : null,
    reactions: reactions.get(comment.id) ?? [],
    mentions: mentionsFor(db, comment.body, teamId),
    replies: replyRows.map((reply) => ({
      id: reply.id,
      body: reply.body,
      author: authorFor(db, reply, teamId),
      createdAt: reply.createdAt,
      reactions: reactions.get(reply.id) ?? [],
      mentions: mentionsFor(db, reply.body, teamId),
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
  const threads = sortTopLevel(topLevelCommentsFor(db, doc.id)).map((row) => buildThread(db, row, versionId, doc.teamId, user.id));

  return c.json({ comments: threads });
});

/**
 * Who the `@` picker offers: the document's team members other than the
 * requester. Only members get the list — a guest on a public document can
 * comment but is not shown the team roster.
 */
apiRoutes.get('/api/docs/:slug/mentionable', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const access = findDocumentForViewer(db, c.req.param('slug'), user.id);
  if (!access) return c.json({ error: 'not found' }, 404);
  if (!access.isMember) return c.json({ users: [] });

  const rows = db
    .select({ email: users.email, name: users.name })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(and(eq(teamMembers.teamId, access.document.teamId), ne(teamMembers.userId, user.id)))
    .orderBy(asc(users.email))
    .all();
  return c.json({
    users: rows.map((row) => ({ email: row.email, name: row.name, avatarUrl: gravatarUrl(row.email) })),
  });
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

  const created = createThreadComment(db, {
    document: doc,
    version,
    authorId: user.id,
    body: parsed.data.body,
    quotedText: parsed.data.quotedText,
    anchor: parsed.data.anchor,
    via: null,
  });

  return c.json(buildThread(db, created, version.id, doc.teamId, user.id), 201);
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

  const reply = createReply(db, { parent, authorId: user.id, body: parsed.data.body, via: null });

  return c.json(
    {
      id: reply.id,
      body: reply.body,
      author: authorFor(db, reply, doc.teamId),
      createdAt: reply.createdAt,
      mentions: mentionsFor(db, reply.body, doc.teamId),
    },
    201,
  );
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

  return c.json(buildThread(db, updated, found.document.currentVersionId ?? undefined, found.document.teamId, user.id));
});

apiRoutes.post('/api/comments/:id/reopen', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const found = findOwnedTopLevelComment(db, c.req.param('id'), { userId: user.id });
  if (!found) return c.json({ error: 'not found' }, 404);

  db.update(comments).set({ status: 'open', resolvedAt: null, resolvedBy: null }).where(eq(comments.id, found.comment.id)).run();

  const updated = db.select().from(comments).where(eq(comments.id, found.comment.id)).get();
  if (!updated) return c.json({ error: 'internal error' }, 500);

  return c.json(buildThread(db, updated, found.document.currentVersionId ?? undefined, found.document.teamId, user.id));
});

/**
 * Reaction toggles. PUT adds the viewer's reaction (idempotent), DELETE removes
 * it. The target may be a top-level comment or a reply; the response is the
 * refreshed thread either way, so the sidebar can swap it in.
 */
function reactionTarget(
  db: DB,
  commentId: string,
  emoji: string,
  userId: string,
): { comment: Comment; topLevel: Comment; document: Document } | { error: string; status: 400 | 404 } {
  if (!isReactionEmoji(emoji)) return { error: `unsupported reaction; use one of ${REACTION_EMOJIS.join(' ')}`, status: 400 };
  const comment = db.select().from(comments).where(eq(comments.id, commentId)).get();
  if (!comment) return { error: 'not found', status: 404 };
  const document = findDocumentForViewer(db, comment.documentId, userId)?.document;
  if (!document) return { error: 'not found', status: 404 };
  const topLevel = comment.parentId ? db.select().from(comments).where(eq(comments.id, comment.parentId)).get() : comment;
  if (!topLevel) return { error: 'not found', status: 404 };
  return { comment, topLevel, document };
}

apiRoutes.put('/api/comments/:id/reactions/:emoji', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const target = reactionTarget(db, c.req.param('id'), c.req.param('emoji'), user.id);
  if ('error' in target) return c.json({ error: target.error }, target.status);

  db.insert(commentReactions)
    .values({ commentId: target.comment.id, userId: user.id, emoji: c.req.param('emoji'), createdAt: new Date() })
    .onConflictDoNothing()
    .run();
  return c.json(buildThread(db, target.topLevel, target.document.currentVersionId ?? undefined, target.document.teamId, user.id));
});

apiRoutes.delete('/api/comments/:id/reactions/:emoji', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const target = reactionTarget(db, c.req.param('id'), c.req.param('emoji'), user.id);
  if ('error' in target) return c.json({ error: target.error }, target.status);

  db.delete(commentReactions)
    .where(
      and(
        eq(commentReactions.commentId, target.comment.id),
        eq(commentReactions.userId, user.id),
        eq(commentReactions.emoji, c.req.param('emoji')),
      ),
    )
    .run();
  return c.json(buildThread(db, target.topLevel, target.document.currentVersionId ?? undefined, target.document.teamId, user.id));
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

/** The Markdown rendering of a document's comment threads, shared by export.md and the zip export. */
function commentsMarkdown(db: DB, baseUrl: string, doc: Document): string {
  const versionId = doc.currentVersionId ?? undefined;
  const threads = sortTopLevel(topLevelCommentsFor(db, doc.id)).map((row) => buildThread(db, row, versionId, doc.teamId));
  const open = threads.filter((thread) => thread.status !== 'resolved');
  const resolved = threads.filter((thread) => thread.status === 'resolved');

  const ctx = exportContext(db, baseUrl, doc);
  const lines: string[] = [
    `# Comments on ${doc.title}`,
    '',
    `Artifact: ${ctx.versionUrl ?? ctx.url}${ctx.versionNumber !== null ? ` (version ${ctx.versionNumber})` : ''}`,
    `Anchor states (anchored/ambiguous/orphaned) refer to that version.`,
    '',
  ];
  const reactionNote = (reactions: ReactionDTO[]): string =>
    reactions.length === 0 ? '' : ` [${reactions.map((r) => `${r.emoji} ${r.count}`).join(' · ')}]`;
  const authorName = (author: AuthorDTO): string => (author.viaToken ? `${author.email} (via ${author.viaToken.label})` : author.email);
  const renderSection = (title: string, items: ThreadDTO[]): void => {
    lines.push(`## ${title}`, '');
    for (const thread of items) {
      const state = thread.anchorState?.state ?? 'orphaned';
      lines.push(`- **${authorName(thread.author)}** on "${thread.quotedText}" (${state}): ${thread.body}${reactionNote(thread.reactions)}`);
      for (const reply of thread.replies) {
        lines.push(`  - **${authorName(reply.author)}**: ${reply.body}${reactionNote(reply.reactions)}`);
      }
    }
    lines.push('');
  };
  renderSection('Open', open);
  renderSection('Resolved', resolved);
  return lines.join('\n');
}

apiRoutes.get('/api/docs/:slug/export.md', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const config = c.get('config');
  const doc = findDocumentForViewer(db, c.req.param('slug'), user.id)?.document;
  if (!doc) return c.json({ error: 'not found' }, 404);
  return c.text(commentsMarkdown(db, config.baseUrl, doc), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

/** File-name-safe slug of a title; falls back to the document id when nothing survives. */
export function titleSlug(title: string, fallback: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

/**
 * Whole-artifact download: the current version as `index.html` (plus
 * `source.md` when it was published as Markdown), uploaded assets under
 * `assets/`, and the comment threads as `comments.md`.
 */
apiRoutes.get('/api/docs/:slug/export.zip', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const config = c.get('config');
  const doc = findDocumentForViewer(db, c.req.param('slug'), user.id)?.document;
  if (!doc) return c.json({ error: 'not found' }, 404);
  const version = doc.currentVersionId ? db.select().from(versions).where(eq(versions.id, doc.currentVersionId)).get() : undefined;
  if (!version) return c.json({ error: 'not found' }, 404);

  const docAssets = assetsForDocument(db, doc.id);
  const entries: ZipEntry[] = [{ name: 'index.html', data: relinkAssets(stripBaseHref(version.html), docAssets) }];
  if (version.sourceMarkdown !== null) entries.push({ name: 'source.md', data: relinkAssets(version.sourceMarkdown, docAssets) });
  for (const asset of docAssets) entries.push({ name: `assets/${asset.name}`, data: asset.data });
  entries.push({ name: 'comments.md', data: commentsMarkdown(db, config.baseUrl, doc) });

  const filename = `${titleSlug(doc.title, doc.id)}.zip`;
  return c.body(new Uint8Array(buildZip(entries)), 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
});
