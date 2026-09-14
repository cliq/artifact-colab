import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';

import { seedLocal } from '../../scripts/seed-local.js';
import { comments, documents, openDb, projects, users, versions } from '../../src/server/db/index.js';
import { sharedWithUserRows } from '../../src/server/services/documentLists.js';
import { visibleProjectsForTeam } from '../../src/server/services/projects.js';

test('local demo covers private Project visibility and external collaboration with valid content', () => {
  const { db, sqlite } = openDb(':memory:');
  try {
    expect(seedLocal(db, 'local@example.test')).toMatchObject({ addedArtifacts: 23, projectCount: 9 });
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    const viewer = db.select().from(users).where(eq(users.email, 'local@example.test')).get()!;
    const maya = db.select().from(users).where(eq(users.email, 'maya@example.test')).get()!;
    const riley = db.select().from(users).where(eq(users.email, 'riley@example.test')).get()!;
    const visible = visibleProjectsForTeam(db, 'demo-projects-studio', viewer.id);
    expect(visible.find((project) => project.name === 'Leadership planning')).toBeUndefined();
    expect(visible.find((project) => project.name === 'Future ideas')).toMatchObject({ artifactCount: 0, lastPublishedAt: null });
    expect(visible.find((project) => project.name === 'Website launch')).toMatchObject({ artifactCount: 3 });
    expect(visibleProjectsForTeam(db, 'demo-projects-studio', maya.id).find((project) => project.name === 'Leadership planning')).toMatchObject({ artifactCount: 2 });
    expect(visibleProjectsForTeam(db, 'demo-projects-studio', riley.id)).toEqual([]);
    const shared = sharedWithUserRows(db, riley.id);
    expect(shared).toHaveLength(2);
    expect(shared.map((row) => row.effectiveRole).sort()).toEqual(['editor', 'viewer']);
    expect(shared.every((row) => row.project === undefined && !row.canMoveProject)).toBe(true);
    expect(sqlite.prepare('select distinct state from comment_anchor_states').all()).toEqual([{ state: 'anchored' }]);
    expect(sqlite.prepare('select count(*) as count from documents d join versions v on d.current_version_id = v.id').get()).toEqual({ count: 23 });
  } finally {
    sqlite.close();
  }
});

test('rerunning the local seed preserves an existing account and edits without duplicating content', () => {
  const { db, sqlite } = openDb(':memory:');
  try {
    db.insert(users).values({ id: 'existing-local', email: 'local@example.test', name: 'Local User', createdAt: new Date() }).run();
    seedLocal(db, 'local@example.test');
    const counts = () => [users, projects, documents, versions, comments].map((table) => db.select().from(table).all().length);
    const before = counts();
    db.update(documents).set({ title: 'My edited brief', projectId: null }).where(eq(documents.id, 'demo-projects-launch-brief')).run();
    db.update(projects).set({ name: 'Renamed launch', nameKey: 'renamed launch' }).where(eq(projects.id, 'demo-projects-website')).run();
    expect(seedLocal(db, 'local@example.test').addedArtifacts).toBe(0);
    expect(counts()).toEqual(before);
    expect(db.select().from(users).where(eq(users.id, 'existing-local')).get()).toMatchObject({ name: 'Local User' });
    expect(db.select().from(documents).where(eq(documents.id, 'demo-projects-launch-brief')).get()).toMatchObject({ title: 'My edited brief', projectId: null });
    expect(db.select().from(projects).where(eq(projects.id, 'demo-projects-website')).get()).toMatchObject({ name: 'Renamed launch' });
  } finally {
    sqlite.close();
  }
});
