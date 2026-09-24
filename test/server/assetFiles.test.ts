// @vitest-environment node

/**
 * Uploaded assets served at `/d/:slug/<name>`, where a relative link inside
 * the artifact lands when opened in a new tab. Read access mirrors the
 * document's; the response is sandboxed since assets can be any file type.
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';

import { createApp } from '../../src/server/app.js';
import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import { documents, openDb, versions, type DB } from '../../src/server/db/index.js';
import { upsertAssets } from '../../src/server/services/assets.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

describe('GET /d/:slug/<asset>', () => {
  let db: DB;
  let app: Hono<AppEnv>;
  let cookie: string;
  let outsiderCookie: string;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  beforeAll(() => {
    const opened = openDb(':memory:');
    db = opened.db;
    seedTeamWithDomain(db, 'team-example', 'example.com');
    app = createApp({ db, config: baseTestConfig() });

    const now = new Date();
    const user = getOrCreateUser(db, 'alice@example.com', now);
    const outsider = getOrCreateUser(db, 'eve@elsewhere.com', now);
    cookie = `session=${createSession(db, user.id, now).token}`;
    outsiderCookie = `session=${createSession(db, outsider.id, now).token}`;

    db.insert(documents).values({ id: 'doc-1', title: 'Doc', teamId: 'team-example', createdBy: user.id, createdAt: now }).run();
    db.insert(versions)
      .values({ id: 'ver-1', documentId: 'doc-1', number: 1, html: '<a href="shots/pic.jpg"><img src="shots/pic.jpg"></a>', publishedAt: now })
      .run();
    db.update(documents).set({ currentVersionId: 'ver-1' }).where(eq(documents.id, 'doc-1')).run();
    upsertAssets(db, 'doc-1', [
      { name: 'shots/pic.jpg', mime: 'image/jpeg', data: jpeg },
      { name: 'evil.svg', mime: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
    ], now);
  });

  test('serves the asset with its mime type, sandboxed', async () => {
    const res = await app.request('/d/doc-1/shots/pic.jpg', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(jpeg);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const directives = (res.headers.get('content-security-policy') ?? '').split(';').map((d) => d.trim());
    expect(directives).toContain('sandbox');
    expect(directives).toContain(`default-src 'none'`);
  });

  test('scriptable asset types get the same sandbox', async () => {
    const res = await app.request('/d/doc-1/evil.svg', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox;/);
  });

  test('unknown assets and people without read access get a 404', async () => {
    expect((await app.request('/d/doc-1/shots/missing.jpg', { headers: { cookie } })).status).toBe(404);
    expect((await app.request('/d/doc-1/shots/pic.jpg', { headers: { cookie: outsiderCookie } })).status).toBe(404);
    expect((await app.request('/d/nope/shots/pic.jpg', { headers: { cookie } })).status).toBe(404);
  });

  test('anonymous visitors are sent to sign-in', async () => {
    const res = await app.request('/d/doc-1/shots/pic.jpg');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/signin');
  });

  test('document routes keep precedence over asset paths', async () => {
    const res = await app.request('/d/doc-1/frame', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
