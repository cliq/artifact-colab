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
import { assets, assetUploads, documents, openDb, versions, type DB } from '../../src/server/db/index.js';
import { MAX_ASSET_BYTES } from '../../src/server/services/assets.js';
import { MAX_PENDING_UPLOADS_PER_USER, sweepExpiredUploads, UPLOAD_TTL_MS } from '../../src/server/services/assetUploads.js';
import { publishArtifact } from '../../src/server/services/publish.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('asset uploads', () => {
  let db: DB;
  let sqlite: ReturnType<typeof openDb>['sqlite'];
  let config: Config;
  let app: Hono<AppEnv>;
  let pat: string;
  let otherPat: string;
  let userId: string;
  let rpcId = 0;

  beforeAll(() => {
    ({ db, sqlite } = openDb(':memory:'));
    config = baseTestConfig({ baseUrl: 'http://colab.example.com' });
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

  /** A chunked body (no content-length) that records how much of it the server pulled. */
  function trackedStream(chunks: Uint8Array[], beforeClose?: () => void): { body: ReadableStream<Uint8Array>; pulled: () => number } {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[pulled];
        if (next) {
          pulled++;
          controller.enqueue(next);
        } else {
          beforeClose?.();
          controller.close();
        }
      },
    });
    return { body, pulled: () => pulled };
  }

  function putStream(url: string, body: ReadableStream<Uint8Array>): Promise<Response> {
    return Promise.resolve(app.request(new URL(url).pathname, { method: 'PUT', body, duplex: 'half' } as RequestInit));
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

  test('a publish that throws after claiming its uploads rolls the claim back', async () => {
    const [shot] = await prepare([{ name: 'rollback.png', mime_type: 'image/png' }]);
    await put(shot!.url, PNG_BYTES);
    const tokenId = db.select().from(assetUploads).all().find((u) => u.name === 'rollback.png')!.tokenId;
    const user = getOrCreateUser(db, 'dana@example.com', new Date());
    const documentsBefore = db.select().from(documents).all().length;
    // autoWatch runs after claimUploads, so failing it lands after the claim.
    sqlite.exec(`CREATE TRIGGER fail_upload_publish BEFORE INSERT ON watches BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
    try {
      expect(() =>
        publishArtifact(db, config, user, 'team-example', {
          title: 'Will fail',
          html: '<img src="rollback.png">',
          uploads: { tokenId, ids: [shot!.id] },
        }),
      ).toThrow('forced failure');
    } finally {
      sqlite.exec('DROP TRIGGER fail_upload_publish');
    }
    expect(db.select().from(documents).all()).toHaveLength(documentsBefore);
    expect(db.select().from(assetUploads).all().some((u) => u.name === 'rollback.png' && u.data !== null)).toBe(true);
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

  test('an unknown URL is refused before any of the body is read', async () => {
    const stream = trackedStream([new Uint8Array(1024 * 1024), new Uint8Array(1024 * 1024)]);
    const res = await putStream('http://colab.example.com/api/uploads/not-a-real-id', stream.body);
    expect(res.status).toBe(404);
    expect(stream.pulled()).toBeLessThanOrEqual(1);
  });

  test('a used URL is refused before any of the body is read', async () => {
    const [shot] = await prepare([{ name: 'used.png', mime_type: 'image/png' }]);
    await put(shot!.url, PNG_BYTES);
    const stream = trackedStream([new Uint8Array(1024 * 1024), new Uint8Array(1024 * 1024)]);
    expect((await putStream(shot!.url, stream.body)).status).toBe(409);
    expect(stream.pulled()).toBeLessThanOrEqual(1);
  });

  test('a streamed chunked upload lands', async () => {
    const [shot] = await prepare([{ name: 'chunked.png', mime_type: 'image/png' }]);
    const stream = trackedStream([PNG_BYTES.subarray(0, 10), PNG_BYTES.subarray(10)]);
    const res = await putStream(shot!.url, stream.body);
    expect(res.status).toBe(200);
    expect((await res.json()).size).toBe(PNG_BYTES.length);
  });

  test('revoking the token while the body streams discards the upload', async () => {
    const created = createToken(db, userId, 'team-example', 'mid-stream', new Date());
    const [shot] = await prepare([{ name: 'mid.png', mime_type: 'image/png' }], created.plaintext);
    const stream = trackedStream([PNG_BYTES], () => revokeToken(db, userId, created.id));
    expect((await putStream(shot!.url, stream.body)).status).toBe(404);
  });

  test('an expired upload is refused even before the sweep runs', async () => {
    const [shot] = await prepare([{ name: 'stale.png', mime_type: 'image/png' }]);
    await put(shot!.url, PNG_BYTES);
    const [other] = await prepare([{ name: 'stale-empty.png', mime_type: 'image/png' }]);
    db.update(assetUploads).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    expect(db.select().from(assetUploads).all().length).toBeGreaterThanOrEqual(2);

    expect((await put(other!.url, PNG_BYTES)).status).toBe(404);
    const result = await callTool('publish_artifact', { title: 'Stale', html: '<p>x</p>', upload_ids: [shot!.id] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown or expired upload id');
    sweepExpiredUploads(db, new Date());
  });

  test('duplicate ids, and the same name staged twice, are refused at publish', async () => {
    const [first] = await prepare([{ name: 'same.png', mime_type: 'image/png' }]);
    const [second] = await prepare([{ name: 'same.png', mime_type: 'image/png' }]);
    await put(first!.url, PNG_BYTES);
    await put(second!.url, PNG_BYTES);

    const dupIds = await callTool('publish_artifact', { title: 'Dup', html: '<p>x</p>', upload_ids: [first!.id, first!.id] });
    expect(dupIds.isError).toBe(true);
    expect(dupIds.content[0].text).toContain('each upload id may appear only once');

    const dupNames = await callTool('publish_artifact', { title: 'Dup', html: '<p>x</p>', upload_ids: [first!.id, second!.id] });
    expect(dupNames.isError).toBe(true);
    expect(dupNames.content[0].text).toContain('given more than once');
  });

  test('uploads and inline assets together stay under the 20 MB publish cap', async () => {
    const staged = await prepare([1, 2, 3, 4, 5].map((n) => ({ name: `full-${n}.png`, mime_type: 'image/png' })));
    for (const upload of staged) expect((await put(upload.url, Buffer.alloc(MAX_ASSET_BYTES, 3))).status).toBe(200);
    const result = await callTool('publish_artifact', {
      title: 'Over',
      html: '<p>x</p>',
      assets: [{ name: 'extra.png', mime_type: 'image/png', data_base64: PNG_BYTES.toString('base64') }],
      upload_ids: staged.map((u) => u.id),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('20 MB total cap');
    // Still claimable once the extra file is dropped.
    const fits = await callTool('publish_artifact', { title: 'Fits', html: '<p>x</p>', upload_ids: staged.map((u) => u.id) });
    expect(fits.isError, fits.content[0].text).toBeFalsy();
  });

  test('the pending quota is per user, and revoked tokens stop counting', async () => {
    const quotaUser = getOrCreateUser(db, 'quota@example.com', new Date());
    const first = createToken(db, quotaUser.id, 'team-example', 'first', new Date());
    const second = createToken(db, quotaUser.id, 'team-example', 'second', new Date());
    const files = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}-${i}.png`, mime_type: 'image/png' }));

    await prepare(files('a', 25), first.plaintext);
    await prepare(files('b', 25), second.plaintext);
    const over = await callTool('prepare_asset_upload', { files: files('c', 1) }, second.plaintext);
    expect(over.isError).toBe(true);
    expect(over.content[0].text).toContain(`max ${MAX_PENDING_UPLOADS_PER_USER}`);

    // Revoking a token frees its slots and drops its staged rows on the next prepare.
    revokeToken(db, quotaUser.id, first.id);
    await prepare(files('d', 25), second.plaintext);
    expect(db.select().from(assetUploads).where(eq(assetUploads.tokenId, first.id)).all()).toHaveLength(0);
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
