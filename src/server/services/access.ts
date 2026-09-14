/** One policy for session access, scoped discovery, and team-scoped credentials. */
import { and, eq, sql } from 'drizzle-orm';
import type { DBOrTx } from '../db/index.js';
import { documentCollaborators, documents, teamMembers, users, watches, type Document, type User } from '../db/schema.js';

export interface DocumentAccess {
  document: Document;
  isMember: boolean;
  ownerActive: boolean;
  isOwner: boolean;
  effectiveRole: 'owner' | 'editor' | 'viewer';
  canRead: boolean;
  canComment: boolean;
  canPublish: boolean;
  canRequestEdit: boolean;
  canManageAccess: boolean;
  canChangeVisibility: boolean;
  canDelete: boolean;
}

/** Correlated predicate: callers may add team/discovery scope, never a broader read rule. */
export function readableDocumentCondition(userId: string) {
  return sql`(
    (${documents.visibility} != 'private' and (
      ${documents.visibility} = 'public' or exists (
        select 1 from team_members reader_member where reader_member.team_id = ${documents.teamId} and reader_member.user_id = ${userId}
      )
    )) or (
      exists (select 1 from team_members active_owner where active_owner.team_id = ${documents.teamId} and active_owner.user_id = ${documents.createdBy})
      and (${documents.createdBy} = ${userId} or exists (
        select 1 from document_collaborators grant_row where grant_row.document_id = ${documents.id} and grant_row.user_id = ${userId}
      ))
    )
  )`;
}

export function resolveDocumentAccess(db: DBOrTx, slug: string, userId: string): DocumentAccess | undefined {
  const document = db.select().from(documents).where(and(eq(documents.id, slug), readableDocumentCondition(userId))).get();
  if (!document) return undefined;
  const member = db.select().from(teamMembers).where(and(eq(teamMembers.teamId, document.teamId), eq(teamMembers.userId, userId))).get();
  const ownerActive = !!db.select().from(teamMembers).where(and(eq(teamMembers.teamId, document.teamId), eq(teamMembers.userId, document.createdBy))).get();
  const isOwner = ownerActive && document.createdBy === userId;
  const grant = ownerActive ? db.select().from(documentCollaborators).where(and(eq(documentCollaborators.documentId, slug), eq(documentCollaborators.userId, userId))).get() : undefined;
  const baseline = document.visibility !== 'private';
  const canPublish = isOwner || (baseline && !!member) || grant?.role === 'editor';
  const canComment = canPublish || (baseline && (document.visibility === 'public' || !!member));
  return {
    document, isMember: !!member, ownerActive, isOwner,
    effectiveRole: isOwner ? 'owner' : canPublish ? 'editor' : 'viewer',
    canRead: true, canComment, canPublish, canManageAccess: isOwner,
    canRequestEdit: ownerActive && grant?.role === 'viewer' && !canPublish,
    canChangeVisibility: isOwner || (baseline && !!member),
    canDelete: isOwner || (baseline && member?.role === 'admin'),
  };
}

/** Remove all subscription states only when effective reading is lost. Runs in the caller's transaction. */
export function pruneDocumentWatches(db: DBOrTx, documentId: string): void {
  for (const watch of db.select().from(watches).where(eq(watches.documentId, documentId)).all()) {
    if (!resolveDocumentAccess(db, documentId, watch.userId)) {
      db.delete(watches).where(and(eq(watches.documentId, documentId), eq(watches.userId, watch.userId))).run();
    }
  }
}

/** Local directory only: team members plus the active owner and accepted grants. */
export function mentionableUsers(db: DBOrTx, documentId: string): User[] {
  const doc = db.select().from(documents).where(eq(documents.id, documentId)).get();
  if (!doc) return [];
  const ids = new Set<string>([doc.createdBy]);
  if (doc.visibility !== 'private') {
    for (const member of db.select().from(teamMembers).where(eq(teamMembers.teamId, doc.teamId)).all()) ids.add(member.userId);
  }
  for (const grant of db.select().from(documentCollaborators).where(eq(documentCollaborators.documentId, doc.id)).all()) ids.add(grant.userId);
  return [...ids].filter((id) => !!resolveDocumentAccess(db, doc.id, id)).flatMap((id) => {
    const user = db.select().from(users).where(eq(users.id, id)).get();
    return user ? [user] : [];
  });
}
