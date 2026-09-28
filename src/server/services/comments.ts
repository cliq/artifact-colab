/**
 * Comment creation shared by the web API (session-authed) and the MCP tools
 * (token-authed). Both paths insert the same rows, compute the same anchor
 * states, and auto-watch the author; they differ only in where the anchor
 * comes from (the browser selection vs. a quote located server-side) and in
 * whether the comment is attributed to an access token. Both also subscribe
 * every person the author is authorized to mention (`@email`), so the mention
 * reaches them by digest. Authors can later edit the body of their own
 * comments and replies (images attached at creation stay as they are), and
 * delete them.
 */

import { randomBytes } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';

import { normalizeString } from '../../anchoring/normalize.js';
import { describeTextAnchor, type TextAnchor } from '../../anchoring/text.js';
import type { DB, DBOrTx } from '../db/index.js';
import { commentAnchorStates, commentImages, commentReactions, comments, documents, type Comment, type Document, type Version } from '../db/schema.js';
import { computeForComment, computeForCommentVersion } from './anchorStates.js';
import { insertCommentImages, type ValidImage } from './commentImages.js';
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
    /** Already validated (see `validateCommentImages`). */
    images?: ValidImage[];
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

  insertCommentImages(db, id, input.images ?? [], now);

  // The state against the version it was created on, plus the state against
  // the document's current version (the two may already be the same row).
  computeForCommentVersion(db, id, input.version.id);
  computeForComment(db, id);
  autoWatch(db, input.document.id, input.authorId, now);
  watchMentioned(db, input.document, input.authorId, input.body, now);

  const created = db.select().from(comments).where(eq(comments.id, id)).get();
  if (!created) throw new Error(`comment ${id} vanished after insert`);
  return created;
}

export function createReply(
  db: DB,
  input: { parent: Comment; authorId: string; body: string; via: CommentVia | null; images?: ValidImage[]; now?: Date },
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
  insertCommentImages(db, id, input.images ?? [], now);

  autoWatch(db, input.parent.documentId, input.authorId, now);
  const doc = db.select().from(documents).where(eq(documents.id, input.parent.documentId)).get();
  if (doc) watchMentioned(db, doc, input.authorId, input.body, now);

  const created = db.select().from(comments).where(eq(comments.id, id)).get();
  if (!created) throw new Error(`reply ${id} vanished after insert`);
  return created;
}

/**
 * Replace a comment's or reply's body, as its author. Anchor, status and
 * attribution stay put; only people newly mentioned by the edit get
 * subscribed (the watch is idempotent for everyone already mentioned).
 */
export function editComment(db: DB, input: { comment: Comment; document: Document; body: string; now?: Date }): Comment {
  const now = input.now ?? new Date();
  db.update(comments).set({ body: input.body, editedAt: now }).where(eq(comments.id, input.comment.id)).run();
  watchMentioned(db, input.document, input.comment.authorId, input.body, now);

  const updated = db.select().from(comments).where(eq(comments.id, input.comment.id)).get();
  if (!updated) throw new Error(`comment ${input.comment.id} vanished after edit`);
  return updated;
}

/** What `deleteComment` did: removed the comment (and possibly its emptied thread), or kept a thread as a "deleted" placeholder. */
export type DeleteOutcome = { kind: 'removed'; threadId: string | null } | { kind: 'placeholder'; threadId: string };

/**
 * Delete a comment or reply, as its author. A top-level comment that still
 * has replies becomes a placeholder — body, images and reactions go, the
 * anchor and replies stay — so nobody else's words disappear with it. Anything
 * else is removed outright, and removing the last reply under a placeholder
 * removes the thread too. `threadId` is the thread still standing, if any.
 */
export function deleteComment(db: DB, comment: Comment, now: Date = new Date()): DeleteOutcome {
  return db.transaction((tx) => {
    if (comment.parentId === null) {
      const hasReplies = tx.select({ id: comments.id }).from(comments).where(eq(comments.parentId, comment.id)).get() !== undefined;
      if (!hasReplies) {
        removeComments(tx, [comment.id]);
        return { kind: 'removed', threadId: null };
      }
      tx.delete(commentImages).where(eq(commentImages.commentId, comment.id)).run();
      tx.delete(commentReactions).where(eq(commentReactions.commentId, comment.id)).run();
      tx.update(comments).set({ body: '', deletedAt: now }).where(eq(comments.id, comment.id)).run();
      return { kind: 'placeholder', threadId: comment.id };
    }

    removeComments(tx, [comment.id]);
    const parent = tx.select().from(comments).where(eq(comments.id, comment.parentId)).get();
    if (!parent) return { kind: 'removed', threadId: null };
    const orphanedPlaceholder =
      parent.deletedAt !== null && tx.select({ id: comments.id }).from(comments).where(eq(comments.parentId, parent.id)).get() === undefined;
    if (orphanedPlaceholder) {
      removeComments(tx, [parent.id]);
      return { kind: 'removed', threadId: null };
    }
    return { kind: 'removed', threadId: parent.id };
  });
}

/** Comment rows and everything hanging off them. */
function removeComments(tx: DBOrTx, ids: string[]): void {
  tx.delete(commentAnchorStates).where(inArray(commentAnchorStates.commentId, ids)).run();
  tx.delete(commentReactions).where(inArray(commentReactions.commentId, ids)).run();
  tx.delete(commentImages).where(inArray(commentImages.commentId, ids)).run();
  tx.delete(comments).where(inArray(comments.id, ids)).run();
}

/**
 * Subscribe every authorized person the body mentions, except the author
 * (already auto-watched, sticky opt-out respected). `resolveMentions` enforces
 * both the author's scoped directory and the recipient's current read access.
 */
function watchMentioned(db: DB, document: Document, authorId: string, body: string, now: Date): void {
  for (const user of resolveMentions(db, document, authorId, body)) {
    if (user.id !== authorId) watchForMention(db, document.id, user.id, now);
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
