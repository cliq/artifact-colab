// @vitest-environment node

/**
 * Integration tests for the MCP endpoint, speaking JSON-RPC over the
 * Streamable HTTP transport through app.request() with a real PAT — the same
 * path an MCP client takes.
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, test } from 'vitest';

import { createApp } from '../../src/server/app.js';
import { createToken, getOrCreateUser } from '../../src/server/auth.js';
import type { Config } from '../../src/server/config.js';
import type { AppEnv } from '../../src/server/context.js';
import { assets, comments, openDb, versions, type DB } from '../../src/server/db/index.js';
import { indexVersionHtml } from '../../src/server/services/anchorStates.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';
import { inlineAssets } from '../../src/server/services/assets.js';
import { describeTextAnchor } from '../../src/anchoring/text.js';
import { eq } from 'drizzle-orm';

const V1_HTML = `<!DOCTYPE html><html><body>
<h1>Quarterly Report</h1>
<p>Revenue grew steadily across all segments this quarter.</p>
<p>The churn number needs a second look before we publish.</p>
</body></html>`;

// v2 keeps the revenue sentence, drops the churn sentence entirely.
const V2_HTML = `<!DOCTYPE html><html><body>
<h1>Quarterly Report</h1>
<p>Revenue grew steadily across all segments this quarter.</p>
<p>Churn was restated after the data pipeline fix.</p>
</body></html>`;

describe('mcp', () => {
  let db: DB;
  let app: Hono<AppEnv>;
  let pat: string;
  let rpcId = 0;

  beforeAll(() => {
    const opened = openDb(':memory:');
    db = opened.db;
    const config: Config = baseTestConfig({ baseUrl: 'http://colab.example.com' });
    seedTeamWithDomain(db, 'team-example', 'example.com');
    seedTeamWithDomain(db, 'team-evil', 'evil.com');
    app = createApp({ db, config });
    const user = getOrCreateUser(db, 'alice@example.com', new Date());
    pat = createToken(db, user.id, 'team-example', 'test', new Date()).plaintext;
  });

  async function rpc(method: string, params: unknown, token = pat): Promise<Response> {
    return app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
  }

  /** Extract the JSON-RPC result from a JSON or SSE response. */
  async function rpcResult(res: Response): Promise<any> {
    expect(res.status).toBe(200);
    const text = await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    let payload: any;
    if (contentType.includes('text/event-stream')) {
      const dataLines = text.split('\n').filter((l) => l.startsWith('data:'));
      payload = JSON.parse(dataLines[dataLines.length - 1]!.slice(5));
    } else {
      payload = JSON.parse(text);
    }
    expect(payload.error, JSON.stringify(payload.error)).toBeUndefined();
    return payload.result;
  }

  async function callTool(name: string, args: unknown): Promise<any> {
    const res = await rpc('tools/call', { name, arguments: args });
    return rpcResult(res);
  }

  test('rejects missing/bad bearer token with bare WWW-Authenticate', async () => {
    const noAuth = await app.request('/mcp', { method: 'POST', body: '{}' });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toBe('Bearer');

    const badAuth = await rpc('tools/list', {}, 'acp_definitelywrong');
    expect(badAuth.status).toBe(401);
    expect(badAuth.headers.get('www-authenticate')).toBe('Bearer');
  });

  test('lists the five tools', async () => {
    const result = await rpcResult(await rpc('tools/list', {}));
    const names = result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['delete_artifact', 'get_artifact', 'get_comments', 'publish_artifact', 'resolve_comment']);
  });

  let documentId: string;

  test('publish_artifact creates a document and returns its URL', async () => {
    const result = await callTool('publish_artifact', { title: 'Quarterly Report', html: V1_HTML });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toContain('http://colab.example.com/d/');
    documentId = text.match(/document_id: (\w+)/)![1]!;
    expect(documentId).toHaveLength(10);
  });

  test('publish_artifact rejects oversized html', async () => {
    const result = await callTool('publish_artifact', { title: 'Big', html: 'x'.repeat(5 * 1024 * 1024 + 1) });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('5 MB');
  });

  test('publish_artifact with unknown document_id errors', async () => {
    const result = await callTool('publish_artifact', { title: 'X', html: '<p>x</p>', document_id: 'nope123456' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown document_id');
  });

  test('cross-team publish is rejected as unknown document', async () => {
    const mallory = getOrCreateUser(db, 'mallory@evil.com', new Date());
    const malloryPat = createToken(db, mallory.id, 'team-evil', 'evil', new Date()).plaintext;
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${malloryPat}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name: 'publish_artifact', arguments: { title: 'Takeover', html: '<p>x</p>', document_id: documentId } },
      }),
    });
    const result = await rpcResult(res);
    expect(result.isError).toBe(true);
  });

  let commentId: string;

  test('get_comments returns threads with anchor state', async () => {
    // Comment via direct insert, anchored to the churn sentence of v1.
    const version = db.select().from(versions).where(eq(versions.documentId, documentId)).get()!;
    const text = indexVersionHtml(V1_HTML);
    const quote = 'The churn number needs a second look';
    const start = text.indexOf(quote);
    expect(start).toBeGreaterThan(-1);
    const anchor = describeTextAnchor(text, start, start + quote.length);
    const author = getOrCreateUser(db, 'bob@example.com', new Date());
    commentId = 'c0ffee0000000001';
    db.insert(comments)
      .values({
        id: commentId,
        documentId,
        parentId: null,
        authorId: author.id,
        body: 'Double-check this against finance numbers.',
        quotedText: quote,
        anchor: JSON.stringify(anchor),
        status: 'open',
        createdVersionId: version.id,
        createdAt: new Date(),
      })
      .run();

    const result = await callTool('get_comments', { document_id: documentId });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].quotedText).toBe(quote);
    expect(payload.comments[0].author.email).toBe('bob@example.com');
  });

  test('republish reports the orphaned comment and updates anchor states', async () => {
    const result = await callTool('publish_artifact', {
      title: 'Quarterly Report',
      html: V2_HTML,
      document_id: documentId,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toContain('version 2');
    expect(text).toContain('1 previously-anchored comment no longer match');

    const after = await callTool('get_comments', { document_id: documentId });
    const payload = JSON.parse(after.content[0].text);
    expect(payload.comments[0].anchorState.state).toBe('orphaned');
  });

  test('get_artifact returns small artifacts inline, latest version by default', async () => {
    const result = await callTool('get_artifact', { document_id: documentId });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('version 2');
    expect(result.content[1].text).toBe(V2_HTML);
  });

  test('get_artifact fetches an older version by number', async () => {
    const result = await callTool('get_artifact', { document_id: documentId, version: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('version 1');
    expect(result.content[1].text).toBe(V1_HTML);
  });

  test('get_artifact errors on unknown document or version', async () => {
    const unknownDoc = await callTool('get_artifact', { document_id: 'nope123456' });
    expect(unknownDoc.isError).toBe(true);
    expect(unknownDoc.content[0].text).toContain('unknown document_id');

    const unknownVersion = await callTool('get_artifact', { document_id: documentId, version: 99 });
    expect(unknownVersion.isError).toBe(true);
    expect(unknownVersion.content[0].text).toContain('no version 99');
  });

  test('get_artifact returns a curl command instead of inlining large artifacts', async () => {
    const bigHtml = `<body>${'x'.repeat(60 * 1024)}</body>`;
    const published = await callTool('publish_artifact', { title: 'Big one', html: bigHtml });
    const bigDocId = (published.content[0].text as string).match(/document_id: (\w+)/)![1]!;

    const result = await callTool('get_artifact', { document_id: bigDocId });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const text = result.content[0].text as string;
    expect(text).toContain('too large to return inline');
    expect(text).toContain(`curl -H "Authorization: Bearer $TOKEN" "http://colab.example.com/api/docs/${bigDocId}/raw?version=1"`);
    expect(text).not.toContain('xxxx');
  });

  test('resolve_comment resolves and get_comments status filter works', async () => {
    const result = await callTool('resolve_comment', { comment_id: commentId });
    expect(result.isError).toBeFalsy();

    const open = await callTool('get_comments', { document_id: documentId, status: 'open' });
    expect(JSON.parse(open.content[0].text).comments).toHaveLength(0);
    const resolved = await callTool('get_comments', { document_id: documentId, status: 'resolved' });
    expect(JSON.parse(resolved.content[0].text).comments).toHaveLength(1);
  });

  test('resolve_comment on unknown/reply id errors', async () => {
    const result = await callTool('resolve_comment', { comment_id: 'doesnotexist' });
    expect(result.isError).toBe(true);
  });

  test('delete_artifact on unknown id errors', async () => {
    const result = await callTool('delete_artifact', { document_id: 'nope123456' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown document_id');
  });

  test("delete_artifact refuses another user's document", async () => {
    const bob = getOrCreateUser(db, 'bob@example.com', new Date());
    const bobPat = createToken(db, bob.id, 'team-example', 'bob', new Date()).plaintext;
    const published = await rpcResult(
      await rpc('tools/call', { name: 'publish_artifact', arguments: { title: "Bob's doc", html: '<p>bob</p>' } }, bobPat),
    );
    const bobDocId = (published.content[0].text as string).match(/document_id: (\w+)/)![1]!;

    // Alice's token, Bob's document: same team, different creator.
    const refused = await callTool('delete_artifact', { document_id: bobDocId });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('created by another user');

    const stillThere = await callTool('get_artifact', { document_id: bobDocId });
    expect(stillThere.isError).toBeFalsy();
  });

  test('delete_artifact removes the document and everything attached to it', async () => {
    const result = await callTool('delete_artifact', { document_id: documentId });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Deleted "Quarterly Report"');

    const gone = await callTool('get_artifact', { document_id: documentId });
    expect(gone.isError).toBe(true);
    expect(gone.content[0].text).toContain('unknown document_id');

    expect(db.select().from(versions).where(eq(versions.documentId, documentId)).all()).toHaveLength(0);
    expect(db.select().from(comments).where(eq(comments.documentId, documentId)).all()).toHaveLength(0);
  });
});

describe('mcp assets', () => {
  let db: DB;
  let app: Hono<AppEnv>;
  let pat: string;
  let rpcId = 100;
  // 1x1 transparent PNG
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  beforeAll(() => {
    const opened = openDb(':memory:');
    db = opened.db;
    const config: Config = baseTestConfig({ baseUrl: 'http://colab.example.com' });
    seedTeamWithDomain(db, 'team-example', 'example.com');
    app = createApp({ db, config });
    const user = getOrCreateUser(db, 'carol@example.com', new Date());
    pat = createToken(db, user.id, 'team-example', 'assets-test', new Date()).plaintext;
  });

  async function callTool(name: string, args: unknown): Promise<any> {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${pat}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    const payload = contentType.includes('text/event-stream')
      ? JSON.parse(text.split('\n').filter((l) => l.startsWith('data:')).pop()!.slice(5))
      : JSON.parse(text);
    expect(payload.error, JSON.stringify(payload.error)).toBeUndefined();
    return payload.result;
  }

  test('publishes with assets and inlines them into the served frame', async () => {
    const result = await callTool('publish_artifact', {
      title: 'With screenshot',
      html: '<body><h1>Report</h1><img src="shots/one.png" alt="screenshot"><p>Analysis text.</p></body>',
      assets: [{ name: 'shots/one.png', mime_type: 'image/png', data_base64: PNG_B64 }],
    });
    expect(result.isError).toBeFalsy();
    const docId = (result.content[0].text as string).match(/document_id: (\w+)/)![1]!;

    const stored = db.select().from(assets).where(eq(assets.documentId, docId)).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.name).toBe('shots/one.png');

    const html = db.select().from(versions).where(eq(versions.documentId, docId)).get()!.html;
    const inlined = inlineAssets(html, stored);
    expect(inlined).toContain(`src="data:image/png;base64,${PNG_B64}"`);
    expect(inlined).not.toContain('src="shots/one.png"');
  });

  test('re-uploading the same name replaces the asset', async () => {
    const first = await callTool('publish_artifact', {
      title: 'Doc',
      html: '<body><img src="a.png"></body>',
      assets: [{ name: 'a.png', mime_type: 'image/png', data_base64: PNG_B64 }],
    });
    const docId = (first.content[0].text as string).match(/document_id: (\w+)/)![1]!;
    const jpeg = Buffer.from('not really a jpeg').toString('base64');
    await callTool('publish_artifact', {
      title: 'Doc',
      html: '<body><img src="a.png"> v2</body>',
      document_id: docId,
      assets: [{ name: 'a.png', mime_type: 'image/jpeg', data_base64: jpeg }],
    });
    const stored = db.select().from(assets).where(eq(assets.documentId, docId)).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.mime).toBe('image/jpeg');
  });

  test('rejects bad names and oversized assets', async () => {
    const bad = await callTool('publish_artifact', {
      title: 'X',
      html: '<p>x</p>',
      assets: [{ name: '../escape.png', mime_type: 'image/png', data_base64: PNG_B64 }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('invalid asset name');

    const big = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    const oversized = await callTool('publish_artifact', {
      title: 'X',
      html: '<p>x</p>',
      assets: [{ name: 'big.png', mime_type: 'image/png', data_base64: big }],
    });
    expect(oversized.isError).toBe(true);
    expect(oversized.content[0].text).toContain('4 MB');
  });
});
