// @vitest-environment node

/**
 * Deleting comments and replies: only the author may; replies and reply-less
 * threads go outright (with reactions, images and anchor states), a thread
 * with replies stays as a "deleted" placeholder until its last reply goes,
 * and agents may delete only what they posted through MCP.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, describe, expect, test } from 'vitest';

import { describeTextAnchor } from '../../src/anchoring/text.js';
import { createApp } from '../../src/server/app.js';
import { createSession, createToken, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import { commentAnchorStates, commentImages, commentReactions, comments, documents, openDb, versions, type DB } from '../../src/server/db/index.js';
import type { ThreadDTO } from '../../src/server/routes/api.js';
import { indexVersionHtml } from '../../src/server/services/anchorStates.js';
import { runDigestSweep, watchForMention, type DigestEmail } from '../../src/server/services/watches.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const QUOTE = 'The launch plan is ready for review.';
const HTML = `<body><p>${QUOTE}</p></body>`;
const CSRF = 'test-csrf-token';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);

describe('comment deletes', () => {
  let db: DB;
  let app: Hono<AppEnv>;
  let alice: string;
  let bob: string;
  let outsider: string;
  let pat: string;
  let anchor: ReturnType<typeof describeTextAnchor>;
  const slug = 'doc-del';

  beforeAll(() => {
    db = openDb(':memory:').db;
    seedTeamWithDomain(db, 'team-example', 'example.com');
    app = createApp({ db, config: baseTestConfig() });
    const now = new Date();
    const aliceUser = getOrCreateUser(db, 'alice@example.com', now);
    const cookie = (id: string) => `session=${createSession(db, id, now).token}; csrf=${CSRF}`;
    alice = cookie(aliceUser.id);
    bob = cookie(getOrCreateUser(db, 'bob@example.com', now).id);
    outsider = cookie(getOrCreateUser(db, 'eve@elsewhere.com', now).id);
    pat = createToken(db, aliceUser.id, 'team-example', 'Claude Code', now).plaintext;

    db.insert(documents).values({ id: slug, title: 'Doc', teamId: 'team-example', createdBy: aliceUser.id, createdAt: now }).run();
    db.insert(versions).values({ id: 'v-del', documentId: slug, number: 1, html: HTML, publishedAt: now, publishedBy: aliceUser.id }).run();
    db.update(documents).set({ currentVersionId: 'v-del' }).where(eq(documents.id, slug)).run();
    const text = indexVersionHtml(HTML);
    const start = text.indexOf(QUOTE);
    anchor = describeTextAnchor(text, start, start + QUOTE.length);
  });

  async function request(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { cookie, 'x-csrf-token': CSRF };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    return app.request(path, { method, headers, body: payload });
  }

  async function newThread(cookie: string, body: string, withImage = false, doc = slug): Promise<string> {
    const payload = { body, quotedText: QUOTE, anchor, versionId: doc === slug ? 'v-del' : `v-${doc}` };
    let res: Response;
    if (withImage) {
      const form = new FormData();
      form.append('payload', JSON.stringify(payload));
      form.append('images', new File([new Uint8Array(PNG)], 'a.png', { type: 'image/png' }));
      res = await request('POST', `/api/docs/${doc}/comments`, cookie, form);
    } else {
      res = await request('POST', `/api/docs/${doc}/comments`, cookie, payload);
    }
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function reply(cookie: string, threadId: string, body: string): Promise<string> {
    const res = await request('POST', `/api/comments/${threadId}/replies`, cookie, { body });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  const row = (id: string) => db.select().from(comments).where(eq(comments.id, id)).get();

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

  test('only the author can delete; outsiders get a 404', async () => {
    const id = await newThread(alice, 'Mine');
    expect((await request('DELETE', `/api/comments/${id}`, bob)).status).toBe(403);
    expect((await request('DELETE', `/api/comments/${id}`, outsider)).status).toBe(404);
    expect(row(id)).toBeDefined();
  });

  test('a thread without replies is removed with its images, reactions and anchor states', async () => {
    const id = await newThread(alice, 'Short-lived', true);
    await request('PUT', `/api/comments/${id}/reactions/${encodeURIComponent('👍')}`, bob);
    expect(db.select().from(commentAnchorStates).where(eq(commentAnchorStates.commentId, id)).all().length).toBeGreaterThan(0);

    const res = await request('DELETE', `/api/comments/${id}`, alice);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ thread: null });
    expect(row(id)).toBeUndefined();
    expect(db.select().from(commentImages).where(eq(commentImages.commentId, id)).all()).toHaveLength(0);
    expect(db.select().from(commentReactions).where(eq(commentReactions.commentId, id)).all()).toHaveLength(0);
    expect(db.select().from(commentAnchorStates).where(eq(commentAnchorStates.commentId, id)).all()).toHaveLength(0);
  });

  test('a reply is removed and the thread comes back without it', async () => {
    const threadId = await newThread(alice, 'Question');
    const replyId = await reply(bob, threadId, 'Answer');
    const res = await request('DELETE', `/api/comments/${replyId}`, bob);
    expect(res.status).toBe(200);
    const { thread } = (await res.json()) as { thread: ThreadDTO };
    expect(thread.id).toBe(threadId);
    expect(thread.replies).toHaveLength(0);
    expect(row(replyId)).toBeUndefined();
  });

  test('a thread with replies stays as a placeholder until its last reply is deleted', async () => {
    const threadId = await newThread(alice, 'Opening remark', true);
    await request('PUT', `/api/comments/${threadId}/reactions/${encodeURIComponent('👍')}`, bob);
    const replyId = await reply(bob, threadId, 'A reply worth keeping');

    const res = await request('DELETE', `/api/comments/${threadId}`, alice);
    expect(res.status).toBe(200);
    const { thread } = (await res.json()) as { thread: ThreadDTO };
    expect(thread).toMatchObject({ id: threadId, deleted: true, body: '', images: [], reactions: [] });
    expect(thread.replies.map((r) => r.body)).toEqual(['A reply worth keeping']);

    // Nothing more to do to the placeholder itself…
    expect((await request('PATCH', `/api/comments/${threadId}`, alice, { body: 'Back' })).status).toBe(400);
    expect((await request('PUT', `/api/comments/${threadId}/reactions/${encodeURIComponent('👍')}`, bob)).status).toBe(400);
    expect((await request('DELETE', `/api/comments/${threadId}`, alice)).status).toBe(400);
    // …but the conversation under it carries on.
    const laterReply = await reply(alice, threadId, 'Follow-up');

    await request('DELETE', `/api/comments/${replyId}`, bob);
    expect(row(threadId)).toBeDefined();
    const last = await request('DELETE', `/api/comments/${laterReply}`, alice);
    expect(await last.json()).toEqual({ thread: null });
    expect(row(threadId)).toBeUndefined();
  });

  test('digests leave out deleted placeholders', async () => {
    // A document of its own, so no other test's comments land in the digest.
    const doc = 'doc-digest';
    const now = new Date();
    const owner = db.select().from(documents).where(eq(documents.id, slug)).get()!.createdBy;
    db.insert(documents).values({ id: doc, title: 'Digest doc', teamId: 'team-example', createdBy: owner, createdAt: now }).run();
    db.insert(versions).values({ id: `v-${doc}`, documentId: doc, number: 1, html: HTML, publishedAt: now, publishedBy: owner }).run();
    db.update(documents).set({ currentVersionId: `v-${doc}` }).where(eq(documents.id, doc)).run();
    const carol = getOrCreateUser(db, 'carol@example.com', now);
    watchForMention(db, doc, carol.id, now);

    const threadId = await newThread(alice, 'Soon gone', false, doc);
    await reply(bob, threadId, 'Still here');
    await request('DELETE', `/api/comments/${threadId}`, alice);

    const sent: DigestEmail[] = [];
    await runDigestSweep(db, 'http://localhost:3000', async (email) => void sent.push(email), new Date(Date.now() + 60 * 60 * 1000));
    const toCarol = sent.find((email) => email.to === carol.email)!;
    expect(toCarol.subject).toMatch(/^1 new comment /);
    expect(toCarol.text).toContain('Still here');
  });

  test('agents delete only what they posted through MCP', async () => {
    const typed = await newThread(alice, 'Typed in the browser');
    const refused = await callTool('delete_comment', { comment_id: typed });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('web UI');

    const added = await callTool('add_comment', { body: 'Agent note', document_id: slug, quoted_text: QUOTE });
    const agentId = /Comment ([0-9a-f]+)/.exec(added.content[0].text)![1]!;
    const deleted = await callTool('delete_comment', { comment_id: agentId });
    expect(deleted.isError).toBeFalsy();
    expect(row(agentId)).toBeUndefined();
  });
});
