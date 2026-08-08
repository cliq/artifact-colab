// @vitest-environment node
//
// Cookie-based auth needs Node's native fetch (see test/server/auth.test.ts
// for why happy-dom can't observe Set-Cookie / cookie headers).

/**
 * Integration tests for the documents/comments REST API. `apiRoutes` isn't
 * mounted on the real app yet (a later step does that), so these tests build
 * a minimal Hono app of their own: db/config injection + `sessionAuth`,
 * deliberately without `csrfProtect` (orthogonal to this router).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { describeTextAnchor } from '../../src/anchoring/text.js';
import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { Config } from '../../src/server/config.js';
import type { AppEnv } from '../../src/server/context.js';
import { documents, openDb, versions, type DB } from '../../src/server/db/index.js';
import { sessionAuth } from '../../src/server/middleware.js';
import { apiRoutes } from '../../src/server/routes/api.js';
import { indexVersionHtml, recomputeForVersion } from '../../src/server/services/anchorStates.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const QUOTE = 'The quarterly numbers look great this quarter.';
const V1_HTML = `<body><p>Intro paragraph.</p><p>${QUOTE}</p><p>Closing paragraph.</p></body>`;
const V2_HTML = `<body><p>Intro paragraph.</p><p>Closing paragraph.</p></body>`; // quote removed

describe('api', () => {
  let tmpDir: string;
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let config: Config;
  let app: Hono<AppEnv>;

  let slug: string;
  let v1Id: string;
  let v2Id: string;
  let ownerCookie: string;
  let outsiderCookie: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-api-'));
    const opened = openDb(join(tmpDir, 'app.db'));
    db = opened.db;
    sqlite = opened.sqlite;

    config = baseTestConfig();
    seedTeamWithDomain(db, 'team-example', 'example.com');

    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('config', config);
      await next();
    });
    app.use('/api/*', sessionAuth({ redirect: false }));
    app.route('/', apiRoutes);

    const now = new Date();
    const owner = getOrCreateUser(db, 'owner@example.com', now);
    const outsider = getOrCreateUser(db, 'outsider@other-domain.com', now);
    ownerCookie = `session=${createSession(db, owner.id, now).token}`;
    outsiderCookie = `session=${createSession(db, outsider.id, now).token}`;

    slug = 'quarterly-report';
    db.insert(documents)
      .values({ id: slug, title: 'Quarterly Report', teamId: 'team-example', createdBy: owner.id, createdAt: now })
      .run();

    v1Id = 'ver-1';
    db.insert(versions).values({ id: v1Id, documentId: slug, number: 1, html: V1_HTML, publishedAt: now }).run();
    db.update(documents).set({ currentVersionId: v1Id }).where(eq(documents.id, slug)).run();
  });

  afterAll(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function authed(cookie: string, body?: unknown) {
    return {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  }

  function buildAnchor(sentence: string) {
    const text = indexVersionHtml(V1_HTML);
    const start = text.indexOf(sentence);
    return describeTextAnchor(text, start, start + sentence.length);
  }

  test('GET /api/docs/:slug returns the document and its versions, no html', async () => {
    const res = await app.request(`/api/docs/${slug}`, { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { document: { id: string; title: string }; versions: { id: string; number: number }[] };
    expect(payload.document.id).toBe(slug);
    expect(payload.document.title).toBe('Quarterly Report');
    expect(payload.versions).toEqual([{ id: v1Id, number: 1, publishedAt: expect.any(String) }]);
    expect(JSON.stringify(payload)).not.toContain(QUOTE);
  });

  let createdCommentId: string;

  test('POST .../comments creates a comment anchored against the given version', async () => {
    const res = await app.request(
      `/api/docs/${slug}/comments`,
      authed(ownerCookie, { body: 'nice numbers', quotedText: QUOTE, anchor: buildAnchor(QUOTE), versionId: v1Id }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      body: string;
      status: string;
      anchorState: { state: string } | null;
      replies: unknown[];
    };
    expect(created.body).toBe('nice numbers');
    expect(created.status).toBe('open');
    expect(created.anchorState).toEqual({ state: 'anchored', start: expect.any(Number), end: expect.any(Number) });
    expect(created.replies).toEqual([]);
    createdCommentId = created.id;
  });

  test('GET .../comments lists the created comment with its anchor state', async () => {
    const res = await app.request(`/api/docs/${slug}/comments`, { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { comments: { id: string; quotedText: string; anchorState: { state: string } }[] };
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]?.id).toBe(createdCommentId);
    expect(payload.comments[0]?.quotedText).toBe(QUOTE);
    expect(payload.comments[0]?.anchorState?.state).toBe('anchored');
  });

  test('POST /api/comments/:id/replies adds a reply visible on the thread', async () => {
    const res = await app.request(`/api/comments/${createdCommentId}/replies`, authed(ownerCookie, { body: 'agreed' }));
    expect(res.status).toBe(201);
    const reply = (await res.json()) as { id: string; body: string; author: { email: string } };
    expect(reply.body).toBe('agreed');
    expect(reply.author.email).toBe('owner@example.com');

    const listRes = await app.request(`/api/docs/${slug}/comments`, { headers: { cookie: ownerCookie } });
    const payload = (await listRes.json()) as { comments: { replies: { id: string; body: string }[] }[] };
    expect(payload.comments[0]?.replies).toEqual([expect.objectContaining({ id: reply.id, body: 'agreed' })]);
  });

  test('replying to a reply (non-top-level) is rejected as not found', async () => {
    const listRes = await app.request(`/api/docs/${slug}/comments`, { headers: { cookie: ownerCookie } });
    const payload = (await listRes.json()) as { comments: { replies: { id: string }[] }[] };
    const replyId = payload.comments[0]?.replies[0]?.id;

    const res = await app.request(`/api/comments/${replyId}/replies`, authed(ownerCookie, { body: 'nested' }));
    expect(res.status).toBe(404);
  });

  test('resolve moves a thread to the resolved group; reopen moves it back', async () => {
    const resolveRes = await app.request(`/api/comments/${createdCommentId}/resolve`, authed(ownerCookie, {}));
    expect(resolveRes.status).toBe(200);
    const resolved = (await resolveRes.json()) as { status: string; resolvedAt: string | null; resolvedBy: string | null };
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedBy).toBe('owner@example.com');

    const afterResolve = await app.request(`/api/docs/${slug}/comments`, { headers: { cookie: ownerCookie } });
    const afterResolvePayload = (await afterResolve.json()) as { comments: { status: string }[] };
    expect(afterResolvePayload.comments[0]?.status).toBe('resolved');

    const reopenRes = await app.request(`/api/comments/${createdCommentId}/reopen`, authed(ownerCookie, {}));
    expect(reopenRes.status).toBe(200);
    const reopened = (await reopenRes.json()) as { status: string; resolvedAt: string | null; resolvedBy: string | null };
    expect(reopened.status).toBe('open');
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.resolvedBy).toBeNull();
  });

  test('a document in another team 404s rather than 403s', async () => {
    const docRes = await app.request(`/api/docs/${slug}`, { headers: { cookie: outsiderCookie } });
    expect(docRes.status).toBe(404);

    const commentRes = await app.request(
      `/api/docs/${slug}/comments`,
      authed(outsiderCookie, { body: 'sneaky', quotedText: QUOTE, anchor: buildAnchor(QUOTE), versionId: v1Id }),
    );
    expect(commentRes.status).toBe(404);
  });

  test('an unknown slug 404s the same way as a cross-team one', async () => {
    const res = await app.request('/api/docs/does-not-exist', { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(404);
  });

  describe('validation', () => {
    test('an empty comment body is rejected', async () => {
      const res = await app.request(
        `/api/docs/${slug}/comments`,
        authed(ownerCookie, { body: '', quotedText: QUOTE, anchor: buildAnchor(QUOTE), versionId: v1Id }),
      );
      expect(res.status).toBe(400);
    });

    test('a malformed anchor is rejected', async () => {
      const res = await app.request(
        `/api/docs/${slug}/comments`,
        authed(ownerCookie, { body: 'x', quotedText: QUOTE, anchor: { exact: QUOTE }, versionId: v1Id }),
      );
      expect(res.status).toBe(400);
    });

    test('an empty quotedText is rejected', async () => {
      const res = await app.request(
        `/api/docs/${slug}/comments`,
        authed(ownerCookie, { body: 'x', quotedText: '', anchor: buildAnchor(QUOTE), versionId: v1Id }),
      );
      expect(res.status).toBe(400);
    });

    test('a versionId belonging to a different document is rejected', async () => {
      const res = await app.request(
        `/api/docs/${slug}/comments`,
        authed(ownerCookie, { body: 'x', quotedText: QUOTE, anchor: buildAnchor(QUOTE), versionId: 'no-such-version' }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('exports', () => {
    test('export.json includes the thread with its quoted text', async () => {
      const res = await app.request(`/api/docs/${slug}/export.json`, { headers: { cookie: ownerCookie } });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { document: { title: string }; comments: { quotedText: string }[] };
      expect(payload.document.title).toBe('Quarterly Report');
      expect(payload.comments.some((c) => c.quotedText === QUOTE)).toBe(true);
    });

    test('export.md is markdown containing the quoted text', async () => {
      const res = await app.request(`/api/docs/${slug}/export.md`, { headers: { cookie: ownerCookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/markdown');
      const text = await res.text();
      expect(text).toContain('# Comments on Quarterly Report');
      expect(text).toContain(QUOTE);
    });
  });

  describe('anchor state per requested version', () => {
    beforeAll(() => {
      v2Id = 'ver-2';
      const now = new Date();
      db.insert(versions).values({ id: v2Id, documentId: slug, number: 2, html: V2_HTML, publishedAt: now }).run();
      db.update(documents).set({ currentVersionId: v2Id }).where(eq(documents.id, slug)).run();
      recomputeForVersion(db, slug, v2Id);
    });

    test('defaults to the current version (orphaned once the quote is removed)', async () => {
      const res = await app.request(`/api/docs/${slug}/comments`, { headers: { cookie: ownerCookie } });
      const payload = (await res.json()) as { comments: { anchorState: { state: string } }[] };
      expect(payload.comments[0]?.anchorState?.state).toBe('orphaned');
    });

    test('an explicit ?version= returns that version\'s stored state', async () => {
      const res = await app.request(`/api/docs/${slug}/comments?version=${v1Id}`, { headers: { cookie: ownerCookie } });
      const payload = (await res.json()) as { comments: { anchorState: { state: string } }[] };
      expect(payload.comments[0]?.anchorState?.state).toBe('anchored');
    });
  });
});
