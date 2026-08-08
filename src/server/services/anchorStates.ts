/**
 * Anchor-state computation: relocates each top-level comment's text-quote
 * anchor against a document version's normalized text and persists the
 * result, so the API can report "anchored"/"ambiguous"/"orphaned" without
 * re-running the anchoring engine on every request. Replies never carry an
 * anchor of their own — only top-level comments are (re)computed here.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { parseHTML } from 'linkedom';

import { buildTextIndex } from '../../anchoring/index.js';
import { locateTextAnchor, type TextAnchor } from '../../anchoring/text.js';
import type { DB } from '../db/index.js';
import { comments, commentAnchorStates, documents, versions } from '../db/schema.js';

export type AnchorStateValue = 'anchored' | 'ambiguous' | 'orphaned';

export interface ComputedAnchorState {
  state: AnchorStateValue;
  start: number | null;
  end: number | null;
}

/** Relocate `anchor` in `text` and classify the result. */
export function computeAnchorState(text: string, anchor: TextAnchor): ComputedAnchorState {
  const located = locateTextAnchor(text, anchor);
  if (!located) {
    return { state: 'orphaned', start: null, end: null };
  }
  if (located.ambiguous) {
    return { state: 'ambiguous', start: located.start, end: located.end };
  }
  return { state: 'anchored', start: located.start, end: located.end };
}

/** Parse a version's stored HTML and return its normalized document text. */
export function indexVersionHtml(html: string): string {
  const { document } = parseHTML(html);
  return buildTextIndex(document as unknown as Node).text;
}

/** Attempt to parse a comment's stored anchor JSON; tolerate malformed data. */
function parseAnchor(raw: string): TextAnchor | null {
  try {
    return JSON.parse(raw) as TextAnchor;
  } catch {
    return null;
  }
}

function upsertAnchorState(db: DB, commentId: string, versionId: string, computed: ComputedAnchorState): void {
  db.delete(commentAnchorStates)
    .where(and(eq(commentAnchorStates.commentId, commentId), eq(commentAnchorStates.versionId, versionId)))
    .run();
  db.insert(commentAnchorStates)
    .values({ commentId, versionId, state: computed.state, start: computed.start, end: computed.end })
    .run();
}

/**
 * Recompute and persist the anchor state of every top-level comment on
 * `documentId` against `versionId`'s html. Called once per newly published
 * version, so the version's text is built exactly once and reused for every
 * comment.
 */
export function recomputeForVersion(db: DB, documentId: string, versionId: string): { orphaned: number; total: number } {
  const version = db.select().from(versions).where(eq(versions.id, versionId)).get();
  if (!version) {
    throw new Error(`version not found: ${versionId}`);
  }
  const text = indexVersionHtml(version.html);

  const topLevelComments = db
    .select()
    .from(comments)
    .where(and(eq(comments.documentId, documentId), isNull(comments.parentId)))
    .all();

  let orphaned = 0;
  for (const comment of topLevelComments) {
    const anchor = parseAnchor(comment.anchor);
    const computed = anchor ? computeAnchorState(text, anchor) : { state: 'orphaned' as const, start: null, end: null };
    if (computed.state === 'orphaned') orphaned++;
    upsertAnchorState(db, comment.id, versionId, computed);
  }

  return { orphaned, total: topLevelComments.length };
}

/**
 * Recompute and persist the anchor state of a single comment against a
 * single, already-loaded version. Shared by `computeForComment` (against the
 * document's current version) and callers that also need the state against
 * the version the comment was created on.
 */
export function computeForCommentVersion(db: DB, commentId: string, versionId: string): void {
  const comment = db.select().from(comments).where(eq(comments.id, commentId)).get();
  if (!comment) {
    throw new Error(`comment not found: ${commentId}`);
  }
  const version = db.select().from(versions).where(eq(versions.id, versionId)).get();
  if (!version) {
    throw new Error(`version not found: ${versionId}`);
  }

  const text = indexVersionHtml(version.html);
  const anchor = parseAnchor(comment.anchor);
  const computed = anchor ? computeAnchorState(text, anchor) : { state: 'orphaned' as const, start: null, end: null };
  upsertAnchorState(db, comment.id, versionId, computed);
}

/**
 * Recompute and persist the anchor state of a single comment against its
 * document's current version. Called right after a comment is created, so
 * its (comment, currentVersion) state is ready before the next GET.
 */
export function computeForComment(db: DB, commentId: string): void {
  const comment = db.select().from(comments).where(eq(comments.id, commentId)).get();
  if (!comment) {
    throw new Error(`comment not found: ${commentId}`);
  }
  const document = db.select().from(documents).where(eq(documents.id, comment.documentId)).get();
  if (!document?.currentVersionId) {
    return;
  }

  computeForCommentVersion(db, commentId, document.currentVersionId);
}
