// @vitest-environment node
//
// Cookie-based auth needs Node's native fetch (see test/server/auth.test.ts
// for why happy-dom can't observe Set-Cookie / cookie headers).

/**
 * Profile page + avatars: the display name round-trips through the settings
 * form (empty by default, clearable), and comment threads carry the author's
 * name and Gravatar URL.
 */

import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { describeTextAnchor } from '../../src/anchoring/text.js';
import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import { documents, openDb, users, versions, type DB } from '../../src/server/db/index.js';
import { csrfProtect, sessionAuth } from '../../src/server/middleware.js';
import { apiRoutes } from '../../src/server/routes/api.js';
import { pageRoutes } from '../../src/server/routes/pages.js';
import { indexVersionHtml } from '../../src/server/services/anchorStates.js';
import { gravatarUrl } from '../../src/server/services/gravatar.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const QUOTE = 'A memorable sentence to anchor to.';
const HTML = `<body><p>${QUOTE}</p></body>`;

describe('profile & avatars', () => {
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let app: Hono<AppEnv>;
  let userId: string;
  let cookieHeader: string;
  let csrf: string;

  const slug = 'profile-doc';

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
    app.use('*', csrfProtect());
    app.use('/api/*', sessionAuth({ redirect: false }));
    app.route('/', apiRoutes);
    app.route('/', pageRoutes);

    const now = new Date();
    const user = getOrCreateUser(db, 'alice@example.com', now);
    userId = user.id;
    const session = createSession(db, user.id, now).token;

    const csrfRes = await app.request('/signin');
    csrf = csrfRes.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0]!.split('='))
      .find(([k]) => k === 'csrf')?.[1] as string;
    cookieHeader = `session=${session}; csrf=${csrf}`;

    db.insert(documents).values({ id: slug, title: 'Doc', teamId: 'team-example', createdBy: user.id, createdAt: now }).run();
    db.insert(versions).values({ id: 'v-1', documentId: slug, number: 1, html: HTML, publishedAt: now }).run();
    db.update(documents).set({ currentVersionId: 'v-1' }).where(eq(documents.id, slug)).run();
  });

  afterAll(() => {
    sqlite.close();
  });

  function postForm(path: string, fields: Record<string, string>) {
    return app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader },
      body: new URLSearchParams({ ...fields, _csrf: csrf }).toString(),
    });
  }

  test('gravatarUrl is the sha256 of the normalized email', () => {
    const hash = createHash('sha256').update('alice@example.com').digest('hex');
    expect(gravatarUrl('  Alice@Example.COM ')).toBe(`https://gravatar.com/avatar/${hash}?d=mp&s=80`);
  });

  test('the profile page starts with an empty name', async () => {
    const res = await app.request('/settings/profile', { headers: { cookie: cookieHeader } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Display name');
    expect(html).toMatch(/name="name" value=""/);
    // JSX escapes the & in the query string.
    expect(html).toContain(gravatarUrl('alice@example.com').replace('&', '&amp;'));
  });

  test('saving a name persists it; comments carry name and avatar', async () => {
    const save = await postForm('/settings/profile', { name: '  Alice Cooper  ' });
    expect(save.status).toBe(302);
    expect(db.select().from(users).where(eq(users.id, userId)).get()?.name).toBe('Alice Cooper');

    const anchorText = indexVersionHtml(HTML);
    const start = anchorText.indexOf(QUOTE);
    const commentRes = await app.request(`/api/docs/${slug}/comments`, {
      method: 'POST',
      headers: { cookie: cookieHeader, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({
        body: 'first!',
        quotedText: QUOTE,
        anchor: describeTextAnchor(anchorText, start, start + QUOTE.length),
        versionId: 'v-1',
      }),
    });
    expect(commentRes.status).toBe(201);
    const created = (await commentRes.json()) as { author: { email: string; name: string | null; avatarUrl: string } };
    expect(created.author).toEqual({
      email: 'alice@example.com',
      name: 'Alice Cooper',
      avatarUrl: gravatarUrl('alice@example.com'),
      isGuest: false,
    });
  });

  test('clearing the name falls back to null (clients show the email)', async () => {
    const save = await postForm('/settings/profile', { name: '   ' });
    expect(save.status).toBe(302);
    expect(db.select().from(users).where(eq(users.id, userId)).get()?.name).toBeNull();

    const list = await app.request(`/api/docs/${slug}/comments`, { headers: { cookie: cookieHeader } });
    const payload = (await list.json()) as { comments: { author: { name: string | null } }[] };
    expect(payload.comments[0]?.author.name).toBeNull();
  });
});
