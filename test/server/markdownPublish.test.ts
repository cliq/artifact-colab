// @vitest-environment node

/**
 * Publishing Markdown instead of HTML: the render itself, the exactly-one-of
 * html/markdown rule in the shared publish flow, the MCP tool round trip
 * (publish markdown → get_artifact returns the markdown source), and the
 * multipart endpoint plus /raw serving the source as published.
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';

import { createApp } from '../../src/server/app.js';
import { createToken, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import { openDb, versions, type DB } from '../../src/server/db/index.js';
import { renderMarkdownArtifact } from '../../src/server/services/markdown.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const MARKDOWN = `# Quarterly Report

Revenue grew **steadily** across all segments.

| Segment | Growth |
| ------- | ------ |
| EMEA    | 12%    |
`;

describe('renderMarkdownArtifact', () => {
  test('renders GFM into a complete HTML document', () => {
    const html = renderMarkdownArtifact(MARKDOWN, 'Quarterly Report');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<h1>Quarterly Report</h1>');
    expect(html).toContain('<strong>steadily</strong>');
    expect(html).toContain('<table>'); // GFM tables are on
  });

  test('escapes the title', () => {
    const html = renderMarkdownArtifact('hi', '<script>alert(1)</script>');
    expect(html).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html).not.toContain('<title><script>');
  });
});

describe('markdown publishing end to end', () => {
  let db: DB;
  let app: Hono<AppEnv>;
  let pat: string;
  let rpcId = 0;

  beforeAll(() => {
    const opened = openDb(':memory:');
    db = opened.db;
    seedTeamWithDomain(db, 'team-example', 'example.com');
    app = createApp({ db, config: baseTestConfig({ baseUrl: 'http://colab.example.com' }) });
    const user = getOrCreateUser(db, 'alice@example.com', new Date());
    pat = createToken(db, user.id, 'team-example', 'md-test', new Date()).plaintext;
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
      ? JSON.parse(
          text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .pop()!
            .slice(5),
        )
      : JSON.parse(text);
    expect(payload.error, JSON.stringify(payload.error)).toBeUndefined();
    return payload.result;
  }

  let documentId: string;

  test('publish_artifact accepts markdown; the stored version is rendered HTML with the source kept', async () => {
    const result = await callTool('publish_artifact', { title: 'Quarterly Report', markdown: MARKDOWN });
    expect(result.isError).toBeFalsy();
    documentId = (result.content[0].text as string).match(/document_id: (\w+)/)![1]!;

    const version = db.select().from(versions).where(eq(versions.documentId, documentId)).get()!;
    expect(version.sourceMarkdown).toBe(MARKDOWN);
    expect(version.html).toContain('<strong>steadily</strong>');
  });

  test('get_artifact hands back the markdown source, labeled as such', async () => {
    const result = await callTool('get_artifact', { document_id: documentId });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('(published as Markdown)');
    expect(result.content[1].text).toBe(MARKDOWN);
  });

  test('publish_artifact rejects both or neither of html/markdown', async () => {
    const both = await callTool('publish_artifact', { title: 'X', html: '<p>x</p>', markdown: 'x' });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain('exactly one of html or markdown');

    const neither = await callTool('publish_artifact', { title: 'X' });
    expect(neither.isError).toBe(true);
  });

  test('POST /api/publish accepts a markdown file part and /raw returns the source', async () => {
    const form = new FormData();
    form.append('title', 'Uploaded Notes');
    form.append('markdown', new File([MARKDOWN], 'notes.md', { type: 'text/markdown' }));

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${pat}` },
      body: form,
    });
    expect(res.status).toBe(200);
    const payload = await res.json();

    const raw = await app.request(`/api/docs/${payload.document_id}/raw`, {
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toContain('text/markdown');
    expect(await raw.text()).toBe(MARKDOWN);
  });

  test('POST /api/publish rejects duplicated html parts instead of treating them as absent', async () => {
    // Repeated fields parse as arrays; they must not slip past the
    // exactly-one check and get accepted as the other format.
    const form = new FormData();
    form.append('title', 'Sneaky');
    form.append('html', '<p>one</p>');
    form.append('html', '<p>two</p>');
    form.append('markdown', 'x');

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${pat}` },
      body: form,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('single file part');
  });

  test('POST /api/publish rejects both html and markdown parts', async () => {
    const form = new FormData();
    form.append('title', 'Conflicted');
    form.append('html', '<p>x</p>');
    form.append('markdown', 'x');

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${pat}` },
      body: form,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('exactly one of html or markdown');
  });

  test('a republish can switch formats; each version keeps its own source', async () => {
    const result = await callTool('publish_artifact', { title: 'Quarterly Report', html: '<body><p>hand-rolled</p></body>', document_id: documentId });
    expect(result.isError).toBeFalsy();

    const rows = db.select().from(versions).where(eq(versions.documentId, documentId)).all();
    const v1 = rows.find((v) => v.number === 1)!;
    const v2 = rows.find((v) => v.number === 2)!;
    expect(v1.sourceMarkdown).toBe(MARKDOWN);
    expect(v2.sourceMarkdown).toBeNull();

    const fetched = await callTool('get_artifact', { document_id: documentId, version: 1 });
    expect(fetched.content[1].text).toBe(MARKDOWN);
  });
});
