// @vitest-environment node

/**
 * Integration tests for the artifact frame route's isolation headers. The
 * parent page's <iframe sandbox> only protects the framed view — the response
 * itself must carry a CSP `sandbox` directive so a direct visit to
 * /d/:slug/frame can't run publisher HTML on the app origin.
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';

import { createApp } from '../../src/server/app.js';
import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import { documents, openDb, versions, type DB } from '../../src/server/db/index.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

describe('GET /d/:slug/frame', () => {
  let db: DB;
  let app: Hono<AppEnv>;
  let cookie: string;

  beforeAll(() => {
    const opened = openDb(':memory:');
    db = opened.db;
    seedTeamWithDomain(db, 'team-example', 'example.com');
    app = createApp({ db, config: baseTestConfig() });

    const now = new Date();
    const user = getOrCreateUser(db, 'alice@example.com', now);
    cookie = `session=${createSession(db, user.id, now).token}`;

    db.insert(documents)
      .values({ id: 'doc-1', title: 'Doc', teamId: 'team-example', createdBy: user.id, createdAt: now })
      .run();
    db.insert(versions)
      .values({ id: 'ver-1', documentId: 'doc-1', number: 1, html: '<body><p>hi</p></body>', publishedAt: now })
      .run();
    db.update(documents).set({ currentVersionId: 'ver-1' }).where(eq(documents.id, 'doc-1')).run();
  });

  test('CSP sandboxes the document itself, not just the parent iframe', async () => {
    const res = await app.request('/d/doc-1/frame', { headers: { cookie } });
    expect(res.status).toBe(200);

    const csp = res.headers.get('content-security-policy') ?? '';
    const directives = csp.split(';').map((d) => d.trim());
    expect(directives).toContain('sandbox allow-scripts');
    expect(directives).toContain(`default-src 'none'`);
  });

  test('still redirects anonymous visitors to sign-in', async () => {
    const res = await app.request('/d/doc-1/frame');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/signin');
  });
});
