// @vitest-environment node

/**
 * Emoji reactions on comments and replies: toggling, the fixed palette,
 * per-viewer `reactedByMe`, and how they surface in the exports.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { describeTextAnchor } from '../../src/anchoring/text.js';
import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import { commentReactions, comments, documents, openDb, versions, type DB } from '../../src/server/db/index.js';
import { sessionAuth } from '../../src/server/middleware.js';
import { apiRoutes, type ThreadDTO } from '../../src/server/routes/api.js';
import { indexVersionHtml } from '../../src/server/services/anchorStates.js';
import { deleteDocumentCascade } from '../../src/server/services/documents.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const QUOTE = 'The launch plan is ready for review.';
const HTML = `<body><p>${QUOTE}</p></body>`;

describe('comment reactions', () => {
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let app: Hono<AppEnv>;
  let aliceCookie: string;
  let bobCookie: string;
  let outsiderCookie: string;
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

  const react = (cookie: string, id: string, emoji: string, method: 'PUT' | 'DELETE' = 'PUT') =>
    app.request(`/api/comments/${id}/reactions/${encodeURIComponent(emoji)}`, { method, headers: { cookie } });

  test('adding is idempotent and marks only the reacting viewer', async () => {
    expect((await react(aliceCookie, threadId, '👍')).status).toBe(200);
    const res = await react(aliceCookie, threadId, '👍');
    expect(res.status).toBe(200);
    const thread = (await res.json()) as ThreadDTO;
    expect(thread.reactions).toEqual([{ emoji: '👍', count: 1, users: ['alice@example.com'], reactedByMe: true }]);

    await react(bobCookie, threadId, '👍');
    const asBob = (await (await react(bobCookie, threadId, '🎉')).json()) as ThreadDTO;
    expect(asBob.reactions.map((r) => [r.emoji, r.count, r.reactedByMe])).toEqual([
      ['👍', 2, true],
      ['🎉', 1, true],
    ]);

    const list = await app.request(`/api/docs/${slug}/comments`, { headers: { cookie: aliceCookie } });
    const [fromAlice] = ((await list.json()) as { comments: ThreadDTO[] }).comments;
    expect(fromAlice!.reactions.map((r) => [r.emoji, r.reactedByMe])).toEqual([
      ['👍', true],
      ['🎉', false],
    ]);
  });

  test('reactions on a reply come back on that reply, inside the parent thread', async () => {
    const res = await react(aliceCookie, replyId, '❤️');
    expect(res.status).toBe(200);
    const thread = (await res.json()) as ThreadDTO;
    expect(thread.id).toBe(threadId);
    expect(thread.replies[0]!.reactions).toEqual([{ emoji: '❤️', count: 1, users: ['alice@example.com'], reactedByMe: true }]);
  });

  test('removing only drops the viewer\'s own reaction', async () => {
    const res = await react(aliceCookie, threadId, '👍', 'DELETE');
    const thread = (await res.json()) as ThreadDTO;
    expect(thread.reactions.find((r) => r.emoji === '👍')).toEqual({ emoji: '👍', count: 1, users: ['bob@example.com'], reactedByMe: false });
  });

  test('rejects emoji outside the palette and comments the viewer cannot see', async () => {
    expect((await react(aliceCookie, threadId, '❓')).status).toBe(400);
    expect((await react(aliceCookie, threadId, 'thumbsup')).status).toBe(400);
    expect((await react(outsiderCookie, threadId, '👍')).status).toBe(404);
    expect((await react(aliceCookie, 'missing', '👍')).status).toBe(404);
  });

  test('exports carry a reaction summary', async () => {
    const md = await (await app.request(`/api/docs/${slug}/export.md`, { headers: { cookie: aliceCookie } })).text();
    expect(md).toContain('Ship it [👍 1 · 🎉 1]');
    expect(md).toContain('Agreed [❤️ 1]');
    const json = (await (await app.request(`/api/docs/${slug}/export.json`, { headers: { cookie: aliceCookie } })).json()) as {
      comments: ThreadDTO[];
    };
    expect(json.comments[0]!.reactions.map((r) => r.emoji)).toEqual(['👍', '🎉']);
  });

  test('deleting the document removes its reactions', () => {
    deleteDocumentCascade(db, slug);
    expect(db.select().from(commentReactions).all()).toEqual([]);
    expect(db.select().from(comments).all()).toEqual([]);
  });
});
