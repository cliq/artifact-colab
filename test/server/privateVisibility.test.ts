// @vitest-environment node
//
// Cookie-based auth needs Node's native fetch (see test/server/auth.test.ts
// for why happy-dom can't observe Set-Cookie / cookie headers).

/**
 * Private visibility: a document flipped to 'private' exists only for its
 * creator — teammates 404 on every surface, it drops off their home listing,
 * their watches are pruned, and their tokens can't read or republish it. Only
 * the creator can make a document private; flipping back to 'team' restores
 * team access with existing comments intact.
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
import { documents, openDb, versions, watches, type DB } from '../../src/server/db/index.js';
import type { User } from '../../src/server/db/schema.js';
import { sessionAuth } from '../../src/server/middleware.js';
import { apiRoutes } from '../../src/server/routes/api.js';
import { documentRoutes } from '../../src/server/routes/document.js';
import { frameRoutes } from '../../src/server/routes/frame.js';
import { pageRoutes } from '../../src/server/routes/pages.js';
import { indexVersionHtml } from '../../src/server/services/anchorStates.js';
import { publishArtifact } from '../../src/server/services/publish.js';
import { removeMember } from '../../src/server/services/teams.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const QUOTE = 'The budget draft still needs numbers.';
const V1_HTML = `<body><p>Intro paragraph.</p><p>${QUOTE}</p><p>Closing paragraph.</p></body>`;

describe('private visibility', () => {
  let tmpDir: string;
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let config: Config;
  let app: Hono<AppEnv>;

  const slug = 'budget-draft';
  const v1Id = 'ver-1';
  let creator: User;
  let teammate: User;
  let creatorCookie: string;
  let teammateCookie: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-private-'));
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
    app.use('/d/*', sessionAuth({ redirect: true }));
    app.route('/', apiRoutes);
    app.route('/', frameRoutes);
    app.route('/', documentRoutes);
    app.route('/', pageRoutes);

    const now = new Date();
    creator = getOrCreateUser(db, 'creator@example.com', now);
    teammate = getOrCreateUser(db, 'teammate@example.com', now);
    creatorCookie = `session=${createSession(db, creator.id, now).token}`;
    teammateCookie = `session=${createSession(db, teammate.id, now).token}`;

    db.insert(documents)
      .values({ id: slug, title: 'Budget Draft', teamId: 'team-example', createdBy: creator.id, createdAt: now })
      .run();
    db.insert(versions).values({ id: v1Id, documentId: slug, number: 1, html: V1_HTML, publishedAt: now }).run();
    db.update(documents).set({ currentVersionId: v1Id }).where(eq(documents.id, slug)).run();
  });

  afterAll(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function postForm(cookie: string, fields: Record<string, string>) {
    return {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    };
  }

  function postJson(cookie: string, body: unknown) {
    return {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  function buildAnchor(sentence: string) {
    const text = indexVersionHtml(V1_HTML);
    const start = text.indexOf(sentence);
    return describeTextAnchor(text, start, start + sentence.length);
  }

  function watcherIds(): string[] {
    return db
      .select({ userId: watches.userId })
      .from(watches)
      .where(eq(watches.documentId, slug))
      .all()
      .map((w) => w.userId);
  }

  test('setup: the teammate comments (and auto-watches) while the document is team-visible', async () => {
    const res = await app.request(
      `/api/docs/${slug}/comments`,
      postJson(teammateCookie, { body: 'Numbers?', quotedText: QUOTE, anchor: buildAnchor(QUOTE), versionId: v1Id }),
    );
    expect(res.status).toBe(201);
    expect(watcherIds()).toContain(teammate.id);
  });

  test('a teammate cannot make the document private', async () => {
    const res = await app.request(`/d/${slug}/share`, postForm(teammateCookie, { visibility: 'private' }));
    expect(res.status).toBe(403);
    expect(db.select().from(documents).where(eq(documents.id, slug)).get()?.visibility).toBe('team');
  });

  test('the creator flips the document to private; teammate watches are pruned', async () => {
    // Give the creator a watch row too, to prove pruning spares only them.
    const now = new Date();
    db.insert(watches)
      .values({ documentId: slug, userId: creator.id, state: 'watching', lastNotifiedAt: now, createdAt: now, updatedAt: now })
      .run();

    const res = await app.request(`/d/${slug}/share`, postForm(creatorCookie, { visibility: 'private', next: `/d/${slug}` }));
    expect(res.status).toBe(302);
    expect(db.select().from(documents).where(eq(documents.id, slug)).get()?.visibility).toBe('private');
    expect(watcherIds()).toEqual([creator.id]);
  });

  test('a private document is invisible to a teammate on every surface', async () => {
    for (const path of [`/api/docs/${slug}`, `/api/docs/${slug}/comments`, `/api/docs/${slug}/export.json`, `/api/docs/${slug}/export.md`]) {
      const res = await app.request(path, { headers: { cookie: teammateCookie } });
      expect(res.status).toBe(404);
    }
    expect((await app.request(`/d/${slug}`, { headers: { cookie: teammateCookie } })).status).toBe(404);
    expect((await app.request(`/d/${slug}/frame`, { headers: { cookie: teammateCookie } })).status).toBe(404);
  });

  test('a teammate cannot flip a private document back (it does not exist for them)', async () => {
    const res = await app.request(`/d/${slug}/share`, postForm(teammateCookie, { visibility: 'team' }));
    expect(res.status).toBe(404);
  });

  test('the creator keeps full access, sees the Private state, and the teammate comment survives', async () => {
    const page = await app.request(`/d/${slug}`, { headers: { cookie: creatorCookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Only you');
    expect(html).toContain('Right now this link only opens for you.');

    const comments = await app.request(`/api/docs/${slug}/comments`, { headers: { cookie: creatorCookie } });
    expect(comments.status).toBe(200);
    const payload = (await comments.json()) as { comments: { body: string }[] };
    expect(payload.comments.map((c) => c.body)).toContain('Numbers?');
  });

  test('the home listing hides the private document from the teammate, badges it for the creator', async () => {
    const creatorHome = await (await app.request('/', { headers: { cookie: creatorCookie } })).text();
    expect(creatorHome).toContain('Budget Draft');
    expect(creatorHome).toContain('private-badge');

    const teammateHome = await (await app.request('/', { headers: { cookie: teammateCookie } })).text();
    expect(teammateHome).not.toContain('Budget Draft');
  });

  test("a teammate's token cannot republish a private document; the creator's can", () => {
    const teammateAttempt = publishArtifact(db, config, teammate, 'team-example', {
      title: 'Budget Draft',
      html: '<body>hijack</body>',
      documentId: slug,
    });
    expect(teammateAttempt.ok).toBe(false);
    if (!teammateAttempt.ok) expect(teammateAttempt.status).toBe(404);

    const creatorAttempt = publishArtifact(db, config, creator, 'team-example', {
      title: 'Budget Draft',
      html: '<body><p>Intro paragraph.</p><p>Updated numbers.</p></body>',
      documentId: slug,
    });
    expect(creatorAttempt.ok).toBe(true);
  });

  test('a teammate cannot republish a team document as private', () => {
    const now = new Date();
    db.insert(documents)
      .values({ id: 'team-doc', title: 'Team Doc', teamId: 'team-example', createdBy: creator.id, createdAt: now })
      .run();
    db.insert(versions).values({ id: 'ver-t1', documentId: 'team-doc', number: 1, html: V1_HTML, publishedAt: now }).run();
    db.update(documents).set({ currentVersionId: 'ver-t1' }).where(eq(documents.id, 'team-doc')).run();

    const attempt = publishArtifact(db, config, teammate, 'team-example', {
      title: 'Team Doc',
      html: '<body>v2</body>',
      documentId: 'team-doc',
      visibility: 'private',
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.status).toBe(400);
      expect(attempt.error).toContain('only the creator');
    }
    expect(db.select().from(documents).where(eq(documents.id, 'team-doc')).get()?.visibility).toBe('team');
  });

  test('the creator flips back to team; the teammate regains access with comments intact', async () => {
    const res = await app.request(`/d/${slug}/share`, postForm(creatorCookie, { visibility: 'team' }));
    expect(res.status).toBe(302);

    const comments = await app.request(`/api/docs/${slug}/comments`, { headers: { cookie: teammateCookie } });
    expect(comments.status).toBe(200);
    const payload = (await comments.json()) as { comments: { body: string }[] };
    expect(payload.comments.map((c) => c.body)).toContain('Numbers?');
  });

  test('a creator removed from the team loses access to their private document', async () => {
    // Back to private first (the previous test flipped it to team).
    expect((await app.request(`/d/${slug}/share`, postForm(creatorCookie, { visibility: 'private' }))).status).toBe(302);

    expect(removeMember(db, 'team-example', creator.id)).toBe(true);

    for (const path of [`/api/docs/${slug}`, `/api/docs/${slug}/comments`, `/api/docs/${slug}/export.json`]) {
      expect((await app.request(path, { headers: { cookie: creatorCookie } })).status).toBe(404);
    }
    expect((await app.request(`/d/${slug}`, { headers: { cookie: creatorCookie } })).status).toBe(404);
    expect((await app.request(`/d/${slug}/frame`, { headers: { cookie: creatorCookie } })).status).toBe(404);

    // Nor can they comment (and auto-watch) their way back in.
    const res = await app.request(
      `/api/docs/${slug}/comments`,
      postJson(creatorCookie, { body: 'Still here?', quotedText: QUOTE, anchor: buildAnchor(QUOTE), versionId: v1Id }),
    );
    expect(res.status).toBe(404);
  });
});
