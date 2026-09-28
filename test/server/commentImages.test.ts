// @vitest-environment node

/**
 * Images on comments and replies: multipart uploads from the web composer,
 * base64 over MCP, the count/size/format rules, access-checked serving, and
 * cleanup when the document goes.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, describe, expect, test } from 'vitest';

import { describeTextAnchor } from '../../src/anchoring/text.js';
import { createApp } from '../../src/server/app.js';
import { createSession, createToken, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import { commentImages, documents, openDb, versions, type DB } from '../../src/server/db/index.js';
import type { ThreadDTO } from '../../src/server/routes/api.js';
import { indexVersionHtml } from '../../src/server/services/anchorStates.js';
import { MAX_COMMENT_IMAGE_BYTES, sniffImageMime, validateCommentImages } from '../../src/server/services/commentImages.js';
import { deleteDocumentCascade } from '../../src/server/services/documents.js';
import { runDigestSweep, watchForMention, type DigestEmail } from '../../src/server/services/watches.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const QUOTE = 'The launch plan is ready for review.';
const HTML = `<body><p>${QUOTE}</p></body>`;
const CSRF = 'test-csrf-token';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const GIF = Buffer.from('GIF89a-gif-body');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('comment image validation', () => {
  test('sniffs PNG, JPEG, GIF and WebP from their bytes and nothing else', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(GIF)).toBe('image/gif');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
    expect(sniffImageMime(SVG)).toBeNull();
    expect(sniffImageMime(Buffer.from('<html>'))).toBeNull();
  });

  test('enforces the count, size and format limits', () => {
    const one = (data: Buffer) => ({ label: 'x.png', data });
    expect(validateCommentImages([one(PNG), one(JPEG), one(GIF), one(WEBP)]).ok).toBe(true);
    expect(validateCommentImages([one(PNG), one(PNG), one(PNG), one(PNG), one(PNG)])).toMatchObject({ ok: false, error: expect.stringContaining('at most 4') });
    expect(validateCommentImages([one(SVG)])).toMatchObject({ ok: false, error: expect.stringContaining('not a PNG') });
    expect(validateCommentImages([one(Buffer.alloc(0))])).toMatchObject({ ok: false, error: expect.stringContaining('empty') });
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_COMMENT_IMAGE_BYTES)]);
    expect(validateCommentImages([one(huge)])).toMatchObject({ ok: false, error: expect.stringContaining('larger than') });
  });
});

describe('comment images over HTTP and MCP', () => {
  let db: DB;
  let app: Hono<AppEnv>;
  let aliceCookie: string;
  let outsiderCookie: string;
  let pat: string;
  let anchor: ReturnType<typeof describeTextAnchor>;
  const slug = 'doc-img';

  beforeAll(() => {
    db = openDb(':memory:').db;
    seedTeamWithDomain(db, 'team-example', 'example.com');
    app = createApp({ db, config: baseTestConfig({ baseUrl: 'http://colab.example.com' }) });

    const now = new Date();
    const alice = getOrCreateUser(db, 'alice@example.com', now);
    const outsider = getOrCreateUser(db, 'eve@elsewhere.com', now);
    aliceCookie = `session=${createSession(db, alice.id, now).token}; csrf=${CSRF}`;
    outsiderCookie = `session=${createSession(db, outsider.id, now).token}; csrf=${CSRF}`;
    pat = createToken(db, alice.id, 'team-example', 'Claude Code', now).plaintext;

    db.insert(documents).values({ id: slug, title: 'Doc', teamId: 'team-example', createdBy: alice.id, createdAt: now }).run();
    db.insert(versions).values({ id: 'v-img', documentId: slug, number: 1, html: HTML, publishedAt: now, publishedBy: alice.id }).run();
    db.update(documents).set({ currentVersionId: 'v-img' }).where(eq(documents.id, slug)).run();

    const text = indexVersionHtml(HTML);
    const start = text.indexOf(QUOTE);
    anchor = describeTextAnchor(text, start, start + QUOTE.length);
  });

  function multipart(payload: unknown, files: { name: string; data: Buffer; type?: string }[]): FormData {
    const form = new FormData();
    form.append('payload', JSON.stringify(payload));
    for (const file of files) form.append('images', new File([new Uint8Array(file.data)], file.name, { type: file.type ?? 'image/png' }));
    return form;
  }

  async function post(path: string, body: FormData | string, cookie = aliceCookie): Promise<Response> {
    const headers: Record<string, string> = { cookie, 'x-csrf-token': CSRF };
    if (typeof body === 'string') headers['content-type'] = 'application/json';
    return app.request(path, { method: 'POST', headers, body });
  }

  const newThread = (body: string) => ({ body, quotedText: QUOTE, anchor, versionId: 'v-img' });

  async function callTool(name: string, args: unknown): Promise<any> {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${pat}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await res.text();
    const line = text.split('\n').filter((l) => l.startsWith('data:')).pop();
    return JSON.parse(line ? line.slice(5) : text).result;
  }

  let threadId: string;
  let imageUrl: string;

  test('a comment posted as multipart keeps its images in order', async () => {
    const res = await post(`/api/docs/${slug}/comments`, multipart(newThread('See screenshots'), [
      { name: 'a.png', data: PNG },
      { name: 'b.jpg', data: JPEG, type: 'image/jpeg' },
    ]));
    expect(res.status).toBe(201);
    const thread = (await res.json()) as ThreadDTO;
    threadId = thread.id;
    expect(thread.images.map((image) => image.mime)).toEqual(['image/png', 'image/jpeg']);
    expect(thread.images[0]!.size).toBe(PNG.length);
    imageUrl = thread.images[0]!.url;
    expect(imageUrl).toMatch(/^\/api\/comment-images\/[0-9a-f]+$/);
  });

  test('the image is served to readers with a locked-down content type, and 404s for outsiders', async () => {
    const res = await app.request(imageUrl, { headers: { cookie: aliceCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);

    const outsider = await app.request(imageUrl, { headers: { cookie: outsiderCookie } });
    expect(outsider.status).toBe(404);
  });

  test('the type comes from the bytes, not the declared upload type', async () => {
    const res = await post(`/api/docs/${slug}/comments`, multipart(newThread('Sneaky'), [{ name: 'x.png', data: SVG, type: 'image/png' }]));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('not a PNG');
  });

  test('more than four images are rejected', async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `${i}.png`, data: PNG }));
    const res = await post(`/api/docs/${slug}/comments`, multipart(newThread('Too many'), five));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('at most 4');
  });

  test('an image-only comment is fine, an empty one is not', async () => {
    const imageOnly = await post(`/api/docs/${slug}/comments`, multipart(newThread(''), [{ name: 'a.gif', data: GIF }]));
    expect(imageOnly.status).toBe(201);
    const empty = await post(`/api/docs/${slug}/comments`, JSON.stringify(newThread('  ')));
    expect(empty.status).toBe(400);
  });

  test('uploads above the default 1 MB body cap go through', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
    const res = await post(`/api/docs/${slug}/comments`, multipart(newThread('Big one'), [{ name: 'big.png', data: big }]));
    expect(res.status).toBe(201);
  });

  test('replies take images too, and threads list them', async () => {
    const res = await post(`/api/comments/${threadId}/replies`, multipart({ body: 'Here is the fix' }, [{ name: 'w.webp', data: WEBP, type: 'image/webp' }]));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { images: unknown[] }).images).toHaveLength(1);

    const list = await app.request(`/api/docs/${slug}/comments`, { headers: { cookie: aliceCookie } });
    const thread = ((await list.json()) as { comments: ThreadDTO[] }).comments.find((t) => t.id === threadId)!;
    expect(thread.images).toHaveLength(2);
    expect(thread.replies[0]!.images.map((image) => image.mime)).toEqual(['image/webp']);
  });

  test('add_comment attaches base64 images and get_comment_image returns them', async () => {
    const added = await callTool('add_comment', {
      body: 'Agent screenshot',
      document_id: slug,
      quoted_text: QUOTE,
      images: [{ data_base64: PNG.toString('base64') }],
    });
    expect(added.isError).toBeFalsy();
    expect(added.content[0].text).toContain('with 1 image');

    const listed = await callTool('get_comments', { document_id: slug });
    const threads = JSON.parse(listed.content[0].text).comments as ThreadDTO[];
    const agentThread = threads.find((t) => t.body === 'Agent screenshot')!;
    const imageId = agentThread.images[0]!.id;

    const fetched = await callTool('get_comment_image', { image_id: imageId });
    expect(fetched.isError).toBeFalsy();
    const image = fetched.content.find((part: any) => part.type === 'image');
    expect(image.mimeType).toBe('image/png');
    expect(Buffer.from(image.data, 'base64').equals(PNG)).toBe(true);

    const unknown = await callTool('get_comment_image', { image_id: 'nope' });
    expect(unknown.isError).toBe(true);
  });

  test('add_comment rejects non-images and more than four', async () => {
    const svg = await callTool('add_comment', { body: 'x', comment_id: threadId, images: [{ data_base64: SVG.toString('base64') }] });
    expect(svg.isError).toBe(true);
    expect(svg.content[0].text).toContain('not a PNG');

    const five = Array.from({ length: 5 }, () => ({ data_base64: PNG.toString('base64') }));
    const tooMany = await callTool('add_comment', { body: 'x', comment_id: threadId, images: five });
    expect(tooMany.isError).toBe(true);
  });

  test('the digest mentions attached images', async () => {
    const bob = getOrCreateUser(db, 'bob@example.com', new Date());
    watchForMention(db, slug, bob.id, new Date(Date.now() - 1000));
    const res = await post(`/api/comments/${threadId}/replies`, multipart({ body: 'Two more' }, [
      { name: 'a.png', data: PNG },
      { name: 'b.png', data: PNG },
    ]));
    expect(res.status).toBe(201);

    const sent: DigestEmail[] = [];
    await runDigestSweep(db, 'http://colab.example.com', async (email) => void sent.push(email), new Date(Date.now() + 60 * 60 * 1000));
    const toBob = sent.find((email) => email.to === bob.email)!;
    expect(toBob.text).toContain('Two more\n📎 2 images attached');
    expect(toBob.html).toContain('📎 2 images attached');
  });

  test('deleting the document removes its comment images', () => {
    expect(db.select().from(commentImages).all().length).toBeGreaterThan(0);
    deleteDocumentCascade(db, slug);
    expect(db.select().from(commentImages).all()).toHaveLength(0);
  });
});
