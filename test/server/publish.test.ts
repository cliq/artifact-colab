// @vitest-environment node

/**
 * Integration tests for the bearer-authed REST endpoints agents use for
 * artifacts too large to pass through an MCP tool call: POST /api/publish
 * (multipart upload, same semantics as the publish_artifact tool) and
 * GET /api/docs/:slug/raw (stored HTML source download).
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';

import { createApp } from '../../src/server/app.js';
import { createToken, getOrCreateUser } from '../../src/server/auth.js';
import type { Config } from '../../src/server/config.js';
import type { AppEnv } from '../../src/server/context.js';
import { assets, openDb, versions, type DB } from '../../src/server/db/index.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

// 1x1 transparent PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_B64, 'base64');

describe('POST /api/publish', () => {
  let db: DB;
  let app: Hono<AppEnv>;
  let pat: string;

  beforeAll(() => {
    const opened = openDb(':memory:');
    db = opened.db;
    const config: Config = baseTestConfig({ baseUrl: 'http://colab.example.com' });
    seedTeamWithDomain(db, 'team-example', 'example.com');
    seedTeamWithDomain(db, 'team-evil', 'evil.com');
    app = createApp({ db, config });
    const user = getOrCreateUser(db, 'alice@example.com', new Date());
    pat = createToken(db, user.id, 'team-example', 'publish-test', new Date()).plaintext;
  });

  async function publish(form: FormData, token = pat): Promise<Response> {
    return await app.request('/api/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
  }

  test('rejects missing/bad bearer token', async () => {
    const form = new FormData();
    form.append('title', 'Nope');
    form.append('html', '<p>x</p>');

    const noAuth = await app.request('/api/publish', { method: 'POST', body: form });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toBe('Bearer');

    const badAuth = await publish(form, 'acp_definitelywrong');
    expect(badAuth.status).toBe(401);
  });

  test('publishes an html file part with assets, filename = reference name', async () => {
    const form = new FormData();
    form.append('title', 'Uploaded Report');
    form.append(
      'html',
      new File(['<body><h1>Report</h1><img src="shots/one.png"><img src="two.png"></body>'], 'artifact.html', {
        type: 'text/html',
      }),
    );
    form.append('assets', new File([PNG_BYTES], 'shots/one.png', { type: 'image/png' }));
    form.append('assets', new File([PNG_BYTES], 'two.png', { type: 'image/png' }));

    const res = await publish(form);
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.url).toBe(`http://colab.example.com/d/${payload.document_id}`);
    expect(payload.version).toBe(1);
    expect(payload.orphaned_comments).toBe(0);

    const stored = db.select().from(assets).where(eq(assets.documentId, payload.document_id)).all();
    expect(stored.map((a) => a.name).sort()).toEqual(['shots/one.png', 'two.png']);
    expect(stored[0]!.mime).toBe('image/png');
  });

  test('html with embedded data URIs publishes as-is, no assets needed', async () => {
    const html = `<body><img src="data:image/png;base64,${PNG_B64}"><p>Inline images survive.</p></body>`;
    const form = new FormData();
    form.append('title', 'Data URI artifact');
    form.append('html', new File([html], 'artifact.html', { type: 'text/html' }));

    const res = await publish(form);
    expect(res.status).toBe(200);
    const payload = await res.json();
    const stored = db.select().from(versions).where(eq(versions.documentId, payload.document_id)).get()!;
    expect(stored.html).toBe(html);
  });

  test('document_id field appends a new version', async () => {
    const first = new FormData();
    first.append('title', 'Doc');
    first.append('html', '<p>v1</p>');
    const docId = (await (await publish(first)).json()).document_id as string;

    const second = new FormData();
    second.append('title', 'Doc');
    second.append('html', '<p>v2</p>');
    second.append('document_id', docId);
    const res = await publish(second);
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.document_id).toBe(docId);
    expect(payload.version).toBe(2);
  });

  test('unknown document_id 404s, including other teams’ documents', async () => {
    const form = new FormData();
    form.append('title', 'X');
    form.append('html', '<p>x</p>');
    form.append('document_id', 'nope123456');
    expect((await publish(form)).status).toBe(404);

    const mine = new FormData();
    mine.append('title', 'Mine');
    mine.append('html', '<p>x</p>');
    const docId = (await (await publish(mine)).json()).document_id as string;

    const mallory = getOrCreateUser(db, 'mallory@evil.com', new Date());
    const malloryPat = createToken(db, mallory.id, 'team-evil', 'evil', new Date()).plaintext;
    const takeover = new FormData();
    takeover.append('title', 'Takeover');
    takeover.append('html', '<p>x</p>');
    takeover.append('document_id', docId);
    expect((await publish(takeover, malloryPat)).status).toBe(404);
  });

  test('validates title, html, asset names, and size caps', async () => {
    const noTitle = new FormData();
    noTitle.append('html', '<p>x</p>');
    expect((await publish(noTitle)).status).toBe(400);

    const noHtml = new FormData();
    noHtml.append('title', 'X');
    expect((await publish(noHtml)).status).toBe(400);

    const badName = new FormData();
    badName.append('title', 'X');
    badName.append('html', '<p>x</p>');
    badName.append('assets', new File([PNG_BYTES], '../escape.png', { type: 'image/png' }));
    const badNameRes = await publish(badName);
    expect(badNameRes.status).toBe(400);
    expect((await badNameRes.json()).error).toContain('invalid asset name');

    const oversizedAsset = new FormData();
    oversizedAsset.append('title', 'X');
    oversizedAsset.append('html', '<p>x</p>');
    oversizedAsset.append('assets', new File([Buffer.alloc(4 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }));
    const oversizedRes = await publish(oversizedAsset);
    expect(oversizedRes.status).toBe(400);
    expect((await oversizedRes.json()).error).toContain('4 MB');

    const oversizedHtml = new FormData();
    oversizedHtml.append('title', 'X');
    oversizedHtml.append('html', new File(['x'.repeat(5 * 1024 * 1024 + 1)], 'big.html', { type: 'text/html' }));
    const htmlRes = await publish(oversizedHtml);
    expect(htmlRes.status).toBe(400);
    expect((await htmlRes.json()).error).toContain('5 MB');
  });
});

describe('GET /api/docs/:slug/raw', () => {
  let db: DB;
  let app: Hono<AppEnv>;
  let pat: string;
  let docId: string;

  const V1 = '<body><p>raw v1</p></body>';
  const V2 = '<body><p>raw v2</p></body>';

  beforeAll(async () => {
    const opened = openDb(':memory:');
    db = opened.db;
    const config: Config = baseTestConfig({ baseUrl: 'http://colab.example.com' });
    seedTeamWithDomain(db, 'team-example', 'example.com');
    seedTeamWithDomain(db, 'team-evil', 'evil.com');
    app = createApp({ db, config });
    const user = getOrCreateUser(db, 'alice@example.com', new Date());
    pat = createToken(db, user.id, 'team-example', 'raw-test', new Date()).plaintext;

    for (const html of [V1, V2]) {
      const form = new FormData();
      form.append('title', 'Raw doc');
      form.append('html', html);
      if (docId) form.append('document_id', docId);
      const res = await app.request('/api/publish', {
        method: 'POST',
        headers: { authorization: `Bearer ${pat}` },
        body: form,
      });
      docId = (await res.json()).document_id;
    }
  });

  async function raw(path: string, token = pat): Promise<Response> {
    return app.request(path, { headers: { authorization: `Bearer ${token}` } });
  }

  test('rejects missing/bad bearer token', async () => {
    const noAuth = await app.request(`/api/docs/${docId}/raw`);
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toBe('Bearer');

    expect((await raw(`/api/docs/${docId}/raw`, 'acp_definitelywrong')).status).toBe(401);
  });

  test('serves the current version as published', async () => {
    const res = await raw(`/api/docs/${docId}/raw`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(V2);
  });

  test('serves an older version via ?version=', async () => {
    const res = await raw(`/api/docs/${docId}/raw?version=1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(V1);
  });

  test('rejects bad or missing versions', async () => {
    expect((await raw(`/api/docs/${docId}/raw?version=abc`)).status).toBe(400);
    expect((await raw(`/api/docs/${docId}/raw?version=0`)).status).toBe(400);
    expect((await raw(`/api/docs/${docId}/raw?version=99`)).status).toBe(404);
  });

  test('unknown slugs and other teams’ documents 404', async () => {
    expect((await raw('/api/docs/nope123456/raw')).status).toBe(404);

    const mallory = getOrCreateUser(db, 'mallory@evil.com', new Date());
    const malloryPat = createToken(db, mallory.id, 'team-evil', 'evil', new Date()).plaintext;
    expect((await raw(`/api/docs/${docId}/raw`, malloryPat)).status).toBe(404);
  });
});
