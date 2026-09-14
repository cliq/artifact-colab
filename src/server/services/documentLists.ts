/** Shared, authorized artifact rows for the root list and Project pages. */
import { and, count, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { comments, documentCollaborators, documents, teamMembers, users, versions, watches, type Document } from '../db/schema.js';
import { readableDocumentCondition, resolveDocumentAccess } from './access.js';
import type { ProjectSummary } from './projects.js';
export type { ProjectSummary } from './projects.js';

export type DocumentsView = 'folders' | 'tags';
export interface DocumentListRow {
  id: string;
  teamId: string;
  title: string;
  ownerName: string;
  ownerEmail: string | null;
  visibility: 'private' | 'team' | 'public';
  versionCount: number;
  openCommentCount: number;
  lastPublishedAt: Date | null;
  effectiveRole?: 'owner' | 'editor' | 'viewer';
  canMoveProject: boolean;
  /** Omitted for outsiders, including accepted external Editors. */
  project?: { id: string; name: string } | null;
}

export interface TeamDocumentsGroup {
  teamId: string;
  teamName: string;
  isTeamAdmin: boolean;
  documents: DocumentListRow[];
  projects: ProjectSummary[];
}

function documentRow(db: DB, doc: Document, userId: string, projectNames?: Map<string, string>): DocumentListRow {
  const versionCount = db.select({ value: count() }).from(versions).where(eq(versions.documentId, doc.id)).get()!.value;
  const openCommentCount = db.select({ value: count() }).from(comments)
    .where(and(eq(comments.documentId, doc.id), eq(comments.status, 'open'), isNull(comments.parentId))).get()!.value;
  const latest = db.select({ publishedAt: versions.publishedAt }).from(versions)
    .where(eq(versions.documentId, doc.id)).orderBy(desc(versions.number)).limit(1).get();
  const owner = db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, doc.createdBy)).get();
  const access = resolveDocumentAccess(db, doc.id, userId)!;
  const projectName = doc.projectId ? projectNames?.get(doc.projectId) : undefined;
  return {
    id: doc.id, teamId: doc.teamId, title: doc.title,
    ownerName: owner?.name ?? owner?.email ?? '—', ownerEmail: owner?.email ?? null,
    visibility: doc.visibility as DocumentListRow['visibility'],
    effectiveRole: access.effectiveRole, canMoveProject: access.isMember && access.canPublish,
    versionCount, openCommentCount, lastPublishedAt: latest?.publishedAt ?? null,
    ...(access.isMember ? { project: doc.projectId && projectName ? { id: doc.projectId, name: projectName } : null } : {}),
  };
}

export function documentRowsForTeam(db: DB, teamId: string, userId: string, visibleProjects: ProjectSummary[], projectId?: string): DocumentListRow[] {
  if (!db.select().from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))).get()) return [];
  const names = new Map(visibleProjects.map((p) => [p.id, p.name]));
  return db.select().from(documents)
    .where(and(eq(documents.teamId, teamId), readableDocumentCondition(userId), projectId === undefined ? undefined : eq(documents.projectId, projectId)))
    .orderBy(desc(documents.createdAt)).all().map((doc) => documentRow(db, doc, userId, names));
}

/** Accepted external grants are discoverable independently of watches. */
export function sharedWithUserRows(db: DB, userId: string): DocumentListRow[] {
  return db.select({ document: documents }).from(documents)
    .leftJoin(watches, and(eq(watches.documentId, documents.id), eq(watches.userId, userId)))
    .leftJoin(documentCollaborators, and(eq(documentCollaborators.documentId, documents.id), eq(documentCollaborators.userId, userId)))
    .leftJoin(teamMembers, and(eq(teamMembers.teamId, documents.teamId), eq(teamMembers.userId, userId)))
    .where(and(readableDocumentCondition(userId), isNull(teamMembers.userId), or(isNotNull(documentCollaborators.userId), and(eq(documents.visibility, 'public'), isNotNull(watches.userId)))))
    .orderBy(desc(documents.createdAt)).all().map(({ document }) => documentRow(db, document, userId));
}
