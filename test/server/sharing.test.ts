// @vitest-environment node
//
// Cookie-based auth needs Node's native fetch (see test/server/auth.test.ts
// for why happy-dom can't observe Set-Cookie / cookie headers).

/**
 * Public sharing: documents flipped to visibility 'public' are readable and
 * fully interactive for any signed-in user, revocation (flip back to 'team')
 * restores the 404 invisibility and prunes outsiders' watches, and the home
 * page grows a "Shared with you" section for outsiders who interacted.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { describeTextAnchor } from '../../src/anchoring/text.js';
import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { Config } from '../../src/server/config.js';
import type { AppEnv } from '../../src/server/context.js';
import { documents, openDb, versions, watches, type DB } from '../../src/server/db/index.js';
import { sessionAuth } from '../../src/server/middleware.js';
import { apiRoutes, findDocumentForViewer } from '../../src/server/routes/api.js';
import { documentRoutes } from '../../src/server/routes/document.js';
import { frameRoutes } from '../../src/server/routes/frame.js';
import { pageRoutes } from '../../src/server/routes/pages.js';
import { indexVersionHtml } from '../../src/server/services/anchorStates.js';
import { publishArtifact } from '../../src/server/services/publish.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const QUOTE = 'The launch plan is ready for review.';
const V1_HTML = `<body><p>Intro paragraph.</p><p>${QUOTE}</p><p>Closing paragraph.</p></body>`;

describe('public sharing', () => {
  let tmpDir: string;
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let config: Config;
  let app: Hono<AppEnv>;

  const slug = 'launch-plan';
  const v1Id = 'ver-1';
  let ownerId: string;
  let outsiderId: string;
  let ownerCookie: string;
  let outsiderCookie: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-sharing-'));
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
    const owner = getOrCreateUser(db, 'owner@example.com', now);
    // No team at all — the "shared to a user with no teams" case.
    const outsider = getOrCreateUser(db, 'guest@other-domain.com', now);
    ownerId = owner.id;
    outsiderId = outsider.id;
    ownerCookie = `session=${createSession(db, owner.id, now).token}`;
    outsiderCookie = `session=${createSession(db, outsider.id, now).token}`;

    db.insert(documents)
      .values({ id: slug, title: 'Launch Plan', teamId: 'team-example', createdBy: owner.id, createdAt: now })
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

  function watchRows(): { userId: string }[] {
    return db.select({ userId: watches.userId }).from(watches).where(eq(watches.documentId, slug)).all();
  }

  test('a team-only document is invisible to an outsider on every surface', async () => {
    for (const path of [`/api/docs/${slug}`, `/api/docs/${slug}/comments`, `/api/docs/${slug}/export.json`]) {
      const res = await app.request(path, { headers: { cookie: outsiderCookie } });
      expect(res.status).toBe(404);
    }
    expect((await app.request(`/d/${slug}`, { headers: { cookie: outsiderCookie } })).status).toBe(404);
    expect((await app.request(`/d/${slug}/frame`, { headers: { cookie: outsiderCookie } })).status).toBe(404);
  });

  test('an outsider cannot toggle sharing', async () => {
    const res = await app.request(`/d/${slug}/share`, postForm(outsiderCookie, { visibility: 'public' }));
    expect(res.status).toBe(404);
  });

  test('a member flips the document to public', async () => {
    const res = await app.request(`/d/${slug}/share`, postForm(ownerCookie, { visibility: 'public', next: `/d/${slug}` }));
    expect(res.status).toBe(302);
    expect(db.select().from(documents).where(eq(documents.id, slug)).get()?.visibility).toBe('public');
  });

  test('the share route rejects unknown visibility values', async () => {
    const res = await app.request(`/d/${slug}/share`, postForm(ownerCookie, { visibility: 'everyone' }));
    expect(res.status).toBe(400);
  });

  test('a public document opens for the outsider: page, frame, metadata, exports', async () => {
    const page = await app.request(`/d/${slug}`, { headers: { cookie: outsiderCookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Shared with you');
    expect(html).not.toContain('Who can open this artifact'); // the Share menu is members-only

    expect((await app.request(`/d/${slug}/frame`, { headers: { cookie: outsiderCookie } })).status).toBe(200);

    const meta = await app.request(`/api/docs/${slug}`, { headers: { cookie: outsiderCookie } });
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { document: { visibility: string } }).document.visibility).toBe('public');

    expect((await app.request(`/api/docs/${slug}/export.json`, { headers: { cookie: outsiderCookie } })).status).toBe(200);
    expect((await app.request(`/api/docs/${slug}/export.md`, { headers: { cookie: outsiderCookie } })).status).toBe(200);
  });

  test('the member sees the Share menu with both visibility options', async () => {
    const page = await app.request(`/d/${slug}`, { headers: { cookie: ownerCookie } });
    const html = await page.text();
    expect(html).toContain('Who can open this artifact');
    expect(html).toContain('Team only');
    expect(html).toContain('Anyone with the link');
    expect(html).not.toContain('Shared with you');
  });

  let outsiderThreadId: string;

  test('the outsider comments, flagged as a guest; members are not', async () => {
    const res = await app.request(
      `/api/docs/${slug}/comments`,
      postJson(outsiderCookie, { body: 'looks great', quotedText: QUOTE, anchor: buildAnchor(QUOTE), versionId: v1Id }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; author: { email: string; isGuest: boolean } };
    outsiderThreadId = created.id;
    expect(created.author.isGuest).toBe(true);

    const reply = await app.request(`/api/comments/${outsiderThreadId}/replies`, postJson(ownerCookie, { body: 'thanks!' }));
    expect(reply.status).toBe(201);
    expect(((await reply.json()) as { author: { isGuest: boolean } }).author.isGuest).toBe(false);
  });

  test('the outsider resolves and reopens threads like a member', async () => {
    const resolved = await app.request(`/api/comments/${outsiderThreadId}/resolve`, postJson(outsiderCookie, {}));
    expect(resolved.status).toBe(200);
    const reopened = await app.request(`/api/comments/${outsiderThreadId}/reopen`, postJson(outsiderCookie, {}));
    expect(reopened.status).toBe(200);
  });

  test('commenting auto-watched the outsider; the home page lists the document under "Shared with you"', async () => {
    expect(watchRows().map((w) => w.userId)).toContain(outsiderId);

    const home = await app.request('/', { headers: { cookie: outsiderCookie } });
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain('Shared with you');
    expect(html).toContain('Launch Plan');
  });

  test('members do not get a "Shared with you" section for their own team documents', async () => {
    const home = await app.request('/', { headers: { cookie: ownerCookie } });
    const html = await home.text();
    expect(html).not.toContain('Shared with you');
  });

  test('flipping back to team-only 404s the outsider and prunes exactly their watches', async () => {
    // The member watches too (via the Watch button) so the pruning has a survivor to keep.
    await app.request(`/d/${slug}/watch`, postForm(ownerCookie, { watching: 'true' }));
    expect(watchRows().map((w) => w.userId).sort()).toEqual([outsiderId, ownerId].sort());

    const res = await app.request(`/d/${slug}/share`, postForm(ownerCookie, { visibility: 'team' }));
    expect(res.status).toBe(302);

    expect(watchRows().map((w) => w.userId)).toEqual([ownerId]);
    expect(findDocumentForViewer(db, slug, outsiderId)).toBeUndefined();
    expect((await app.request(`/d/${slug}`, { headers: { cookie: outsiderCookie } })).status).toBe(404);
    expect((await app.request(`/api/docs/${slug}/comments`, { headers: { cookie: outsiderCookie } })).status).toBe(404);

    const home = await app.request('/', { headers: { cookie: outsiderCookie } });
    expect(await home.text()).not.toContain('Launch Plan');
  });

  test('the share panel marks the current visibility checked, with its CSS unescaped', async () => {
    const page = await (await app.request(`/d/${slug}`, { headers: { cookie: ownerCookie } })).text();
    // The checked option is only visible if its style rule survives: JSX
    // escaping once turned the quotes in this selector into &#39;, which
    // browsers never decode inside <style>, silently dropping the rule.
    expect(page).toContain(".share-option[aria-checked='true']");
    const options = [...page.matchAll(/<input type="hidden" name="visibility" value="(\w+)"[\s\S]*?aria-checked="(\w+)"/g)];
    expect(options.map(([, value, state]) => `${value}:${state}`)).toEqual(['private:false', 'team:true', 'public:false']);
  });

  test('findDocumentForViewer reports membership', async () => {
    expect(findDocumentForViewer(db, slug, ownerId)).toMatchObject({ isMember: true });
    db.update(documents).set({ visibility: 'public' }).where(eq(documents.id, slug)).run();
    expect(findDocumentForViewer(db, slug, outsiderId)).toMatchObject({ isMember: false });
    db.update(documents).set({ visibility: 'team' }).where(eq(documents.id, slug)).run();
  });

  test('publish honors visibility on create, keeps it when omitted, and prunes watches when flipping to team', async () => {
    const owner = { id: ownerId, email: 'owner@example.com', name: null, isInstanceAdmin: false, createdAt: new Date() };

    const created = publishArtifact(db, config, owner, 'team-example', {
      title: 'Public From Birth',
      html: '<body><p>hi</p></body>',
      visibility: 'public',
    });
    if (!created.ok) throw new Error(created.error);
    const doc = () => db.select().from(documents).where(eq(documents.id, created.documentId)).get();
    expect(doc()?.visibility).toBe('public');

    // The outsider interacts, gaining a watch row.
    db.insert(watches)
      .values({ documentId: created.documentId, userId: outsiderId, state: 'watching', lastNotifiedAt: new Date(), createdAt: new Date(), updatedAt: new Date() })
      .run();

    // Republish without visibility: unchanged.
    const kept = publishArtifact(db, config, owner, 'team-example', {
      title: 'Public From Birth',
      html: '<body><p>hi again</p></body>',
      documentId: created.documentId,
    });
    expect(kept.ok).toBe(true);
    expect(doc()?.visibility).toBe('public');

    // Republish flipping to team: visibility updates and the outsider's watch is pruned.
    const flipped = publishArtifact(db, config, owner, 'team-example', {
      title: 'Public From Birth',
      html: '<body><p>private now</p></body>',
      documentId: created.documentId,
      visibility: 'team',
    });
    expect(flipped.ok).toBe(true);
    expect(doc()?.visibility).toBe('team');
    const remaining = db
      .select({ userId: watches.userId })
      .from(watches)
      .where(and(eq(watches.documentId, created.documentId), eq(watches.userId, outsiderId)))
      .all();
    expect(remaining).toEqual([]);
  });
});
