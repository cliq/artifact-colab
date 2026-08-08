// @vitest-environment node
//
// `happy-dom` (this project's default test environment) intentionally strips
// the `Set-Cookie` header from every `Response` it constructs, mimicking
// browser privacy rules — which makes cookie-based auth impossible to
// observe through `app.request()`. Running this file under Node's native
// fetch implementation avoids that.

/**
 * Integration tests for the auth layer: login codes, sessions, CSRF
 * double-submit protection, and personal access tokens. Exercised through
 * `app.request()` (in-process fetch) against a real, in-memory database —
 * the same code path a real HTTP request would take.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApp } from '../../src/server/app.js';
import { createSession, createToken, getOrCreateUser, sha256hex } from '../../src/server/auth.js';
import type { Config } from '../../src/server/config.js';
import type { AppEnv } from '../../src/server/context.js';
import { loginCodes, openDb, sessions, type DB } from '../../src/server/db/index.js';
import { bearerAuth } from '../../src/server/middleware.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

describe('auth', () => {
  let tmpDir: string;
  let codeFile: string;
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let config: Config;
  let app: Hono<AppEnv>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-auth-'));
    codeFile = join(tmpDir, 'codes.log');
    writeFileSync(codeFile, '');

    const opened = openDb(':memory:');
    db = opened.db;
    sqlite = opened.sqlite;
    seedTeamWithDomain(db, 'team-example', 'example.com');

    config = baseTestConfig({ devLoginCodeFile: codeFile });

    app = createApp({ db, config });
  });

  afterAll(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function lastCodeFor(email: string): string {
    const lines = readFileSync(codeFile, 'utf8').trim().split('\n').filter(Boolean);
    const match = lines.filter((line) => line.startsWith(`${email} `)).pop();
    if (!match) {
      throw new Error(`no login code recorded for ${email}`);
    }
    return match.split(' ')[1];
  }

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

  async function requestCode(email: string): Promise<Response> {
    return app.request('/auth/request-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  }

  async function verifyCode(email: string, code: string): Promise<Response> {
    return app.request('/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
  }

  async function getCsrfCookie(): Promise<string> {
    const res = await app.request('/healthz');
    const csrf = setCookieValue(res, 'csrf');
    if (!csrf) {
      throw new Error('expected csrfProtect to issue a csrf cookie on GET /healthz');
    }
    return csrf;
  }

  test('happy path: request a code, verify it, and use the session to mint and revoke a token', async () => {
    const email = 'alice@example.com';

    const requestRes = await requestCode(email);
    expect(requestRes.status).toBe(200);
    expect(await requestRes.json()).toEqual({ ok: true });

    const code = lastCodeFor(email);
    expect(code).toMatch(/^\d{6}$/);

    const verifyRes = await verifyCode(email, code);
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.json()).toEqual({ ok: true, redirect: '/' });

    const sessionCookie = setCookieValue(verifyRes, 'session');
    expect(sessionCookie).toBeDefined();

    const csrf = await getCsrfCookie();
    const authedHeaders = {
      'content-type': 'application/json',
      cookie: `session=${sessionCookie}; csrf=${csrf}`,
      'x-csrf-token': csrf,
    };

    const createRes = await app.request('/tokens', {
      method: 'POST',
      headers: authedHeaders,
      body: JSON.stringify({ label: 'my token' }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; token: string };
    expect(created.token).toMatch(/^acp_[0-9a-f]{64}$/);
    expect(typeof created.id).toBe('string');

    const revokeRes = await app.request(`/tokens/${created.id}`, {
      method: 'DELETE',
      headers: authedHeaders,
    });
    expect(revokeRes.status).toBe(200);
    expect(await revokeRes.json()).toEqual({ ok: true });

    const revokeAgainRes = await app.request(`/tokens/${created.id}`, {
      method: 'DELETE',
      headers: authedHeaders,
    });
    expect(await revokeAgainRes.json()).toEqual({ ok: false });
  });

  test('a mutating request without a matching csrf token is rejected', async () => {
    const res = await app.request('/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'no csrf' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid csrf token' });
  });

  test('entering the wrong code repeatedly locks the login code', async () => {
    const email = 'bob@example.com';
    await requestCode(email);
    const code = lastCodeFor(email);
    const wrongCode = code === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await verifyCode(email, wrongCode);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid' });
    }

    const lockedRes = await verifyCode(email, wrongCode);
    expect(lockedRes.status).toBe(400);
    expect(await lockedRes.json()).toEqual({ error: 'locked' });
  });

  test('an expired code is rejected', async () => {
    const email = 'carol@example.com';
    const now = new Date();

    db.insert(loginCodes)
      .values({
        id: 'expired-code-1',
        email,
        codeHash: sha256hex('123456'),
        expiresAt: new Date(now.getTime() - 1000),
        attempts: 0,
        createdAt: new Date(now.getTime() - 20 * 60 * 1000),
      })
      .run();

    const res = await verifyCode(email, '123456');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'expired' });
  });

  test('a disallowed domain gets the same generic response and never generates a code', async () => {
    const email = 'dave@not-allowed.com';

    const res = await requestCode(email);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(() => lastCodeFor(email)).toThrow();
  });

  test('rate limits login code requests to 10 per hour', async () => {
    const email = 'erin@example.com';

    for (let i = 0; i < 10; i++) {
      const res = await requestCode(email);
      expect(res.status).toBe(200);
    }

    const res = await requestCode(email);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
  });

  test('an expired session is rejected on session-protected routes', async () => {
    const email = 'grace@example.com';
    const now = new Date();
    const user = getOrCreateUser(db, email, now);
    const { token } = createSession(db, user.id, now);

    db.update(sessions).set({ expiresAt: new Date(now.getTime() - 1000) }).where(eq(sessions.userId, user.id)).run();

    const csrf = await getCsrfCookie();
    const res = await app.request('/tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `session=${token}; csrf=${csrf}`,
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ label: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('GET / redirects unauthenticated visitors to /signin with a next param', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/signin?next=%2F');
  });

  test('verify-code ignores an off-site next (open-redirect payload) and lands on /', async () => {
    const email = 'heidi@example.com';
    await requestCode(email);
    const code = lastCodeFor(email);

    // "/\evil.com" passes a naive startsWith('/') check but browsers resolve
    // it to https://evil.com — the validator must drop it back to "/".
    const res = await app.request('/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code, next: '/\\evil.com' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redirect: '/' });
  });

  describe('bearer auth (personal access tokens)', () => {
    test('a valid PAT authenticates; missing/invalid tokens get 401 with a bare WWW-Authenticate: Bearer', async () => {
      const email = 'frank@example.com';
      const now = new Date();
      const user = getOrCreateUser(db, email, now);
      const { plaintext } = createToken(db, user.id, 'team-example', 'ci', now);

      const probeApp = new Hono<AppEnv>();
      probeApp.use('*', async (c, next) => {
        c.set('db', db);
        c.set('config', config);
        await next();
      });
      probeApp.get('/probe', bearerAuth(), (c) => c.json({ userId: c.get('user').id }));

      const ok = await probeApp.request('/probe', { headers: { authorization: `Bearer ${plaintext}` } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ userId: user.id });

      const missing = await probeApp.request('/probe');
      expect(missing.status).toBe(401);
      expect(missing.headers.get('www-authenticate')).toBe('Bearer');
      expect(await missing.json()).toEqual({ error: 'invalid or missing token' });

      const bad = await probeApp.request('/probe', { headers: { authorization: 'Bearer acp_not-a-real-token' } });
      expect(bad.status).toBe(401);
      expect(bad.headers.get('www-authenticate')).toBe('Bearer');
    });
  });
});

describe('dev fixed login code (DEV_LOGIN_CODE)', () => {
  function buildApp(devLoginCode?: string) {
    const { db } = openDb(':memory:');
    seedTeamWithDomain(db, 'team-example', 'example.com');
    const config: Config = baseTestConfig({ devLoginCode });
    return createApp({ db, config });
  }

  async function verify(app: Hono<AppEnv>, email: string, code: string) {
    return app.request('/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
  }

  test('accepts the fixed code without any code having been requested', async () => {
    const app = buildApp('123456');
    const res = await verify(app, 'dev@example.com', '123456');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('session=');
  });

  test('still rejects disallowed domains', async () => {
    const app = buildApp('123456');
    const res = await verify(app, 'dev@not-allowed.com', '123456');
    expect(res.status).toBe(400);
  });

  test('other codes still go through normal verification', async () => {
    const app = buildApp('123456');
    const res = await verify(app, 'dev@example.com', '654321');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid' });
  });

  test('fixed code is rejected when DEV_LOGIN_CODE is unset', async () => {
    const app = buildApp(undefined);
    const res = await verify(app, 'dev@example.com', '123456');
    expect(res.status).toBe(400);
  });
});
