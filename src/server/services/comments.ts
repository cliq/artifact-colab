/**
 * Comment creation shared by the web API (session-authed) and the MCP tools
 * (token-authed). Both paths insert the same rows, compute the same anchor
 * states, and auto-watch the author; they differ only in where the anchor
 * comes from (the browser selection vs. a quote located server-side) and in
 * whether the comment is attributed to an access token. Both also subscribe
 * every teammate the body mentions (`@email`), so the mention reaches them by
 * digest.
 */

import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { normalizeString } from '../../anchoring/normalize.js';
import { describeTextAnchor, type TextAnchor } from '../../anchoring/text.js';
import type { DB } from '../db/index.js';
import { comments, documents, type Comment, type Document, type Version } from '../db/schema.js';
import { computeForComment, computeForCommentVersion } from './anchorStates.js';
import { autoWatch, resolveMentions, watchForMention } from './watches.js';

/** The access token a comment was posted through — how the UI tells one agent from another. */
export interface CommentVia {
  tokenId: string;
  tokenLabel: string;
}

export function createThreadComment(
  db: DB,
  input: {
    document: Document;
    version: Version;
    authorId: string;
    body: string;
    quotedText: string;
    anchor: TextAnchor;
    via: CommentVia | null;
    now?: Date;
  },
): Comment {
  const id = randomBytes(8).toString('hex');
  const now = input.now ?? new Date();
  db.insert(comments)
    .values({
      id,
      documentId: input.document.id,
      parentId: null,
      authorId: input.authorId,
      body: input.body,
      quotedText: input.quotedText,
      anchor: JSON.stringify(input.anchor),
      status: 'open',
      createdVersionId: input.version.id,
      createdAt: now,
      resolvedAt: null,
      resolvedBy: null,
      viaTokenId: input.via?.tokenId ?? null,
      viaTokenLabel: input.via?.tokenLabel ?? null,
    })
    .run();

  // The state against the version it was created on, plus the state against
  // the document's current version (the two may already be the same row).
  computeForCommentVersion(db, id, input.version.id);
  computeForComment(db, id);
  autoWatch(db, input.document.id, input.authorId, now);
  watchMentioned(db, input.document.id, input.document.teamId, input.authorId, input.body, now);

  const created = db.select().from(comments).where(eq(comments.id, id)).get();
  if (!created) throw new Error(`comment ${id} vanished after insert`);
  return created;
}

export function createReply(
  db: DB,
  input: { parent: Comment; authorId: string; body: string; via: CommentVia | null; now?: Date },
): Comment {
  const id = randomBytes(8).toString('hex');
  const now = input.now ?? new Date();
  db.insert(comments)
    .values({
      id,
      documentId: input.parent.documentId,
      parentId: input.parent.id,
      authorId: input.authorId,
      body: input.body,
      // Replies don't carry their own anchor; the schema's columns are NOT NULL.
      quotedText: '',
      anchor: 'null',
      status: 'open',
      createdVersionId: input.parent.createdVersionId,
      createdAt: now,
      resolvedAt: null,
      resolvedBy: null,
      viaTokenId: input.via?.tokenId ?? null,
      viaTokenLabel: input.via?.tokenLabel ?? null,
    })
    .run();

  autoWatch(db, input.parent.documentId, input.authorId, now);
  const doc = db.select({ teamId: documents.teamId }).from(documents).where(eq(documents.id, input.parent.documentId)).get();
  if (doc) watchMentioned(db, input.parent.documentId, doc.teamId, input.authorId, input.body, now);

  const created = db.select().from(comments).where(eq(comments.id, id)).get();
  if (!created) throw new Error(`reply ${id} vanished after insert`);
  return created;
}

/** Subscribe every teammate the body mentions, except the author (already auto-watched, sticky opt-out respected). */
function watchMentioned(db: DB, documentId: string, teamId: string, authorId: string, body: string, now: Date): void {
  for (const user of resolveMentions(db, teamId, body)) {
    if (user.id !== authorId) watchForMention(db, documentId, user.id, now);
  }
}

export type QuoteLocation =
  | { ok: true; anchor: TextAnchor; quotedText: string }
  | { ok: false; reason: 'empty' | 'not_found' | 'ambiguous'; count: number };

/**
 * Build an anchor for a quote supplied as plain text (no selection offsets),
 * as an agent would. The quote is normalized the way document text is, so
 * whitespace and curly-quote differences don't matter, and must occur exactly
 * once in `text` — with several occurrences there's no way to know which one
 * the agent meant, so the caller asks for a longer quote instead of guessing.
 */
export function locateQuote(text: string, quote: string): QuoteLocation {
  const exact = normalizeString(quote);
  if (exact.length === 0) return { ok: false, reason: 'empty', count: 0 };

  let count = 0;
  let first = -1;
  for (let i = text.indexOf(exact); i !== -1 && count < 2; i = text.indexOf(exact, i + 1)) {
    if (first === -1) first = i;
    count++;
  }
  if (count === 0) return { ok: false, reason: 'not_found', count };
  if (count > 1) return { ok: false, reason: 'ambiguous', count };

  return { ok: true, anchor: describeTextAnchor(text, first, first + exact.length), quotedText: exact };
}
