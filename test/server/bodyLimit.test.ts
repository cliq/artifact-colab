// @vitest-environment node

/**
 * Request body caps. csrfProtect buffers form bodies before any auth runs,
 * so unauthenticated requests must be size-limited or an anonymous POST could
 * hold an arbitrarily large body in memory. Publish surfaces get a higher cap
 * that still fits their documented payload limits.
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, test } from 'vitest';

import { createApp } from '../../src/server/app.js';
import { createToken, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import { openDb, type DB } from '../../src/server/db/index.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

describe('request body limits', () => {
  let db: DB;
  let app: Hono<AppEnv>;
  let pat: string;

  beforeAll(() => {
    const opened = openDb(':memory:');
    db = opened.db;
    seedTeamWithDomain(db, 'team-example', 'example.com');
    app = createApp({ db, config: baseTestConfig() });
    const user = getOrCreateUser(db, 'alice@example.com', new Date());
    pat = createToken(db, user.id, 'team-example', 'limit-test', new Date()).plaintext;
  });

  test('rejects an oversized unauthenticated body with 413 before any parsing', async () => {
    const res = await app.request('/auth/request-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"email":"a@example.com","pad":"${'x'.repeat(2 * 1024 * 1024)}"}`,
    });
    expect(res.status).toBe(413);
  });

  test('the publish endpoint accepts bodies above the default cap', async () => {
    const form = new FormData();
    form.append('title', 'Big artifact');
    form.append('html', `<body>${'x'.repeat(2 * 1024 * 1024)}</body>`);

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${pat}` },
      body: form,
    });
    expect(res.status).toBe(200);
  });

  test('the publish endpoint still caps runaway bodies with 413', async () => {
    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(41 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
  });
});
