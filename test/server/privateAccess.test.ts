// @vitest-environment node
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createSession, createToken, getOrCreateUser } from '../../src/server/auth.js';
import { comments, documentCollaborators, documents, openDb, teamMembers, tokens, versions, watches, type DB, type User } from '../../src/server/db/index.js';
import { resolveDocumentAccess } from '../../src/server/services/access.js';
import { setDocumentVisibility, deleteDocumentCascade } from '../../src/server/services/documents.js';
import { publishArtifact, publishDocumentVersion } from '../../src/server/services/publish.js';
import { removeMember } from '../../src/server/services/teams.js';
import { autoWatch, resolveMentions, runDigestSweep, setWatching } from '../../src/server/services/watches.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

describe('private collaboration capability matrix', () => {
  let db: DB;
  let sqlite: ReturnType<typeof openDb>['sqlite'];
  let app: ReturnType<typeof createApp>;
  let people: Record<string, User>;
  let cookie: Record<string, string>;
  const slug = 'collaboration-matrix';
  const config = baseTestConfig();
  const now = new Date();
  beforeEach(() => {
    ({ db, sqlite } = openDb(':memory:'));
    seedTeamWithDomain(db, 'home', 'example.com');
    seedTeamWithDomain(db, 'away', 'external.com');
    people = {};
    cookie = {};
    for (const [key, domain] of Object.entries({ owner: 'example.com', viewer: 'example.com', editor: 'example.com', admin: 'example.com', teammate: 'example.com', externalViewer: 'external.com', externalEditor: 'external.com', teamless: 'solo.com', stranger: 'other.com' })) {
      const user = getOrCreateUser(db, `${key.toLowerCase()}@${domain}`, now);
      people[key] = user;
      cookie[key] = `session=${createSession(db, user.id, now).token}; csrf=test`;
    }
    db.update(teamMembers).set({ role: 'admin' }).where(eq(teamMembers.userId, people.admin!.id)).run();
    db.insert(documents).values({ id: slug, title: 'Private matrix', teamId: 'home', createdBy: people.owner!.id, visibility: 'private', currentVersionId: 'v1', createdAt: now }).run();
    db.insert(versions).values({ id: 'v1', documentId: slug, number: 1, html: '<p>A shared passage.</p>', publishedAt: now, publishedBy: people.owner!.id }).run();
    for (const [key, role] of Object.entries({ viewer: 'viewer', editor: 'editor', externalViewer: 'viewer', externalEditor: 'editor', teamless: 'editor' }) as [string, 'viewer' | 'editor'][]) {
      db.insert(documentCollaborators).values({ documentId: slug, userId: people[key]!.id, role, grantedBy: people.owner!.id, createdAt: now, updatedAt: now }).run();
    }
    db.insert(comments).values({ id: 'thread', documentId: slug, authorId: people.owner!.id, body: 'Review', quotedText: 'A shared passage.', anchor: JSON.stringify({ v: 1, exact: 'A shared passage.', prefix: '', suffix: '', start: 0, docLength: 17 }), status: 'open', createdVersionId: 'v1', createdAt: now }).run();
    app = createApp({ db, config });
  });
  afterEach(() => sqlite.close());

  function request(actor: string, path: string, method = 'GET', body?: BodyInit) {
    return app.request(path, { method, headers: { cookie: cookie[actor]!, 'x-csrf-token': 'test', ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}) }, body });
  }

  test.each(['owner', 'viewer', 'editor', 'externalViewer', 'externalEditor', 'teamless', 'admin', 'teammate', 'stranger'])('%s reads exactly the authorized surfaces', async (actor) => {
    const allowed = !['admin', 'teammate', 'stranger'].includes(actor);
    for (const path of [`/d/${slug}`, `/d/${slug}/frame`, `/d/${slug}/frame?version=1`, `/api/docs/${slug}`, `/api/docs/${slug}/comments`, `/api/docs/${slug}/export.json`, `/api/docs/${slug}/export.md`, `/api/docs/${slug}/export.zip`]) {
      const response = await request(actor, path);
      expect(response.status, `${actor}: ${path}`).toBe(allowed ? 200 : 404);
    }
    const home = await (await request(actor, '/')).text();
    expect(home.includes('Private matrix')).toBe(allowed);
    if (actor.toLowerCase().includes('viewer')) expect(home).toContain('Your role: viewer');
    if (actor.toLowerCase().includes('editor') || actor === 'teamless') expect(home).toContain('Your role: editor');
    if (actor === 'teamless') expect(home).not.toContain('Name your team');
  });

  test.each(['viewer', 'externalViewer', 'admin', 'teammate', 'stranger'])('%s cannot mutate threads or publish', async (actor) => {
    const status = actor.toLowerCase().includes('viewer') ? 403 : 404;
    for (const [path, method, body] of [
      [`/api/docs/${slug}/comments`, 'POST', JSON.stringify({ body: 'No', quotedText: 'A shared passage.', versionId: 'v1', anchor: { v: 1, exact: 'A shared passage.', prefix: '', suffix: '', start: 0, docLength: 17 } })],
      ['/api/comments/thread/replies', 'POST', JSON.stringify({ body: 'No' })],
      ['/api/comments/thread/resolve', 'POST', undefined],
      ['/api/comments/thread/reopen', 'POST', undefined],
      ['/api/comments/thread/reactions/👍', 'PUT', undefined],
      ['/api/comments/thread/reactions/👍', 'DELETE', undefined],
    ] as const) expect((await request(actor, path, method, body)).status, path).toBe(status);
    const form = new FormData(); form.set('title', 'Forbidden'); form.set('markdown', '# No');
    expect((await request(actor, `/api/docs/${slug}/versions`, 'POST', form)).status).toBe(status);
    expect(db.select().from(versions).all()).toHaveLength(1);
    expect(db.select().from(comments).all()).toHaveLength(1);
    expect(db.select().from(watches).all()).toHaveLength(0);
  });

  test('external/teamless editors upload with attribution, anchoring and no team side effects', async () => {
    const form = new FormData(); form.set('title', 'Updated title'); form.set('markdown', 'A shared passage.\n\nNew material.');
    form.append('assets', new File(['image'], 'image.png', { type: 'image/png' }));
    expect((await request('teamless', `/api/docs/${slug}/versions`, 'POST', form)).status).toBe(200);
    const current = db.select().from(versions).where(eq(versions.number, 2)).get()!;
    expect(current.publishedBy).toBe(people.teamless!.id);
    expect(current.sourceMarkdown).toContain('New material.');
    expect(db.select().from(teamMembers).where(eq(teamMembers.userId, people.teamless!.id)).all()).toEqual([]);
    expect(db.select().from(tokens).all()).toEqual([]);
    expect(db.select().from(documents).get()).toMatchObject({ visibility: 'private', teamId: 'home', createdBy: people.owner!.id });
    expect((await request('externalEditor', '/api/comments/thread/replies', 'POST', JSON.stringify({ body: 'Looks good' }))).status).toBe(201);
    expect((await request('externalEditor', `/d/${slug}/share`, 'POST', new URLSearchParams({ visibility: 'public' }))).status).toBe(403);
    expect((await request('externalEditor', `/d/${slug}/delete`, 'POST')).status).toBe(403);
  });

  test('tokens stay inside their teams and explicit viewer grants cannot publish', async () => {
    const viewerToken = createToken(db, people.viewer!.id, 'home', 'Viewer token', now).plaintext;
    const awayToken = createToken(db, people.externalEditor!.id, 'away', 'Away token', now).plaintext;
    expect((await app.request(`/api/docs/${slug}/raw`, { headers: { authorization: `Bearer ${viewerToken}` } })).status).toBe(200);
    expect((await app.request(`/api/docs/${slug}/raw`, { headers: { authorization: `Bearer ${awayToken}` } })).status).toBe(404);
    expect(publishArtifact(db, config, people.viewer!, 'home', { title: 'No', html: '<p>No</p>', documentId: slug })).toMatchObject({ ok: false, status: 403 });
    expect(publishArtifact(db, config, people.externalEditor!, 'away', { title: 'No', html: '<p>No</p>', documentId: slug })).toMatchObject({ ok: false, status: 404 });
    expect(publishArtifact(db, config, people.editor!, 'home', { title: 'No', html: '<p>No</p>', documentId: slug, visibility: 'public' })).toMatchObject({ ok: false, status: 403 });
    expect(db.select().from(versions).all()).toHaveLength(1);
  });

  test('MCP checks current grants on every invocation, including comment IDs', async () => {
    const pat = createToken(db, people.editor!.id, 'home', 'Private editor', now).plaintext;
    async function call(name: string, args: Record<string, unknown>) {
      const response = await app.request('/mcp', {
        method: 'POST', headers: { authorization: `Bearer ${pat}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      const payload = response.headers.get('content-type')?.includes('text/event-stream')
        ? JSON.parse(body.split('\n').filter((line) => line.startsWith('data:')).at(-1)!.slice(5)) : JSON.parse(body);
      return payload.result;
    }
    expect((await call('get_artifact', { document_id: slug })).isError).toBeFalsy();
    expect((await call('add_comment', { comment_id: 'thread', body: 'Before downgrade' })).isError).toBeFalsy();
    db.update(documentCollaborators).set({ role: 'viewer' }).where(eq(documentCollaborators.userId, people.editor!.id)).run();
    for (const [name, args] of [
      ['add_comment', { comment_id: 'thread', body: 'After downgrade' }],
      ['add_comment', { document_id: slug, quoted_text: 'A shared passage.', body: 'After downgrade' }],
      ['resolve_comment', { comment_id: 'thread' }],
      ['publish_artifact', { document_id: slug, title: 'No', html: '<p>No</p>' }],
      ['delete_artifact', { document_id: slug }],
    ] as const) expect((await call(name, args)).isError, name).toBe(true);
    expect((await call('get_comments', { document_id: slug })).isError).toBeFalsy();
    expect(db.select().from(comments).all()).toHaveLength(2);
    expect(db.select().from(versions).all()).toHaveLength(1);
  });

  test('session uploads require CSRF and reject ownership/visibility overrides without partial writes', async () => {
    function form() { const body = new FormData(); body.set('title', 'New'); body.set('html', '<p>New</p>'); return body; }
    const noCsrf = await app.request(`/api/docs/${slug}/versions`, { method: 'POST', headers: { cookie: cookie.teamless! }, body: form() });
    expect(noCsrf.status).toBe(403);
    for (const key of ['visibility', 'document_id']) {
      const body = form(); body.set(key, key === 'visibility' ? 'public' : 'another-artifact');
      expect((await request('teamless', `/api/docs/${slug}/versions`, 'POST', body)).status).toBe(400);
    }
    const invalidAsset = form(); invalidAsset.append('assets', new File(['bad'], '../bad.png'));
    expect((await request('teamless', `/api/docs/${slug}/versions`, 'POST', invalidAsset)).status).toBe(400);
    expect(db.select().from(versions).all()).toHaveLength(1);
    expect(db.select().from(documents).get()?.title).toBe('Private matrix');
    expect(db.select().from(watches).all()).toHaveLength(0);
  });

  test('an explicitly invited team admin has only Editor rights on a private artifact', async () => {
    db.insert(documentCollaborators).values({ documentId: slug, userId: people.admin!.id, role: 'editor', grantedBy: people.owner!.id, createdAt: now, updatedAt: now }).run();
    expect(resolveDocumentAccess(db, slug, people.admin!.id)).toMatchObject({ canRead: true, canComment: true, canPublish: true, canManageAccess: false, canChangeVisibility: false, canDelete: false });
    expect((await request('admin', `/d/${slug}/delete`, 'POST')).status).toBe(403);
    expect((await request('admin', `/api/docs/${slug}/collaborators`)).status).toBe(403);
  });

  test('broader visibility combines grants with existing rights; returning private restores limits', () => {
    for (const actor of ['owner', 'viewer', 'externalViewer', 'stranger']) autoWatch(db, slug, people[actor]!.id, now);
    const doc = db.select().from(documents).get()!;
    setDocumentVisibility(db, doc, 'public');
    expect(resolveDocumentAccess(db, slug, people.externalViewer!.id)?.canComment).toBe(true);
    expect(resolveDocumentAccess(db, slug, people.externalViewer!.id)?.canPublish).toBe(false);
    setDocumentVisibility(db, doc, 'private');
    expect(resolveDocumentAccess(db, slug, people.viewer!.id)?.canComment).toBe(false);
    expect(db.select().from(watches).all()).toHaveLength(3);
    expect(resolveMentions(db, doc, people.owner!.id, `@${people.viewer!.email} @${people.externalEditor!.email} @${people.teammate!.email}`)).toHaveLength(2);
  });

  test('ordinary membership removal preserves grants; owner removal suspends grants and prunes watches', () => {
    autoWatch(db, slug, people.viewer!.id, now);
    removeMember(db, 'home', people.viewer!.id);
    expect(resolveDocumentAccess(db, slug, people.viewer!.id)?.canRead).toBe(true);
    expect(db.select().from(watches).all()).toHaveLength(1);
    removeMember(db, 'home', people.owner!.id);
    expect(resolveDocumentAccess(db, slug, people.viewer!.id)).toBeUndefined();
    expect(db.select().from(watches).all()).toHaveLength(0);
    db.insert(teamMembers).values({ teamId: 'home', userId: people.owner!.id, role: 'member', createdAt: now }).run();
    expect(resolveDocumentAccess(db, slug, people.viewer!.id)?.canRead).toBe(true);
    expect(db.select().from(watches).all()).toHaveLength(0);
    deleteDocumentCascade(db, slug);
    expect(db.select().from(documentCollaborators).all()).toHaveLength(0);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  test('a digest sweep rechecks access for recipients fetched before revocation', async () => {
    const before = new Date(now.getTime() - 1000);
    setWatching(db, slug, people.viewer!.id, true, before);
    setWatching(db, slug, people.externalViewer!.id, true, before);
    const sent = await runDigestSweep(db, config.baseUrl, async () => {
      db.delete(documentCollaborators).where(and(eq(documentCollaborators.documentId, slug), eq(documentCollaborators.userId, people.externalViewer!.id))).run();
    }, new Date(now.getTime() + 10 * 60 * 1000));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(people.viewer!.email);
  });

  test('a role downgrade during a streamed mutation is checked after the body arrives', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const pending = app.request('/api/comments/thread/resolve', {
      method: 'POST', headers: { cookie: cookie.editor!, 'x-csrf-token': 'test', 'content-length': '2' },
      body, duplex: 'half',
    } as RequestInit & { duplex: string });
    await new Promise((resolve) => setImmediate(resolve));
    db.update(documentCollaborators).set({ role: 'viewer' }).where(eq(documentCollaborators.userId, people.editor!.id)).run();
    controller.enqueue(new TextEncoder().encode('{}')); controller.close();
    expect((await pending).status).toBe(403);
    expect(db.select().from(comments).where(eq(comments.id, 'thread')).get()?.status).toBe('open');
  });

  test('role downgrade immediately rejects session publishing from an already-open page', async () => {
    expect((await request('teamless', `/d/${slug}`)).status).toBe(200);
    db.update(documentCollaborators).set({ role: 'viewer' }).where(eq(documentCollaborators.userId, people.teamless!.id)).run();
    expect(publishDocumentVersion(db, config, people.teamless!, slug, { title: 'No', html: '<p>No</p>' })).toMatchObject({ ok: false, status: 403 });
  });
});
