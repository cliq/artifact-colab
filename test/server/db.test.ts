import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { commentAnchorStates, comments, documents, openDb, users, versions, type DB } from '../../src/server/db/index.js';
import { seedTeamWithDomain } from './teamTestUtils.js';

describe('db', () => {
  let tmpDir: string;
  let db: DB;
  let sqlite: import('better-sqlite3').Database;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-db-'));
    const opened = openDb(join(tmpDir, 'app.db'));
    db = opened.db;
    sqlite = opened.sqlite;
  });

  afterAll(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runs migrations and creates all tables', () => {
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      [
        'assets',
        'comment_anchor_states',
        'comments',
        'documents',
        'login_codes',
        'sessions',
        'team_domains',
        'team_exclusions',
        'team_invites',
        'team_members',
        'teams',
        'tokens',
        'users',
        'versions',
        'watches',
      ].sort(),
    );
  });

  test('inserts and reads back a full document/comment graph, round-tripping timestamps as Date', () => {
    const now = new Date();

    seedTeamWithDomain(db, 'team-example', 'example.com');
    db.insert(users)
      .values({ id: 'user-1', email: 'alice@example.com', createdAt: now })
      .run();

    db.insert(documents)
      .values({
        id: 'doc-1',
        title: 'Q3 Report',
        teamId: 'team-example',
        createdBy: 'user-1',
        createdAt: now,
      })
      .run();

    db.insert(versions)
      .values({ id: 'ver-1', documentId: 'doc-1', number: 1, html: '<h1>Report</h1>', publishedAt: now })
      .run();

    db.update(documents).set({ currentVersionId: 'ver-1' }).where(eq(documents.id, 'doc-1')).run();

    const anchor = JSON.stringify({ quote: 'Report', prefix: '<h1>', suffix: '</h1>', position: 0 });
    db.insert(comments)
      .values({
        id: 'comment-1',
        documentId: 'doc-1',
        authorId: 'user-1',
        body: 'Looks good',
        quotedText: 'Report',
        anchor,
        createdVersionId: 'ver-1',
        createdAt: now,
      })
      .run();

    db.insert(commentAnchorStates)
      .values({ commentId: 'comment-1', versionId: 'ver-1', state: 'anchored', start: 4, end: 10 })
      .run();

    const doc = db.query.documents.findFirst({ where: eq(documents.id, 'doc-1') }).sync();
    expect(doc).toBeDefined();
    expect(doc?.currentVersionId).toBe('ver-1');
    expect(doc?.createdAt).toBeInstanceOf(Date);
    expect(doc?.createdAt.getTime()).toBe(now.getTime());

    const comment = db.query.comments.findFirst({ where: eq(comments.id, 'comment-1') }).sync();
    expect(comment).toBeDefined();
    expect(comment?.status).toBe('open');
    expect(comment?.quotedText).toBe('Report');
    expect(JSON.parse(comment?.anchor ?? '{}')).toEqual({ quote: 'Report', prefix: '<h1>', suffix: '</h1>', position: 0 });
    expect(comment?.createdAt).toBeInstanceOf(Date);

    const anchorState = db.query.commentAnchorStates
      .findFirst({
        where: eq(commentAnchorStates.commentId, 'comment-1'),
      })
      .sync();
    expect(anchorState).toEqual({ commentId: 'comment-1', versionId: 'ver-1', state: 'anchored', start: 4, end: 10 });
  });

  test('enforces the unique constraint on users.email', () => {
    expect(() =>
      db.insert(users).values({ id: 'user-2', email: 'alice@example.com', createdAt: new Date() }).run(),
    ).toThrow();
  });

  test('enforces foreign keys: a comment referencing an unknown document is rejected', () => {
    expect(() =>
      db
        .insert(comments)
        .values({
          id: 'comment-2',
          documentId: 'doc-does-not-exist',
          authorId: 'user-1',
          body: 'orphan fk test',
          quotedText: 'x',
          anchor: '{}',
          createdVersionId: 'ver-1',
          createdAt: new Date(),
        })
        .run(),
    ).toThrow();
  });
});
