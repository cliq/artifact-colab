// @vitest-environment node

/**
 * Editing comments and replies: only the author may, the body and `editedAt`
 * change while everything else stays put, and new mentions subscribe people.
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { describeTextAnchor } from '../../src/anchoring/text.js';
import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import { comments, documents, openDb, versions, watches, type DB } from '../../src/server/db/index.js';
import { sessionAuth } from '../../src/server/middleware.js';
import { apiRoutes, type ThreadDTO } from '../../src/server/routes/api.js';
import { indexVersionHtml } from '../../src/server/services/anchorStates.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const QUOTE = 'The launch plan is ready for review.';
const HTML = `<body><p>${QUOTE}</p></body>`;

describe('comment edits', () => {
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let app: Hono<AppEnv>;
  let aliceCookie: string;
  let bobCookie: string;
  let outsiderCookie: string;
  let carolId: string;
  let threadId: string;
  let replyId: string;
  const slug = 'doc-1';

  beforeAll(async () => {
    const opened = openDb(':memory:');
    db = opened.db;
    sqlite = opened.sqlite;
    seedTeamWithDomain(db, 'team-example', 'example.com');
    const config = baseTestConfig();

    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('config', config);
      await next();
    });
    app.use('/api/*', sessionAuth({ redirect: false }));
    app.route('/', apiRoutes);

    const now = new Date();
    const alice = getOrCreateUser(db, 'alice@example.com', now);
    const bob = getOrCreateUser(db, 'bob@example.com', now);
    carolId = getOrCreateUser(db, 'carol@example.com', now).id;
    const outsider = getOrCreateUser(db, 'eve@elsewhere.com', now);
    aliceCookie = `session=${createSession(db, alice.id, now).token}`;
    bobCookie = `session=${createSession(db, bob.id, now).token}`;
    outsiderCookie = `session=${createSession(db, outsider.id, now).token}`;

    db.insert(documents).values({ id: slug, title: 'Doc', teamId: 'team-example', createdBy: alice.id, createdAt: now }).run();
    db.insert(versions).values({ id: 'v1', documentId: slug, number: 1, html: HTML, publishedAt: now, publishedBy: alice.id }).run();
    db.update(documents).set({ currentVersionId: 'v1' }).where(eq(documents.id, slug)).run();

    const text = indexVersionHtml(HTML);
    const start = text.indexOf(QUOTE);
    const created = await app.request(`/api/docs/${slug}/comments`, {
      method: 'POST',
      headers: { cookie: aliceCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Ship it', quotedText: QUOTE, anchor: describeTextAnchor(text, start, start + QUOTE.length), versionId: 'v1' }),
    });
    threadId = ((await created.json()) as { id: string }).id;
    const reply = await app.request(`/api/comments/${threadId}/replies`, {
      method: 'POST',
      headers: { cookie: bobCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Agreed' }),
    });
    replyId = ((await reply.json()) as { id: string }).id;
  });

  afterAll(() => sqlite.close());

  const edit = (cookie: string, id: string, body: unknown) =>
    app.request(`/api/comments/${id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('comments start out unedited', async () => {
    const list = await app.request(`/api/docs/${slug}/comments`, { headers: { cookie: aliceCookie } });
    const [thread] = ((await list.json()) as { comments: ThreadDTO[] }).comments;
    expect(thread!.editedAt).toBeNull();
    expect(thread!.replies[0]!.editedAt).toBeNull();
  });

  test('the author edits a thread body; the anchor and status stay put', async () => {
    const res = await edit(aliceCookie, threadId, { body: '  Ship it on Monday  ' });
    expect(res.status).toBe(200);
    const thread = (await res.json()) as ThreadDTO;
    expect(thread.id).toBe(threadId);
    expect(thread.body).toBe('Ship it on Monday');
    expect(thread.editedAt).not.toBeNull();
    expect(thread.quotedText).toBe(QUOTE);
    expect(thread.status).toBe('open');
    expect(thread.anchorState?.state).toBe('anchored');
  });

  test('editing a reply returns the parent thread with the updated reply', async () => {
    const res = await edit(bobCookie, replyId, { body: 'Agreed, Monday works' });
    expect(res.status).toBe(200);
    const thread = (await res.json()) as ThreadDTO;
    expect(thread.id).toBe(threadId);
    expect(thread.replies[0]!.body).toBe('Agreed, Monday works');
    expect(thread.replies[0]!.editedAt).not.toBeNull();
  });

  test("nobody else can edit someone's comment", async () => {
    expect((await edit(bobCookie, threadId, { body: 'Hijacked' })).status).toBe(403);
    expect((await edit(aliceCookie, replyId, { body: 'Hijacked' })).status).toBe(403);
    expect((await edit(outsiderCookie, threadId, { body: 'Hijacked' })).status).toBe(404);
    expect((await edit(aliceCookie, 'missing', { body: 'Hijacked' })).status).toBe(404);
    const row = db.select().from(comments).where(eq(comments.id, threadId)).get();
    expect(row!.body).toBe('Ship it on Monday');
  });

  test('rejects an empty body', async () => {
    expect((await edit(aliceCookie, threadId, { body: '   ' })).status).toBe(400);
    expect((await edit(aliceCookie, threadId, {})).status).toBe(400);
  });

  test('a mention added by the edit subscribes that person', async () => {
    const watchOf = () =>
      db.select().from(watches).where(and(eq(watches.documentId, slug), eq(watches.userId, carolId))).get();
    expect(watchOf()).toBeUndefined();
    const res = await edit(aliceCookie, threadId, { body: 'Ship it on Monday, @carol@example.com' });
    const thread = (await res.json()) as ThreadDTO;
    expect(thread.mentions.map((m) => m.email)).toEqual(['carol@example.com']);
    expect(watchOf()).toBeDefined();
  });
});
