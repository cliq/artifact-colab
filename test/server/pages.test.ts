// @vitest-environment node
//
// Same rationale as `test/server/auth.test.ts`: happy-dom (this project's
// default test environment) strips `Set-Cookie` from every `Response`, which
// breaks cookie-based session/CSRF assertions. Running under Node's native
// fetch avoids that.

/**
 * Integration tests for the server-rendered pages: the document list,
 * sign-in, and token settings screens, exercised through `app.request()`
 * against a real in-memory database.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { Config } from '../../src/server/config.js';
import type { AppEnv } from '../../src/server/context.js';
import { documents, openDb, tokens, versions, type DB } from '../../src/server/db/index.js';
import { csrfProtect } from '../../src/server/middleware.js';
import { pageRoutes } from '../../src/server/routes/pages.js';
import { getUserTeams } from '../../src/server/services/teams.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

describe('pages', () => {
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let config: Config;
  let app: Hono<AppEnv>;

  beforeAll(() => {
    const opened = openDb(':memory:');
    db = opened.db;
    sqlite = opened.sqlite;

    config = baseTestConfig();
    seedTeamWithDomain(db, 'team-example', 'example.com');
    seedTeamWithDomain(db, 'team-other', 'other.com');

    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('config', config);
      await next();
    });
    app.use('*', csrfProtect());
    app.route('/', pageRoutes);
  });

  afterAll(() => {
    sqlite.close();
  });

  function setCookieValue(res: Response, name: string): string | undefined {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [key, value] = pair.split('=');
      if (key === name) {
        return value;
      }
    }
    return undefined;
  }

  async function getCsrfCookie(): Promise<string> {
    const res = await app.request('/signin');
    const csrf = setCookieValue(res, 'csrf');
    if (!csrf) {
      throw new Error('expected csrfProtect to issue a csrf cookie on GET /signin');
    }
    return csrf;
  }

  async function signedInSession(email: string): Promise<{ userId: string; sessionCookie: string }> {
    const now = new Date();
    const user = getOrCreateUser(db, email, now);
    const { token } = createSession(db, user.id, now);
    return { userId: user.id, sessionCookie: token };
  }

  test('GET / unauthenticated redirects to /signin with a next param', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/signin?next=%2F');
  });

  test('GET / with a session shows documents from the user teams and hides other teams', async () => {
    const { userId, sessionCookie } = await signedInSession('alice@example.com');
    const otherUser = getOrCreateUser(db, 'bob@other.com', new Date());

    const docId = 'doc-1';
    db.insert(documents)
      .values({ id: docId, title: 'Q1 Roadmap', teamId: 'team-example', createdBy: userId, createdAt: new Date() })
      .run();
    db.insert(versions)
      .values({ id: 'v-1', documentId: docId, number: 1, html: '<p>hi</p>', publishedAt: new Date() })
      .run();

    const otherDocId = 'doc-other';
    db.insert(documents)
      .values({ id: otherDocId, title: 'Other Domain Doc', teamId: 'team-other', createdBy: otherUser.id, createdAt: new Date() })
      .run();
    db.insert(versions)
      .values({ id: 'v-2', documentId: otherDocId, number: 1, html: '<p>hi</p>', publishedAt: new Date() })
      .run();

    const res = await app.request('/', { headers: { cookie: `session=${sessionCookie}` } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Q1 Roadmap');
    expect(html).not.toContain('Other Domain Doc');
  });

  test('GET /signin renders the email form', async () => {
    const res = await app.request('/signin');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('email-form');
    expect(html).toContain('Sign in');
  });

  test('token settings: create shows plaintext once, list hides it afterward, delete removes it', async () => {
    const { sessionCookie } = await signedInSession('carol@example.com');
    const csrf = await getCsrfCookie();
    const authedHeaders = {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `session=${sessionCookie}; csrf=${csrf}`,
    };

    const createRes = await app.request('/settings/tokens', {
      method: 'POST',
      headers: authedHeaders,
      body: new URLSearchParams({ label: 'my token', _csrf: csrf }).toString(),
    });
    expect(createRes.status).toBe(200);
    const createdHtml = await createRes.text();
    expect(createdHtml).toMatch(/acp_[0-9a-f]{64}/);

    const listRes = await app.request('/settings/tokens', { headers: { cookie: `session=${sessionCookie}` } });
    expect(listRes.status).toBe(200);
    const listHtml = await listRes.text();
    expect(listHtml).not.toMatch(/acp_[0-9a-f]{64}/);
    expect(listHtml).toContain('my token');

    const allTokens = db.select().from(tokens).all();
    const created = allTokens.find((t) => t.label === 'my token');
    expect(created).toBeDefined();

    const deleteRes = await app.request(`/settings/tokens/${created!.id}/delete`, {
      method: 'POST',
      headers: authedHeaders,
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    expect(deleteRes.status).toBe(302);
    expect(deleteRes.headers.get('location')).toBe('/settings/tokens');

    const remaining = db.select().from(tokens).where(eq(tokens.id, created!.id)).all();
    expect(remaining).toHaveLength(0);
  });

  test('token settings: a teamless user gets a personal workspace created with their first token', async () => {
    const { userId, sessionCookie } = await signedInSession('solo@lonely.dev');
    const csrf = await getCsrfCookie();

    const createRes = await app.request('/settings/tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `session=${sessionCookie}; csrf=${csrf}`,
      },
      body: new URLSearchParams({ label: 'solo token', _csrf: csrf }).toString(),
    });
    expect(createRes.status).toBe(200);
    const html = await createRes.text();
    expect(html).toMatch(/acp_[0-9a-f]{64}/);

    const memberships = getUserTeams(db, userId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.team.name).toBe("solo's workspace");
    expect(memberships[0]!.role).toBe('admin');

    const created = db.select().from(tokens).all().find((t) => t.label === 'solo token');
    expect(created?.teamId).toBe(memberships[0]!.team.id);
  });

  test('GET /static/app.css serves CSS', async () => {
    const res = await app.request('/static/app.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    const body = await res.text();
    expect(body).toContain('--color-accent');
  });
});
