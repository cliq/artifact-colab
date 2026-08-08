// @vitest-environment node
//
// Same rationale as `test/server/auth.test.ts`: happy-dom strips `Set-Cookie`
// from every `Response`, which breaks cookie-based session/CSRF assertions.

/**
 * Deleting an artifact from the web UI: only its author or a team admin may
 * do it (everyone else 404s, matching the admin surfaces), and the cascade
 * removes versions, comments (with anchor states), watches, and assets.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApp } from '../../src/server/app.js';
import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import {
  assets,
  commentAnchorStates,
  comments,
  documents,
  openDb,
  versions,
  watches,
  type DB,
} from '../../src/server/db/index.js';
import { setTeamRole } from '../../src/server/services/teams.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const NOW = new Date('2026-08-08T12:00:00Z');

describe('DELETE artifact (POST /d/:slug/delete)', () => {
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let app: Hono<AppEnv>;

  beforeAll(() => {
    const opened = openDb(':memory:');
    db = opened.db;
    sqlite = opened.sqlite;
    seedTeamWithDomain(db, 'team-a', 'acme.com');
    seedTeamWithDomain(db, 'team-b', 'other.com');
    app = createApp({ db, config: baseTestConfig() });
  });

  afterAll(() => {
    sqlite.close();
  });

  function setCookieValue(res: Response, name: string): string | undefined {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [key, value] = pair.split('=');
      if (key === name) return value;
    }
    return undefined;
  }

  async function getCsrfCookie(): Promise<string> {
    const res = await app.request('/signin');
    const csrf = setCookieValue(res, 'csrf');
    if (!csrf) throw new Error('expected csrfProtect to issue a csrf cookie on GET /signin');
    return csrf;
  }

  function signedIn(email: string): { userId: string; sessionCookie: string } {
    const user = getOrCreateUser(db, email, NOW);
    const { token } = createSession(db, user.id, NOW);
    return { userId: user.id, sessionCookie: token };
  }

  /** A document with one version, an anchored comment, a watch, and an asset. */
  function seedFullDocument(id: string, teamId: string, createdBy: string, watcherId: string): void {
    db.insert(documents).values({ id, title: id, teamId, createdBy, currentVersionId: `${id}-v1`, createdAt: NOW }).run();
    db.insert(versions).values({ id: `${id}-v1`, documentId: id, number: 1, html: '<body>hello text</body>', publishedAt: NOW }).run();
    db.insert(comments)
      .values({
        id: `${id}-c1`,
        documentId: id,
        parentId: null,
        authorId: watcherId,
        body: 'a note',
        quotedText: 'hello text',
        anchor: '{}',
        createdVersionId: `${id}-v1`,
        createdAt: NOW,
      })
      .run();
    db.insert(commentAnchorStates)
      .values({ commentId: `${id}-c1`, versionId: `${id}-v1`, state: 'anchored', start: 0, end: 10 })
      .run();
    db.insert(watches)
      .values({ documentId: id, userId: watcherId, state: 'watching', lastNotifiedAt: NOW, createdAt: NOW, updatedAt: NOW })
      .run();
    db.insert(assets)
      .values({ id: `${id}-asset`, documentId: id, name: 'pic.png', mime: 'image/png', data: Buffer.from('x'), createdAt: NOW })
      .run();
  }

  async function requestDelete(slug: string, sessionCookie: string, method: 'GET' | 'POST'): Promise<Response> {
    const csrf = await getCsrfCookie();
    return app.request(`/d/${slug}/delete`, {
      method,
      headers: {
        cookie: `csrf=${csrf}; session=${sessionCookie}`,
        ...(method === 'POST'
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      ...(method === 'POST' ? { body: new URLSearchParams({ _csrf: csrf }).toString() } : {}),
    });
  }

  test('a team member who is not the author gets a 404, and the document survives', async () => {
    const author = signedIn('author1@acme.com');
    const member = signedIn('member1@acme.com');
    seedFullDocument('doc-guarded', 'team-a', author.userId, member.userId);

    expect((await requestDelete('doc-guarded', member.sessionCookie, 'GET')).status).toBe(404);
    expect((await requestDelete('doc-guarded', member.sessionCookie, 'POST')).status).toBe(404);
    expect(db.select().from(documents).where(eq(documents.id, 'doc-guarded')).get()).toBeDefined();
  });

  test('an outsider from another team gets a 404', async () => {
    const author = signedIn('author2@acme.com');
    const outsider = signedIn('outsider@other.com');
    seedFullDocument('doc-foreign', 'team-a', author.userId, author.userId);

    expect((await requestDelete('doc-foreign', outsider.sessionCookie, 'POST')).status).toBe(404);
    expect(db.select().from(documents).where(eq(documents.id, 'doc-foreign')).get()).toBeDefined();
  });

  test('the author sees the confirmation page and the delete cascades everything', async () => {
    const author = signedIn('author3@acme.com');
    const commenter = signedIn('member3@acme.com');
    seedFullDocument('doc-mine', 'team-a', author.userId, commenter.userId);

    const confirm = await requestDelete('doc-mine', author.sessionCookie, 'GET');
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('Delete doc-mine?');

    const res = await requestDelete('doc-mine', author.sessionCookie, 'POST');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');

    expect(db.select().from(documents).where(eq(documents.id, 'doc-mine')).get()).toBeUndefined();
    expect(db.select().from(versions).where(eq(versions.documentId, 'doc-mine')).all()).toHaveLength(0);
    expect(db.select().from(comments).where(eq(comments.documentId, 'doc-mine')).all()).toHaveLength(0);
    expect(db.select().from(commentAnchorStates).where(eq(commentAnchorStates.commentId, 'doc-mine-c1')).all()).toHaveLength(0);
    expect(db.select().from(watches).where(eq(watches.documentId, 'doc-mine')).all()).toHaveLength(0);
    expect(db.select().from(assets).where(eq(assets.documentId, 'doc-mine')).all()).toHaveLength(0);
  });

  test('a team admin who is not the author can delete', async () => {
    const author = signedIn('author4@acme.com');
    const admin = signedIn('admin4@acme.com');
    setTeamRole(db, 'team-a', admin.userId, 'admin');
    seedFullDocument('doc-admined', 'team-a', author.userId, author.userId);

    const res = await requestDelete('doc-admined', admin.sessionCookie, 'POST');
    expect(res.status).toBe(302);
    expect(db.select().from(documents).where(eq(documents.id, 'doc-admined')).get()).toBeUndefined();
  });
});
