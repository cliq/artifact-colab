import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';

import { getOrCreateUser } from '../../src/server/auth.js';
import {
  comments,
  documentCollaborators,
  documents,
  openDb,
  projects,
  teamMembers,
  versions,
  watches,
  type DB,
  type User,
} from '../../src/server/db/index.js';
import {
  createProject,
  deleteProject,
  getProjectForUser,
  moveArtifact,
  normalizeProjectName,
  ProjectError,
  renameProject,
  resolveProjectForPublish,
  visibleProjectsForTeam,
} from '../../src/server/services/projects.js';
import { removeMember } from '../../src/server/services/teams.js';
import { seedTeamWithDomain } from './teamTestUtils.js';

const NOW = new Date('2026-09-14T12:00:00Z');

function freshDb(): DB {
  return openDb(':memory:').db;
}

function user(db: DB, email: string): User {
  return getOrCreateUser(db, email, NOW);
}

function seedDocument(
  db: DB,
  id: string,
  teamId: string,
  ownerId: string,
  visibility: 'team' | 'public' | 'private' = 'team',
  publishedAt = NOW,
): void {
  const versionId = `${id}-v1`;
  db.insert(documents).values({ id, title: id, teamId, createdBy: ownerId, visibility, currentVersionId: versionId, createdAt: NOW }).run();
  db.insert(versions).values({ id: versionId, documentId: id, number: 1, html: '<body>x</body>', publishedAt, publishedBy: ownerId }).run();
}

function expectProjectError(fn: () => unknown, status: ProjectError['status']): ProjectError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as ProjectError).status).toBe(status);
    return error as ProjectError;
  }
  throw new Error('Expected ProjectError');
}

describe('Project visibility and summaries', () => {
  test('shows empty and readable Projects while filtering private artifacts from aggregates', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team', 'example.com');
    const alice = user(db, 'alice@example.com');
    const bob = user(db, 'bob@example.com');
    const empty = createProject(db, 'team', alice.id, 'Empty');
    const mixed = createProject(db, 'team', alice.id, 'Mixed');

    seedDocument(db, 'private', 'team', alice.id, 'private', new Date('2026-09-14T14:00:00Z'));
    seedDocument(db, 'team-doc', 'team', alice.id, 'team', new Date('2026-09-14T13:00:00Z'));
    db.update(documents).set({ projectId: mixed.id }).run();
    db.insert(comments).values([
      { id: 'private-open', documentId: 'private', parentId: null, authorId: alice.id, body: 'x', quotedText: '', anchor: 'null', status: 'open', createdVersionId: 'private-v1', createdAt: NOW },
      { id: 'team-open', documentId: 'team-doc', parentId: null, authorId: bob.id, body: 'x', quotedText: '', anchor: 'null', status: 'open', createdVersionId: 'team-doc-v1', createdAt: NOW },
      { id: 'team-reply', documentId: 'team-doc', parentId: 'team-open', authorId: alice.id, body: 'x', quotedText: '', anchor: 'null', status: 'open', createdVersionId: 'team-doc-v1', createdAt: NOW },
      { id: 'team-resolved', documentId: 'team-doc', parentId: null, authorId: alice.id, body: 'x', quotedText: '', anchor: 'null', status: 'resolved', createdVersionId: 'team-doc-v1', createdAt: NOW },
    ]).run();

    const visible = visibleProjectsForTeam(db, 'team', bob.id);
    expect(visible.map((project) => project.name)).toEqual(['Empty', 'Mixed']);
    expect(visible[0]).toMatchObject({ id: empty.id, artifactCount: 0, openCommentCount: 0, lastPublishedAt: null });
    expect(visible[1]).toMatchObject({ id: mixed.id, artifactCount: 1, openCommentCount: 1 });
    expect(visible[1]!.lastPublishedAt).toEqual(new Date('2026-09-14T13:00:00Z'));
  });

  test('hides private-only Projects from teammates and admins, but shows them to an invited teammate', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team', 'example.com');
    const owner = user(db, 'owner@example.com');
    const viewer = user(db, 'viewer@example.com');
    const admin = user(db, 'admin@example.com');
    db.update(teamMembers).set({ role: 'admin' }).where(eq(teamMembers.userId, admin.id)).run();
    const project = createProject(db, 'team', owner.id, 'Secret');
    seedDocument(db, 'private', 'team', owner.id, 'private');
    db.update(documents).set({ projectId: project.id }).where(eq(documents.id, 'private')).run();

    expect(getProjectForUser(db, project.id, viewer.id)).toBeUndefined();
    expect(getProjectForUser(db, project.id, admin.id)).toBeUndefined();

    db.insert(documentCollaborators).values({ documentId: 'private', userId: viewer.id, role: 'viewer', grantedBy: owner.id, createdAt: NOW, updatedAt: NOW }).run();
    expect(getProjectForUser(db, project.id, viewer.id)).toMatchObject({ name: 'Secret', artifactCount: 1 });
  });

  test('rechecks collaborator access and team membership on every lookup', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team', 'example.com');
    const owner = user(db, 'owner@example.com');
    const viewer = user(db, 'viewer@example.com');
    const external = user(db, 'external@outside.test');
    const project = createProject(db, 'team', owner.id, 'Revocable');
    seedDocument(db, 'private', 'team', owner.id, 'private');
    db.update(documents).set({ projectId: project.id }).run();
    db.insert(documentCollaborators).values([
      { documentId: 'private', userId: viewer.id, role: 'viewer', grantedBy: owner.id, createdAt: NOW, updatedAt: NOW },
      { documentId: 'private', userId: external.id, role: 'editor', grantedBy: owner.id, createdAt: NOW, updatedAt: NOW },
    ]).run();

    expect(getProjectForUser(db, project.id, viewer.id)).toBeDefined();
    expect(getProjectForUser(db, project.id, external.id)).toBeUndefined();
    db.delete(documentCollaborators).run();
    expect(getProjectForUser(db, project.id, viewer.id)).toBeUndefined();

    db.update(documents).set({ visibility: 'team' }).run();
    expect(getProjectForUser(db, project.id, viewer.id)).toBeDefined();
    removeMember(db, 'team', viewer.id, NOW);
    expect(getProjectForUser(db, project.id, viewer.id)).toBeUndefined();
  });
});

describe('Project names and lifecycle', () => {
  test('normalizes display and lookup names and rejects invalid values', () => {
    expect(normalizeProjectName('  Cafe\u0301   Launch  ')).toEqual({ name: 'Café Launch', nameKey: 'café launch' });
    expect(normalizeProjectName('Roadmap / Q4')).toEqual({ name: 'Roadmap / Q4', nameKey: 'roadmap / q4' });
    for (const value of [undefined, null, '', '   ', 'UnFiLeD', 'bad\nname', 'x'.repeat(101)]) {
      expectProjectError(() => normalizeProjectName(value), 400);
    }
    expect(normalizeProjectName('😀'.repeat(100)).name).toHaveLength(200);
  });

  test('enforces normalized uniqueness per team, including hidden collisions', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'one', 'one.test');
    seedTeamWithDomain(db, 'two', 'two.test');
    const alice = user(db, 'alice@one.test');
    const bob = user(db, 'bob@one.test');
    const other = user(db, 'other@two.test');
    const first = createProject(db, 'one', alice.id, '  Launch   Plan ');
    expectProjectError(() => createProject(db, 'one', bob.id, 'launch plan'), 409);
    expect(createProject(db, 'two', other.id, 'launch plan').name).toBe('launch plan');

    seedDocument(db, 'private', 'one', alice.id, 'private');
    db.update(documents).set({ projectId: first.id }).run();
    expect(getProjectForUser(db, first.id, bob.id)).toBeUndefined();
    const error = expectProjectError(() => resolveProjectForPublish(db, 'one', bob.id, 'LAUNCH PLAN'), 409);
    expect(error.message).toBe('Project name is unavailable');
  });

  test('renames without changing identity and rejects collisions with any team Project', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team', 'example.com');
    const owner = user(db, 'owner@example.com');
    const first = createProject(db, 'team', owner.id, 'First');
    createProject(db, 'team', owner.id, 'Second');

    const renamed = renameProject(db, first.id, owner.id, '  New   Name ');
    expect(renamed).toMatchObject({ id: first.id, name: 'New Name' });
    expectProjectError(() => renameProject(db, first.id, owner.id, 'SECOND'), 409);
  });

  test('create-and-assign checks authorization before insert and commits assignment atomically', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team', 'example.com');
    const owner = user(db, 'owner@example.com');
    const viewer = user(db, 'viewer@example.com');
    seedDocument(db, 'private', 'team', owner.id, 'private');
    db.insert(documentCollaborators).values({ documentId: 'private', userId: viewer.id, role: 'viewer', grantedBy: owner.id, createdAt: NOW, updatedAt: NOW }).run();

    expectProjectError(() => createProject(db, 'team', viewer.id, 'Must roll back', 'private'), 403);
    expect(db.select().from(projects).all()).toHaveLength(0);

    const created = createProject(db, 'team', owner.id, 'Assigned', 'private');
    expect(db.select().from(documents).get()?.projectId).toBe(created.id);
  });
});

describe('Project assignment and deletion', () => {
  test('moves only editable same-team artifacts to existing accessible destinations', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'one', 'one.test');
    seedTeamWithDomain(db, 'two', 'two.test');
    const owner = user(db, 'owner@one.test');
    const viewer = user(db, 'viewer@one.test');
    const external = user(db, 'external@outside.test');
    const other = user(db, 'other@two.test');
    seedDocument(db, 'doc', 'one', owner.id, 'private');
    db.insert(documentCollaborators).values([
      { documentId: 'doc', userId: viewer.id, role: 'viewer', grantedBy: owner.id, createdAt: NOW, updatedAt: NOW },
      { documentId: 'doc', userId: external.id, role: 'editor', grantedBy: owner.id, createdAt: NOW, updatedAt: NOW },
    ]).run();
    const destination = createProject(db, 'one', owner.id, 'Destination');
    createProject(db, 'two', other.id, 'Other');

    expectProjectError(() => moveArtifact(db, 'doc', 'one', viewer.id, 'Destination'), 403);
    expectProjectError(() => moveArtifact(db, 'doc', 'one', external.id, 'Destination'), 403);
    expectProjectError(() => moveArtifact(db, 'doc', 'two', other.id, 'Other'), 404);
    expectProjectError(() => moveArtifact(db, 'doc', 'one', owner.id, 'Missing'), 404);
    expectProjectError(() => moveArtifact(db, 'doc', 'one', owner.id, undefined), 400);

    expect(moveArtifact(db, 'doc', 'one', owner.id, ' destination ')).toMatchObject({ id: destination.id });
    expect(moveArtifact(db, 'doc', 'one', owner.id, 'Destination')).toMatchObject({ id: destination.id });
    expect(moveArtifact(db, 'doc', 'one', owner.id, null)).toBeNull();
    expect(moveArtifact(db, 'doc', 'one', owner.id, null)).toBeNull();
  });

  test('deleting a visible Project unfiles every artifact and preserves artifact data', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team', 'example.com');
    const alice = user(db, 'alice@example.com');
    const bob = user(db, 'bob@example.com');
    const project = createProject(db, 'team', alice.id, 'Mixed');
    seedDocument(db, 'private', 'team', alice.id, 'private');
    seedDocument(db, 'readable', 'team', alice.id, 'team');
    db.update(documents).set({ projectId: project.id }).run();
    db.insert(watches).values({ documentId: 'private', userId: alice.id, state: 'watching', lastNotifiedAt: NOW, createdAt: NOW, updatedAt: NOW }).run();

    deleteProject(db, project.id, bob.id);
    expect(db.select().from(projects).all()).toHaveLength(0);
    expect(db.select().from(documents).all().map((doc) => doc.projectId)).toEqual([null, null]);
    expect(db.select().from(versions).all()).toHaveLength(2);
    expect(db.select().from(watches).all()).toHaveLength(1);
    expectProjectError(() => moveArtifact(db, 'readable', 'team', bob.id, 'Mixed'), 404);
  });

  test('publishing resolution reuses visible names and creates unused names', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team', 'example.com');
    const member = user(db, 'member@example.com');
    const first = resolveProjectForPublish(db, 'team', member.id, 'Plan');
    expect(first.created).toBe(true);
    expect(resolveProjectForPublish(db, 'team', member.id, ' plan ')).toEqual({ project: first.project, created: false });
  });
});
