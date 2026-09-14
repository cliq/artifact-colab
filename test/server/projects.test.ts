// @vitest-environment node
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createSession, createToken, getOrCreateUser } from '../../src/server/auth.js';
import { comments, documentCollaborators, documents, openDb, projects, teamMembers, versions, watches, type DB, type User } from '../../src/server/db/index.js';
import { createProject } from '../../src/server/services/projects.js';
import { publishArtifact } from '../../src/server/services/publish.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

describe('Projects routes and discovery', () => {
  const config = baseTestConfig();
  let db: DB;
  let sqlite: ReturnType<typeof openDb>['sqlite'];
  let app: ReturnType<typeof createApp>;
  let people: Record<string, User>;
  let cookies: Record<string, string>;
  let privateId: string;
  let publicId: string;
  let mixedPrivateId: string;
  let hiddenProject: string;
  let mixedProject: string;
  let emptyProject: string;
  const now = new Date();

  function publish(title: string, visibility: 'private' | 'public', project: string) {
    const result = publishArtifact(db, config, people.owner!, 'home', { title, html: `<p>${title}</p>`, visibility, project });
    if (!result.ok) throw new Error(result.error);
    return result.documentId;
  }
  function grant(documentId: string, actor: string, role: 'viewer' | 'editor') {
    db.insert(documentCollaborators).values({ documentId, userId: people[actor]!.id, role, grantedBy: people.owner!.id, createdAt: now, updatedAt: now }).run();
  }
  function request(actor: string, path: string, method = 'GET', body?: unknown) {
    return app.request(path, { method, headers: { cookie: cookies[actor]!, 'x-csrf-token': 'test', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  beforeEach(() => {
    ({ db, sqlite } = openDb(':memory:'));
    seedTeamWithDomain(db, 'home', 'example.com');
    seedTeamWithDomain(db, 'away', 'external.com');
    people = {}; cookies = {};
    for (const [actor, domain] of Object.entries({ owner: 'example.com', member: 'example.com', viewer: 'example.com', editor: 'example.com', admin: 'example.com', external: 'external.com' })) {
      const person = getOrCreateUser(db, `${actor}@${domain}`, now);
      people[actor] = person;
      cookies[actor] = `session=${createSession(db, person.id, now).token}; csrf=test`;
    }
    db.update(teamMembers).set({ role: 'admin' }).where(eq(teamMembers.userId, people.admin!.id)).run();
    privateId = publish('Private acquisition brief', 'private', 'Confidential acquisition');
    publicId = publish('Published launch brief', 'public', 'Website launch');
    mixedPrivateId = publish('Private launch budget', 'private', 'Website launch');
    hiddenProject = db.select().from(documents).where(eq(documents.id, privateId)).get()!.projectId!;
    mixedProject = db.select().from(documents).where(eq(documents.id, publicId)).get()!.projectId!;
    emptyProject = createProject(db, 'home', people.owner!.id, 'Empty project').id;
    grant(publicId, 'external', 'editor');
    app = createApp({ db, config });
  });
  afterEach(() => sqlite.close());

  test.each(['member', 'admin'])('hidden Projects are absent from all team discovery for %s', async (actor) => {
    for (const path of ['/', '/?view=tags', '/api/teams/home/projects']) {
      const response = await request(actor, path);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('private');
      const text = await response.text();
      for (const hidden of ['Confidential acquisition', hiddenProject, 'Private acquisition brief', 'Private launch budget']) expect(text).not.toContain(hidden);
      expect(text).toContain('Website launch');
    }
    for (const id of [hiddenProject, 'missing']) {
      expect((await request(actor, `/p/${id}`)).status).toBe(404);
      expect((await request(actor, `/api/projects/${id}`, 'PATCH', { name: 'Renamed' })).status).toBe(404);
      expect((await request(actor, `/api/projects/${id}`, 'DELETE')).status).toBe(404);
    }
    const list = await (await request(actor, '/api/teams/home/projects')).json();
    expect(list.projects.find((p: { id: string }) => p.id === mixedProject).artifactCount).toBe(1);
    expect(list.projects.find((p: { id: string }) => p.id === emptyProject).artifactCount).toBe(0);
  });

  test('private activity is excluded from visible Project counts and publication times', async () => {
    const visibleDate = new Date('2026-01-01T00:00:00Z');
    db.update(versions).set({ publishedAt: visibleDate }).where(eq(versions.documentId, publicId)).run();
    db.update(versions).set({ publishedAt: new Date('2026-09-01T00:00:00Z') }).where(eq(versions.documentId, mixedPrivateId)).run();
    for (const [id, docId] of [['visible', publicId], ['secret', mixedPrivateId]]) {
      const doc = db.select().from(documents).where(eq(documents.id, docId!)).get()!;
      db.insert(comments).values({ id: id!, documentId: doc.id, authorId: people.owner!.id, body: 'Review', quotedText: 'brief', anchor: '{}', status: 'open', createdVersionId: doc.currentVersionId!, createdAt: now }).run();
    }
    const list = await (await request('member', '/api/teams/home/projects')).json();
    expect(list.projects.find((p: { id: string }) => p.id === mixedProject)).toMatchObject({ artifactCount: 1, openCommentCount: 1, lastPublishedAt: visibleDate.toISOString() });
  });

  test('external Editors can read/update artifacts without Project metadata or organization rights', async () => {
    for (const path of ['/?view=tags', `/d/${publicId}`, `/api/docs/${publicId}`, `/api/docs/${publicId}/export.json`, `/api/docs/${publicId}/export.md`]) {
      const response = await request('external', path);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(mixedProject);
      expect(text).not.toContain('Website launch');
      expect(text).not.toContain('Move to project');
    }
    const payload = await (await request('external', `/api/docs/${publicId}`)).json();
    expect(payload.document).not.toHaveProperty('project');
    expect(payload.access).not.toHaveProperty('document');
    expect(payload.access.canPublish).toBe(true);
    expect((await request('external', '/api/teams/home/projects')).status).toBe(404);
    expect((await request('external', `/p/${mixedProject}`)).status).toBe(404);
    expect((await request('external', `/api/docs/${publicId}/project`, 'PATCH', { project: null })).status).toBeGreaterThanOrEqual(400);
  });

  test('invitation and revocation change Project visibility immediately; membership is still required', async () => {
    grant(privateId, 'viewer', 'viewer');
    expect((await request('viewer', `/p/${hiddenProject}`)).status).toBe(200);
    expect((await request('viewer', `/api/docs/${privateId}/project`, 'PATCH', { project: null })).status).toBe(403);
    db.delete(documentCollaborators).where(and(eq(documentCollaborators.documentId, privateId), eq(documentCollaborators.userId, people.viewer!.id))).run();
    expect((await request('viewer', `/p/${hiddenProject}`)).status).toBe(404);
    grant(privateId, 'editor', 'editor');
    db.delete(teamMembers).where(and(eq(teamMembers.teamId, 'home'), eq(teamMembers.userId, people.editor!.id))).run();
    expect((await request('editor', `/d/${privateId}`)).status).toBe(200);
    expect((await request('editor', `/p/${hiddenProject}`)).status).toBe(404);
    expect((await request('editor', `/api/docs/${privateId}/project`, 'PATCH', { project: null })).status).toBeGreaterThanOrEqual(400);
  });

  test('any authorized teammate can rename and dissolve a Project without touching artifacts or sharing', async () => {
    const beforeDocs = db.select().from(documents).all();
    const beforeVersions = db.select().from(versions).all();
    const beforeGrants = db.select().from(documentCollaborators).all();
    const beforeWatches = db.select().from(watches).all();
    expect((await request('member', `/api/projects/${mixedProject}`, 'PATCH', { name: 'Brand refresh' })).status).toBe(200);
    expect((await request('member', `/p/${mixedProject}`)).status).toBe(200);
    expect((await request('member', `/api/projects/${mixedProject}`, 'DELETE')).status).toBe(200);
    expect((await request('member', `/p/${mixedProject}`)).status).toBe(404);
    for (const before of beforeDocs) expect(db.select().from(documents).where(eq(documents.id, before.id)).get()).toEqual({ ...before, projectId: before.projectId === mixedProject ? null : before.projectId });
    expect(db.select().from(versions).all()).toEqual(beforeVersions);
    expect(db.select().from(documentCollaborators).all()).toEqual(beforeGrants);
    expect(db.select().from(watches).all()).toEqual(beforeWatches);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  test('create-and-assign and moves obey permissions without new versions', async () => {
    const count = db.select().from(versions).all().length;
    const created = await request('member', '/api/teams/home/projects', 'POST', { name: 'New destination', document_id: publicId });
    expect(created.status).toBe(200);
    const id = (await created.json()).project.id;
    expect(db.select().from(documents).where(eq(documents.id, publicId)).get()!.projectId).toBe(id);
    for (const project of ['New destination', null, null]) expect((await request('member', `/api/docs/${publicId}/project`, 'PATCH', { project })).status).toBe(200);
    expect(db.select().from(versions).all()).toHaveLength(count);
    for (const project of ['Missing', 'Confidential acquisition']) expect((await request('member', `/api/docs/${publicId}/project`, 'PATCH', { project })).status).toBeGreaterThanOrEqual(400);
    expect(db.select().from(projects).where(eq(projects.name, 'Missing')).get()).toBeUndefined();
    const denied = await request('member', '/api/teams/home/projects', 'POST', { name: 'Unauthorized orphan', document_id: privateId });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(db.select().from(projects).where(eq(projects.name, 'Unauthorized orphan')).get()).toBeUndefined();
    createProject(db, 'away', people.external!.id, 'Other team');
    db.insert(teamMembers).values({ teamId: 'away', userId: people.member!.id, role: 'member', createdAt: now }).run();
    expect((await request('member', `/api/docs/${publicId}/project`, 'PATCH', { project: 'Other team' })).status).toBe(404);
  });

  test('moving the last readable artifact out returns safe root navigation', async () => {
    const moved = await request('member', `/api/docs/${publicId}/project?view=tags`, 'PATCH', { project: null });
    expect(moved.status).toBe(200);
    expect((await moved.json()).returnUrl).toBe('/?view=tags');
    expect((await request('member', `/p/${mixedProject}`)).status).toBe(404);
  });

  test('create-and-assign also navigates away when the source Project becomes hidden', async () => {
    const response = await request('member', '/api/teams/home/projects?view=tags', 'POST', { name: 'Fresh project', document_id: publicId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ project: { name: 'Fresh project' }, returnUrl: '/?view=tags' });
    expect((await request('member', `/p/${mixedProject}`)).status).toBe(404);
  });

  test('Folder and Tag views keep identical assignments and scope preferences per user', async () => {
    const before = db.select().from(documents).all();
    const folders = await (await request('owner', '/?view=folders')).text();
    expect(folders).toContain(`/p/${mixedProject}`);
    expect(folders).not.toContain(`href="/d/${publicId}"`);
    const selected = await request('owner', '/?view=tags');
    const tags = await selected.text();
    expect(tags).toContain(`href="/d/${publicId}"`);
    expect(tags).toContain(`href="/d/${privateId}"`);
    const preference = selected.headers.get('set-cookie')!.split(';')[0]!;
    const remembered = await app.request('/', { headers: { cookie: `${cookies.owner}; ${preference}` } });
    expect(await remembered.text()).toContain(`href="/d/${publicId}"`);
    const another = await app.request('/', { headers: { cookie: `${cookies.member}; ${preference}` } });
    expect(await another.text()).not.toContain(`href="/d/${publicId}"`);
    expect(db.select().from(documents).all()).toEqual(before);
  });

  test('mutations require CSRF and reject malformed requests without partial changes', async () => {
    const before = db.select().from(projects).all();
    for (const [path, method, body] of [
      ['/api/teams/home/projects', 'POST', { name: 'Unauthorized' }],
      [`/api/projects/${emptyProject}`, 'PATCH', { name: 'Unauthorized' }],
      [`/api/projects/${emptyProject}`, 'DELETE', undefined],
      [`/api/docs/${publicId}/project`, 'PATCH', { project: null }],
    ] as const) {
      const res = await app.request(path, { method, headers: { cookie: cookies.owner!, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(res.status).toBe(403);
    }
    for (const body of [null, [], {}, { project: [] }, { project: '  ' }]) expect((await request('owner', `/api/docs/${publicId}/project`, 'PATCH', body)).status).toBe(400);
    expect(db.select().from(projects).all()).toEqual(before);
  });

  test('membership revoked while the request body streams prevents create', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const pending = app.request('/api/teams/home/projects', { method: 'POST', headers: { cookie: cookies.member!, 'x-csrf-token': 'test', 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit & { duplex: string });
    await new Promise((resolve) => setImmediate(resolve));
    db.delete(teamMembers).where(and(eq(teamMembers.teamId, 'home'), eq(teamMembers.userId, people.member!.id))).run();
    controller.enqueue(new TextEncoder().encode('{"name":"Revoked request"}')); controller.close();
    expect((await pending).status).toBeGreaterThanOrEqual(400);
    expect(db.select().from(projects).where(eq(projects.name, 'Revoked request')).get()).toBeUndefined();
  });

  test('simultaneous publishing reuses one shared name and cannot join another publisher\'s hidden Project', async () => {
    const pats = ['owner', 'member'].map((actor) => createToken(db, people[actor]!.id, 'home', 'Concurrent publish', now).plaintext);
    const publishRequest = (pat: string, name: string, visibility: string) => {
      const body = new FormData();
      body.set('title', 'Concurrent artifact'); body.set('html', '<p>Concurrent content</p>');
      body.set('project', name); body.set('visibility', visibility);
      return app.request('/api/publish', { method: 'POST', headers: { authorization: `Bearer ${pat}` }, body });
    };
    const shared = await Promise.all(pats.map((pat) => publishRequest(pat, 'Concurrent shared', 'team')));
    expect(shared.map((response) => response.status)).toEqual([200, 200]);
    const outcomes = await Promise.all(shared.map((response) => response.json()));
    expect(outcomes.filter((value) => value.project_created)).toHaveLength(1);
    expect(db.select().from(projects).where(eq(projects.nameKey, 'concurrent shared')).all()).toHaveLength(1);
    const privateResults = await Promise.all(pats.map((pat) => publishRequest(pat, 'Concurrent private', 'private')));
    expect(privateResults.map((response) => response.status).sort()).toEqual([200, 409]);
    const privateProject = db.select().from(projects).where(eq(projects.nameKey, 'concurrent private')).get()!;
    expect(db.select().from(documents).where(eq(documents.projectId, privateProject.id)).all()).toHaveLength(1);
  });
});
