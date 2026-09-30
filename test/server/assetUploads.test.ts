// @vitest-environment node

/**
 * Staged asset uploads: prepare_asset_upload over MCP, the raw PUT to the
 * one-time URL (no bearer), and publish_artifact claiming the files through
 * `upload_ids` into a single version.
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';

import { createApp } from '../../src/server/app.js';
import { createToken, getOrCreateUser, revokeToken } from '../../src/server/auth.js';
import type { Config } from '../../src/server/config.js';
import type { AppEnv } from '../../src/server/context.js';
import { assets, assetUploads, openDb, versions, type DB } from '../../src/server/db/index.js';
import { MAX_ASSET_BYTES } from '../../src/server/services/assets.js';
import { sweepExpiredUploads, UPLOAD_TTL_MS } from '../../src/server/services/assetUploads.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('asset uploads', () => {
  let db: DB;
  let app: Hono<AppEnv>;
  let pat: string;
  let otherPat: string;
  let userId: string;
  let rpcId = 0;

  beforeAll(() => {
    db = openDb(':memory:').db;
    const config: Config = baseTestConfig({ baseUrl: 'http://colab.example.com' });
    seedTeamWithDomain(db, 'team-example', 'example.com');
    app = createApp({ db, config });
    const user = getOrCreateUser(db, 'dana@example.com', new Date());
    userId = user.id;
    pat = createToken(db, user.id, 'team-example', 'uploads', new Date()).plaintext;
    otherPat = createToken(db, user.id, 'team-example', 'other agent', new Date()).plaintext;
  });

  async function callTool(name: string, args: unknown, token = pat): Promise<any> {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const payload = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? JSON.parse(text.split('\n').filter((l) => l.startsWith('data:')).pop()!.slice(5))
      : JSON.parse(text);
    expect(payload.error, JSON.stringify(payload.error)).toBeUndefined();
    return payload.result;
  }

  /** Stage files and return their upload ids and URLs, in order. */
  async function prepare(files: { name: string; mime_type: string }[], token = pat): Promise<{ id: string; url: string }[]> {
    const result = await callTool('prepare_asset_upload', { files }, token);
    expect(result.isError, result.content[0].text).toBeFalsy();
    const text = result.content[0].text as string;
    const ids = [...text.matchAll(/upload_id (\S+)/g)].map((m) => m[1]!);
    const urls = [...text.matchAll(/'(http:\/\/colab\.example\.com\/api\/uploads\/[^']+)'/g)].map((m) => m[1]!);
    expect(ids).toHaveLength(files.length);
    expect(urls).toHaveLength(files.length);
    return ids.map((id, i) => ({ id, url: urls[i]! }));
  }

  async function put(url: string, body: Buffer): Promise<Response> {
    return app.request(new URL(url).pathname, { method: 'PUT', body: new Uint8Array(body) });
  }

  const docIdOf = (result: any): string => (result.content[0].text as string).match(/document_id: (\w+)/)![1]!;

  test('prepare, PUT, and publish lands every file in one version', async () => {
    const [one, two] = await prepare([
      { name: 'shots/one.png', mime_type: 'image/png' },
      { name: 'shots/two.png', mime_type: 'image/png' },
    ]);
    expect((await put(one!.url, PNG_BYTES)).status).toBe(200);
    const second = await put(two!.url, PNG_BYTES);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ name: 'shots/two.png', size: PNG_BYTES.length });

    const result = await callTool('publish_artifact', {
      title: 'Uploaded shots',
      html: '<img src="shots/one.png"><img src="shots/two.png">',
      upload_ids: [one!.id, two!.id],
    });
    expect(result.isError, result.content[0].text).toBeFalsy();
    const docId = docIdOf(result);
    expect(db.select().from(versions).where(eq(versions.documentId, docId)).all()).toHaveLength(1);
    const stored = db.select().from(assets).where(eq(assets.documentId, docId)).all();
    expect(stored.map((a) => a.name).sort()).toEqual(['shots/one.png', 'shots/two.png']);
    expect(stored.every((a) => a.mime === 'image/png' && a.data.equals(PNG_BYTES))).toBe(true);

    // Claimed: the ids are gone and cannot be published again.
    const again = await callTool('publish_artifact', { title: 'Again', html: '<p>x</p>', upload_ids: [one!.id] });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain('unknown or expired upload id');
  });

  test('uploads combine with inline assets, but not under the same name', async () => {
    const [shot] = await prepare([{ name: 'big.png', mime_type: 'image/png' }]);
    await put(shot!.url, PNG_BYTES);
    const clash = await callTool('publish_artifact', {
      title: 'Clash',
      html: '<img src="big.png">',
      assets: [{ name: 'big.png', mime_type: 'image/png', data_base64: PNG_BYTES.toString('base64') }],
      upload_ids: [shot!.id],
    });
    expect(clash.isError).toBe(true);
    expect(clash.content[0].text).toContain('given more than once');

    const mixed = await callTool('publish_artifact', {
      title: 'Mixed',
      html: '<img src="big.png"><img src="small.png">',
      assets: [{ name: 'small.png', mime_type: 'image/png', data_base64: PNG_BYTES.toString('base64') }],
      upload_ids: [shot!.id],
    });
    expect(mixed.isError, mixed.content[0].text).toBeFalsy();
    const stored = db.select().from(assets).where(eq(assets.documentId, docIdOf(mixed))).all();
    expect(stored.map((a) => a.name).sort()).toEqual(['big.png', 'small.png']);
  });

  test('a failed publish leaves the upload usable', async () => {
    const [shot] = await prepare([{ name: 'keep.png', mime_type: 'image/png' }]);
    await put(shot!.url, PNG_BYTES);
    const failed = await callTool('publish_artifact', {
      title: 'Nope',
      html: '<img src="keep.png">',
      document_id: 'does-not-exist',
      upload_ids: [shot!.id],
    });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain('unknown document_id');

    const retried = await callTool('publish_artifact', { title: 'Yes', html: '<img src="keep.png">', upload_ids: [shot!.id] });
    expect(retried.isError, retried.content[0].text).toBeFalsy();
  });

  test('publishing before the file is PUT says so', async () => {
    const [shot] = await prepare([{ name: 'later.png', mime_type: 'image/png' }]);
    const early = await callTool('publish_artifact', { title: 'Early', html: '<p>x</p>', upload_ids: [shot!.id] });
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toContain('has no file yet');
  });

  test('each URL takes one file', async () => {
    const [shot] = await prepare([{ name: 'once.png', mime_type: 'image/png' }]);
    expect((await put(shot!.url, PNG_BYTES)).status).toBe(200);
    const second = await put(shot!.url, PNG_BYTES);
    expect(second.status).toBe(409);
  });

  test('rejects empty, oversized, and unknown uploads', async () => {
    const [shot] = await prepare([{ name: 'size.png', mime_type: 'image/png' }]);
    expect((await put(shot!.url, Buffer.alloc(0))).status).toBe(400);
    const tooBig = await put(shot!.url, Buffer.alloc(MAX_ASSET_BYTES + 1));
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error).toContain('4 MB');
    // Still usable after the rejected attempts; a full 4 MB file fits.
    expect((await put(shot!.url, Buffer.alloc(MAX_ASSET_BYTES, 1))).status).toBe(200);

    expect((await put('http://colab.example.com/api/uploads/not-a-real-id', PNG_BYTES)).status).toBe(404);
  });

  test('a file larger than the default body limit still uploads', async () => {
    const [shot] = await prepare([{ name: 'two-mb.png', mime_type: 'image/png' }]);
    expect((await put(shot!.url, Buffer.alloc(2 * 1024 * 1024, 7))).status).toBe(200);
  });

  test('ids only publish through the token that prepared them', async () => {
    const [shot] = await prepare([{ name: 'mine.png', mime_type: 'image/png' }]);
    await put(shot!.url, PNG_BYTES);
    const stolen = await callTool('publish_artifact', { title: 'Other', html: '<p>x</p>', upload_ids: [shot!.id] }, otherPat);
    expect(stolen.isError).toBe(true);
    expect(stolen.content[0].text).toContain('unknown or expired upload id');
  });

  test('revoking the token closes its upload URLs', async () => {
    const created = createToken(db, userId, 'team-example', 'short-lived', new Date());
    const [shot] = await prepare([{ name: 'gone.png', mime_type: 'image/png' }], created.plaintext);
    expect(revokeToken(db, userId, created.id)).toBe(true);
    expect((await put(shot!.url, PNG_BYTES)).status).toBe(404);
  });

  test('rejects bad and duplicate names up front', async () => {
    const bad = await callTool('prepare_asset_upload', { files: [{ name: '../x.png', mime_type: 'image/png' }] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('invalid asset name');
    const dup = await callTool('prepare_asset_upload', {
      files: [
        { name: 'a.png', mime_type: 'image/png' },
        { name: 'a.png', mime_type: 'image/png' },
      ],
    });
    expect(dup.isError).toBe(true);
  });

  test('expired uploads are refused and swept', async () => {
    const [shot] = await prepare([{ name: 'old.png', mime_type: 'image/png' }]);
    await put(shot!.url, PNG_BYTES);
    const later = new Date(Date.now() + UPLOAD_TTL_MS + 1000);
    expect(sweepExpiredUploads(db, later)).toBeGreaterThan(0);
    expect(db.select().from(assetUploads).all()).toHaveLength(0);
    const result = await callTool('publish_artifact', { title: 'Late', html: '<p>x</p>', upload_ids: [shot!.id] });
    expect(result.isError).toBe(true);
  });

  test('the inline cap error points at prepare_asset_upload', async () => {
    const result = await callTool('publish_artifact', {
      title: 'Too big inline',
      html: '<img src="huge.png">',
      assets: [{ name: 'huge.png', mime_type: 'image/png', data_base64: Buffer.alloc(1024 * 1024 + 1).toString('base64') }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('prepare_asset_upload');
    expect(result.content[0].text).toContain('"name":"huge.png"');
  });
});
