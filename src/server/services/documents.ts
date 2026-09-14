/**
 * Document lifecycle beyond publishing (which lives in publish.ts): deletion
 * and visibility. Shared by the delete_artifact MCP tool, the author/team-admin
 * "Delete artifact" flow, and the instance-admin team cascade in `teams.ts`, so
 * the list of document-scoped children lives in one place.
 */

import { eq, inArray } from 'drizzle-orm';

import { pruneDocumentWatches } from './access.js';
import type { DB, DBOrTx } from '../db/index.js';
import { documentCollaborators, documentInvitations, assets, commentAnchorStates, commentReactions, comments, documents, versions, watches, type Document } from '../db/schema.js';

export type DocumentVisibility = 'team' | 'public' | 'private';

export function isDocumentVisibility(value: unknown): value is DocumentVisibility {
  return value === 'team' || value === 'public' || value === 'private';
}

/** Visibility and subscription pruning commit together under the effective access policy. */
export function setDocumentVisibility(db: DBOrTx, document: Document, visibility: DocumentVisibility): void {
  db.transaction((tx) => {
    tx.update(documents).set({ visibility }).where(eq(documents.id, document.id)).run();
    pruneDocumentWatches(tx, document.id);
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
    tx.delete(commentReactions).where(inArray(commentReactions.commentId, commentIds)).run();
  }
  tx.delete(comments).where(inArray(comments.documentId, docIds)).run();
  tx.delete(watches).where(inArray(watches.documentId, docIds)).run();
  tx.delete(documentInvitations).where(inArray(documentInvitations.documentId, docIds)).run();
  tx.delete(documentCollaborators).where(inArray(documentCollaborators.documentId, docIds)).run();
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
