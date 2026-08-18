/**
 * Document lifecycle beyond publishing (which lives in publish.ts): deletion
 * and visibility. Shared by the delete_artifact MCP tool, the author/team-admin
 * "Delete artifact" flow, and the instance-admin team cascade in `teams.ts`, so
 * the list of document-scoped children lives in one place.
 */

import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';

import type { DB, DBOrTx } from '../db/index.js';
import { assets, commentAnchorStates, comments, documents, teamMembers, versions, watches, type Document } from '../db/schema.js';

export type DocumentVisibility = 'team' | 'public' | 'private';

export function isDocumentVisibility(value: unknown): value is DocumentVisibility {
  return value === 'team' || value === 'public' || value === 'private';
}

/**
 * The one flip path for a document's visibility (Share menu, publish with an
 * explicit visibility). Narrowing deletes the watch rows of everyone who loses
 * access in the same transaction — the digest sweep emails every 'watching' row
 * without re-checking access, so a stale watch would keep mailing someone
 * comments on a document they can no longer open (same invariant as
 * `removeMember`). Pruning also drops the document from those users'
 * "Shared with you" list. 'team' prunes non-members; 'private' prunes everyone
 * but the creator.
 */
export function setDocumentVisibility(db: DB, document: Document, visibility: DocumentVisibility): void {
  db.transaction((tx) => {
    tx.update(documents).set({ visibility }).where(eq(documents.id, document.id)).run();
    if (visibility === 'team') {
      const memberIds = tx
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, document.teamId))
        .all()
        .map((m) => m.userId);
      tx.delete(watches)
        .where(and(eq(watches.documentId, document.id), notInArray(watches.userId, memberIds)))
        .run();
    } else if (visibility === 'private') {
      tx.delete(watches)
        .where(and(eq(watches.documentId, document.id), ne(watches.userId, document.createdBy)))
        .run();
    }
  });
}

/**
 * Deletes documents and everything scoped to them: versions, assets, comments
 * (with their anchor states), and watches. `watches` has no ON DELETE CASCADE,
 * so everything is deleted explicitly, children first. Runs inside the
 * caller's transaction.
 */
export function deleteDocumentsWithin(tx: DBOrTx, docIds: string[]): void {
  if (docIds.length === 0) return;

  const commentIds = tx
    .select({ id: comments.id })
    .from(comments)
    .where(inArray(comments.documentId, docIds))
    .all()
    .map((c) => c.id);
  if (commentIds.length > 0) {
    tx.delete(commentAnchorStates).where(inArray(commentAnchorStates.commentId, commentIds)).run();
  }
  tx.delete(comments).where(inArray(comments.documentId, docIds)).run();
  tx.delete(watches).where(inArray(watches.documentId, docIds)).run();
  tx.delete(assets).where(inArray(assets.documentId, docIds)).run();
  // versions are referenced by documents.current_version_id only informally
  // (no FK, see schema) — clear the pointer before dropping them anyway.
  tx.update(documents).set({ currentVersionId: null }).where(inArray(documents.id, docIds)).run();
  tx.delete(versions).where(inArray(versions.documentId, docIds)).run();
  tx.delete(documents).where(inArray(documents.id, docIds)).run();
}

/** One transaction: a single document and all its children. */
export function deleteDocumentCascade(db: DB, documentId: string): void {
  db.transaction((tx) => deleteDocumentsWithin(tx, [documentId]));
}
