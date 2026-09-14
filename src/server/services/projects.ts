import { randomBytes } from 'node:crypto';

import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';

import type { DBOrTx } from '../db/index.js';
import {
  comments,
  documents,
  projects,
  teamMembers,
  versions,
  type Document,
  type Project,
} from '../db/schema.js';
import { readableDocumentCondition, resolveDocumentAccess } from './access.js';

export class ProjectError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

export interface ProjectSummary {
  id: string;
  teamId: string;
  name: string;
  artifactCount: number;
  openCommentCount: number;
  lastPublishedAt: Date | null;
}

interface ProjectSummaryRow extends Omit<ProjectSummary, 'lastPublishedAt'> {
  lastPublishedAt: number | null;
}

function randomId(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

export function normalizeProjectName(raw: unknown): { name: string; nameKey: string } {
  if (typeof raw !== 'string') throw new ProjectError('Project name must be a string', 400);

  const unicodeNormalized = raw.normalize('NFC');
  if (/\p{Cc}/u.test(unicodeNormalized)) throw new ProjectError('Project name cannot contain control characters', 400);

  const name = unicodeNormalized.trim().replace(/\s+/gu, ' ');
  const length = [...name].length;
  if (length < 1 || length > 100) throw new ProjectError('Project name must be between 1 and 100 characters', 400);

  const nameKey = name.toLowerCase();
  if (nameKey === 'unfiled') throw new ProjectError('Unfiled is reserved', 400);
  return { name, nameKey };
}

function isTeamMember(db: DBOrTx, teamId: string, userId: string): boolean {
  return !!db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
}

function requireTeamMember(db: DBOrTx, teamId: string, userId: string): void {
  if (!isTeamMember(db, teamId, userId)) throw new ProjectError('Team membership is required', 403);
}

function summaries(db: DBOrTx, teamId: string, userId: string, projectId?: string): ProjectSummary[] {
  if (!isTeamMember(db, teamId, userId)) return [];

  const readable = readableDocumentCondition(userId);
  const rows = db
    .select({
      id: projects.id,
      teamId: projects.teamId,
      name: projects.name,
      artifactCount: sql<number>`cast(count(distinct case when ${readable} then ${documents.id} end) as integer)`,
      openCommentCount: sql<number>`cast(count(distinct ${comments.id}) as integer)`,
      lastPublishedAt: sql<number | null>`max(${versions.publishedAt})`,
    })
    .from(projects)
    .leftJoin(documents, eq(documents.projectId, projects.id))
    .leftJoin(versions, and(eq(versions.id, documents.currentVersionId), readable))
    .leftJoin(
      comments,
      and(
        eq(comments.documentId, documents.id),
        isNull(comments.parentId),
        eq(comments.status, 'open'),
        readable,
      ),
    )
    .where(
      and(
        eq(projects.teamId, teamId),
        projectId === undefined ? undefined : eq(projects.id, projectId),
      ),
    )
    .groupBy(projects.id, projects.teamId, projects.name, projects.nameKey)
    .having(sql`count(${documents.id}) = 0 or count(case when ${readable} then 1 end) > 0`)
    .orderBy(asc(projects.nameKey), asc(projects.name))
    .all() as ProjectSummaryRow[];

  return rows.map((row) => ({
    ...row,
    lastPublishedAt: row.lastPublishedAt === null ? null : new Date(row.lastPublishedAt),
  }));
}

export function visibleProjectsForTeam(db: DBOrTx, teamId: string, userId: string): ProjectSummary[] {
  return summaries(db, teamId, userId);
}

export function getProjectForUser(db: DBOrTx, projectId: string, userId: string): ProjectSummary | undefined {
  const project = db.select({ teamId: projects.teamId }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return undefined;
  return summaries(db, project.teamId, userId, projectId)[0];
}

function unavailableName(): ProjectError {
  return new ProjectError('Project name is unavailable', 409);
}

function insertProject(
  db: DBOrTx,
  teamId: string,
  userId: string,
  normalized: { name: string; nameKey: string },
): Project | undefined {
  const now = new Date();
  return db
    .insert(projects)
    .values({
      id: randomId(),
      teamId,
      name: normalized.name,
      nameKey: normalized.nameKey,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning()
    .get();
}

function requireMovableDocument(
  db: DBOrTx,
  documentId: string,
  teamId: string,
  userId: string,
): Document {
  requireTeamMember(db, teamId, userId);
  const access = resolveDocumentAccess(db, documentId, userId);
  if (!access || access.document.teamId !== teamId) throw new ProjectError('Artifact not found', 404);
  if (!access.canPublish) throw new ProjectError('You cannot move this artifact', 403);
  return access.document;
}

export function createProject(
  db: DBOrTx,
  teamId: string,
  userId: string,
  name: unknown,
  documentId?: string,
): ProjectSummary {
  return db.transaction((tx) => {
    const normalized = normalizeProjectName(name);
    requireTeamMember(tx, teamId, userId);
    const document = documentId === undefined ? undefined : requireMovableDocument(tx, documentId, teamId, userId);

    const inserted = insertProject(tx, teamId, userId, normalized);
    if (!inserted) throw unavailableName();

    if (document) {
      tx.update(documents).set({ projectId: inserted.id }).where(eq(documents.id, document.id)).run();
    }
    return summaries(tx, teamId, userId, inserted.id)[0]!;
  });
}

export function renameProject(
  db: DBOrTx,
  projectId: string,
  userId: string,
  name: unknown,
): ProjectSummary {
  return db.transaction((tx) => {
    const normalized = normalizeProjectName(name);
    const visible = getProjectForUser(tx, projectId, userId);
    if (!visible) throw new ProjectError('Project not found', 404);

    const collision = tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.teamId, visible.teamId), eq(projects.nameKey, normalized.nameKey), ne(projects.id, projectId)))
      .get();
    if (collision) throw unavailableName();

    tx.update(projects)
      .set({ name: normalized.name, nameKey: normalized.nameKey, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .run();
    return summaries(tx, visible.teamId, userId, projectId)[0]!;
  });
}

export function deleteProject(db: DBOrTx, projectId: string, userId: string): void {
  db.transaction((tx) => {
    const visible = getProjectForUser(tx, projectId, userId);
    if (!visible) throw new ProjectError('Project not found', 404);

    tx.update(documents).set({ projectId: null }).where(eq(documents.projectId, projectId)).run();
    tx.delete(projects).where(eq(projects.id, projectId)).run();
  });
}

export function moveArtifact(
  db: DBOrTx,
  documentId: string,
  teamId: string,
  userId: string,
  project: unknown,
): ProjectSummary | null {
  return db.transaction((tx) => {
    const document = requireMovableDocument(tx, documentId, teamId, userId);
    if (project === undefined) throw new ProjectError('Project is required', 400);

    if (project === null) {
      if (document.projectId !== null) {
        tx.update(documents).set({ projectId: null }).where(eq(documents.id, document.id)).run();
      }
      return null;
    }

    const normalized = normalizeProjectName(project);
    const destination = tx
      .select()
      .from(projects)
      .where(and(eq(projects.teamId, teamId), eq(projects.nameKey, normalized.nameKey)))
      .get();
    if (!destination || !getProjectForUser(tx, destination.id, userId)) {
      throw new ProjectError('Project not found', 404);
    }

    if (document.projectId !== destination.id) {
      tx.update(documents).set({ projectId: destination.id }).where(eq(documents.id, document.id)).run();
    }
    return summaries(tx, teamId, userId, destination.id)[0]!;
  });
}

/** Resolve or create by name inside the caller's publishing transaction. */
export function resolveProjectForPublish(
  db: DBOrTx,
  teamId: string,
  userId: string,
  name: unknown,
): { project: Project; created: boolean } {
  const normalized = normalizeProjectName(name);
  requireTeamMember(db, teamId, userId);

  const existing = db
    .select()
    .from(projects)
    .where(and(eq(projects.teamId, teamId), eq(projects.nameKey, normalized.nameKey)))
    .get();
  if (existing) {
    if (!getProjectForUser(db, existing.id, userId)) throw unavailableName();
    return { project: existing, created: false };
  }

  const inserted = insertProject(db, teamId, userId, normalized);
  if (inserted) return { project: inserted, created: true };

  // A concurrent insertion won the unique key. Reuse it only if it is visible.
  const winner = db
    .select()
    .from(projects)
    .where(and(eq(projects.teamId, teamId), eq(projects.nameKey, normalized.nameKey)))
    .get();
  if (!winner || !getProjectForUser(db, winner.id, userId)) throw unavailableName();
  return { project: winner, created: false };
}
