// @vitest-environment node

/**
 * Watch + digest behavior: auto-watch on publish/comment, sticky unwatch,
 * the 5-minute quiet window, self-comment exclusion, cursor advancement, and
 * retry-on-send-failure.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { getOrCreateUser } from '../../src/server/auth.js';
import type { Config } from '../../src/server/config.js';
import { commentAnchorStates, comments, documents, openDb, versions, watches, type DB, type User } from '../../src/server/db/index.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';
import { createReply, createThreadComment } from '../../src/server/services/comments.js';
import { publishArtifact } from '../../src/server/services/publish.js';
import {
  autoWatch,
  DIGEST_QUIET_MS,
  isWatching,
  runDigestSweep,
  setWatching,
  watchForMention,
  type DigestEmail,
} from '../../src/server/services/watches.js';

const BASE_URL = 'http://localhost:3000';

const T0 = new Date('2026-08-07T10:00:00Z');
/** `T0` plus `minutes`. */
function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60 * 1000);
}
/** A `now` that is comfortably past the quiet window after `last`. */
function quietAfter(last: Date): Date {
  return new Date(last.getTime() + DIGEST_QUIET_MS + 60 * 1000);
}

describe('watches', () => {
  let tmpDir: string;
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let alice: User;
  let bob: User;
  let carol: User;
  let commentSeq = 0;

  const config: Config = baseTestConfig({ baseUrl: BASE_URL });

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-watches-'));
    const opened = openDb(join(tmpDir, 'app.db'));
    db = opened.db;
    sqlite = opened.sqlite;

    seedTeamWithDomain(db, 'team-example', 'example.com');
    alice = getOrCreateUser(db, 'alice@example.com', T0);
    bob = getOrCreateUser(db, 'bob@example.com', T0);
    carol = getOrCreateUser(db, 'carol@example.com', T0);
  });

  afterAll(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.delete(watches).run();
    db.delete(commentAnchorStates).run();
    db.delete(comments).run();
  });

  function makeDoc(id: string): void {
    db.insert(documents)
      .values({ id, title: `Doc ${id}`, teamId: 'team-example', createdBy: alice.id, currentVersionId: null, createdAt: T0 })
      .run();
    db.insert(versions).values({ id: `${id}-v1`, documentId: id, number: 1, html: '<body>x</body>', publishedAt: T0 }).run();
  }

  function addComment(docId: string, author: User, createdAt: Date, body = 'a comment', parentId: string | null = null): string {
    const id = `c${++commentSeq}`;
    db.insert(comments)
      .values({
        id,
        documentId: docId,
        parentId,
        authorId: author.id,
        body,
        quotedText: parentId === null ? 'quoted' : '',
        anchor: 'null',
        status: 'open',
        createdVersionId: `${docId}-v1`,
        createdAt,
        resolvedAt: null,
        resolvedBy: null,
      })
      .run();
    return id;
  }

  /** A thread through the real creation path (auto-watch + mention handling), like the API and MCP do. */
  function postThread(docId: string, author: User, body: string, now: Date): string {
    const document = db.select().from(documents).where(eq(documents.id, docId)).get()!;
    const version = db.select().from(versions).where(eq(versions.id, `${docId}-v1`)).get()!;
    const anchor = { v: 1 as const, exact: 'x', prefix: '', suffix: '', start: 0, docLength: 1 };
    return createThreadComment(db, { document, version, authorId: author.id, body, quotedText: 'x', anchor, via: null, now }).id;
  }

  /** Sweep with a collecting sender; returns what got "sent". */
  async function sweep(now: Date, failFor: string[] = []): Promise<DigestEmail[]> {
    const delivered: DigestEmail[] = [];
    await runDigestSweep(
      db,
      BASE_URL,
      async (email) => {
        if (failFor.includes(email.to)) throw new Error('smtp down');
        delivered.push(email);
      },
      now,
    );
    return delivered;
  }

  test('publishing auto-watches the publisher', () => {
    const result = publishArtifact(db, config, bob, 'team-example', { title: 'Bob doc', html: '<body>hi</body>' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isWatching(db, result.documentId, bob.id)).toBe(true);
  });

  test('auto-watch subscribes, but never overrides a sticky unwatch', () => {
    makeDoc('d-sticky');
    autoWatch(db, 'd-sticky', bob.id, at(1));
    expect(isWatching(db, 'd-sticky', bob.id)).toBe(true);

    setWatching(db, 'd-sticky', bob.id, false, at(2));
    expect(isWatching(db, 'd-sticky', bob.id)).toBe(false);

    // Commenting again would call autoWatch — the opt-out must survive it.
    autoWatch(db, 'd-sticky', bob.id, at(3));
    expect(isWatching(db, 'd-sticky', bob.id)).toBe(false);

    // Only the explicit toggle re-subscribes.
    setWatching(db, 'd-sticky', bob.id, true, at(4));
    expect(isWatching(db, 'd-sticky', bob.id)).toBe(true);
  });

  test('no email while the conversation is still active (quiet window)', async () => {
    makeDoc('d-quiet');
    autoWatch(db, 'd-quiet', alice.id, T0);
    addComment('d-quiet', bob, at(1));

    // 4 minutes after the last comment: still inside the quiet window.
    expect(await sweep(new Date(at(1).getTime() + 4 * 60 * 1000))).toEqual([]);
    // 6 minutes after: due.
    const sent = await sweep(new Date(at(1).getTime() + 6 * 60 * 1000));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('alice@example.com');
  });

  test('a burst becomes one email per watcher, excluding their own comments', async () => {
    makeDoc('d-burst');
    autoWatch(db, 'd-burst', alice.id, T0);
    const threadId = addComment('d-burst', bob, at(1), 'first!');
    autoWatch(db, 'd-burst', bob.id, at(1));
    addComment('d-burst', carol, at(2), 'a reply', threadId);
    autoWatch(db, 'd-burst', carol.id, at(2));

    const sent = await sweep(quietAfter(at(2)));

    // Alice (no comments of her own) gets both; bob only carol's reply;
    // carol saw everything before she joined and wrote the rest — no email.
    expect(sent.map((e) => e.to).sort()).toEqual(['alice@example.com', 'bob@example.com']);
    const aliceEmail = sent.find((e) => e.to === 'alice@example.com')!;
    expect(aliceEmail.subject).toBe('2 new comments on "Doc d-burst"');
    expect(aliceEmail.text).toContain('first!');
    expect(aliceEmail.text).toContain('a reply');
    expect(aliceEmail.text).toContain(`${BASE_URL}/d/d-burst`);
    const bobEmail = sent.find((e) => e.to === 'bob@example.com')!;
    expect(bobEmail.subject).toBe('1 new comment on "Doc d-burst"');
    expect(bobEmail.text).not.toContain('first!');
    expect(bobEmail.text).toContain('a reply');

    // Cursors advanced: a later sweep sends nothing.
    expect(await sweep(quietAfter(at(3)))).toEqual([]);
  });

  test('digest names the access token when an agent posted the comment', async () => {
    makeDoc('d-agent');
    autoWatch(db, 'd-agent', alice.id, T0);
    const threadId = addComment('d-agent', bob, at(1), 'Numbers look off in table 2.');
    db.update(comments).set({ viaTokenId: 'tok1', viaTokenLabel: 'Codex' }).where(eq(comments.id, threadId)).run();
    addComment('d-agent', carol, at(2), 'Agree, will fix.', threadId);

    const sent = await sweep(quietAfter(at(2)));
    const aliceEmail = sent.find((e) => e.to === 'alice@example.com')!;
    expect(aliceEmail.text).toContain('bob@example.com (via Codex) commented on "quoted":');
    expect(aliceEmail.text).toContain('carol@example.com replied:');
  });

  test('own-only activity advances the cursor without emailing the author', async () => {
    makeDoc('d-own');
    autoWatch(db, 'd-own', alice.id, T0);
    autoWatch(db, 'd-own', bob.id, T0);
    addComment('d-own', alice, at(1), 'note to self');

    const sent = await sweep(quietAfter(at(1)));
    expect(sent.map((e) => e.to)).toEqual(['bob@example.com']);

    // Alice's cursor still advanced past her own comment: nothing later.
    expect(await sweep(quietAfter(at(2)))).toEqual([]);
  });

  test('unwatched users get nothing', async () => {
    makeDoc('d-unwatched');
    autoWatch(db, 'd-unwatched', alice.id, T0);
    setWatching(db, 'd-unwatched', alice.id, false, T0);
    addComment('d-unwatched', bob, at(1));

    expect(await sweep(quietAfter(at(1)))).toEqual([]);
  });

  test('a failed send leaves the cursor untouched and retries next sweep', async () => {
    makeDoc('d-retry');
    autoWatch(db, 'd-retry', alice.id, T0);
    addComment('d-retry', bob, at(1));

    expect(await sweep(quietAfter(at(1)), ['alice@example.com'])).toEqual([]);

    const retried = await sweep(quietAfter(at(1)));
    expect(retried.map((e) => e.to)).toEqual(['alice@example.com']);
  });

  test('mentioning a teammate subscribes them — even over a sticky unwatch — and mails them that comment', async () => {
    makeDoc('d-mention');
    setWatching(db, 'd-mention', bob.id, false, T0);
    addComment('d-mention', carol, at(1), 'earlier chatter');

    postThread('d-mention', alice, 'Can you check this, @bob@example.com?', at(2));
    expect(isWatching(db, 'd-mention', bob.id)).toBe(true);

    const sent = await sweep(quietAfter(at(2)));
    const bobEmail = sent.find((e) => e.to === 'bob@example.com')!;
    expect(bobEmail.subject).toBe('1 new comment on "Doc d-mention" (you were mentioned)');
    expect(bobEmail.text).toContain('alice@example.com mentioned you on "x":');
    expect(bobEmail.text).toContain('Can you check this, @bob@example.com?');
    // Re-subscribing by mention starts at the mention, not at the backlog.
    expect(bobEmail.text).not.toContain('earlier chatter');
  });

  test('a mention in a reply subscribes the mentioned teammate too', async () => {
    makeDoc('d-mention-reply');
    const threadId = postThread('d-mention-reply', alice, 'thread start', at(1));
    const parent = db.select().from(comments).where(eq(comments.id, threadId)).get()!;
    createReply(db, { parent, authorId: bob.id, body: '@carol@example.com thoughts?', via: null, now: at(2) });
    expect(isWatching(db, 'd-mention-reply', carol.id)).toBe(true);

    const sent = await sweep(quietAfter(at(2)));
    const carolEmail = sent.find((e) => e.to === 'carol@example.com')!;
    expect(carolEmail.text).toContain('bob@example.com mentioned you in a reply:');
    expect(carolEmail.text).not.toContain('thread start');
  });

  test('mentions of outsiders, strangers, or yourself subscribe nobody extra', () => {
    makeDoc('d-mention-noop');
    setWatching(db, 'd-mention-noop', alice.id, false, T0);
    postThread('d-mention-noop', alice, 'cc @alice@example.com @nobody@elsewhere.org', at(1));
    const rows = db.select().from(watches).where(eq(watches.documentId, 'd-mention-noop')).all();
    // Alice's own sticky unwatch stands (self-mention is not a call-out); nobody else was added.
    expect(rows.map((r) => [r.userId, r.state])).toEqual([[alice.id, 'unwatched']]);
  });

  test('a mention on a private document subscribes nobody and leaks nothing by email', async () => {
    makeDoc('d-mention-private');
    db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, 'd-mention-private')).run();

    // Bob can't open the document, so tagging him must not subscribe him: the
    // sweep mails every 'watching' row without re-checking access.
    const threadId = postThread('d-mention-private', alice, 'secret numbers, @bob@example.com?', at(1));
    const parent = db.select().from(comments).where(eq(comments.id, threadId)).get()!;
    createReply(db, { parent, authorId: alice.id, body: 'and @carol@example.com', via: null, now: at(2) });

    const rows = db.select().from(watches).where(eq(watches.documentId, 'd-mention-private')).all();
    expect(rows.map((r) => r.userId)).toEqual([alice.id]);

    const sent = await sweep(quietAfter(at(2)));
    expect(sent).toEqual([]);
  });

  test('watchForMention leaves an existing watcher\'s cursor alone', () => {
    makeDoc('d-mention-keep');
    autoWatch(db, 'd-mention-keep', bob.id, T0);
    watchForMention(db, 'd-mention-keep', bob.id, at(5));
    const row = db.select().from(watches).where(eq(watches.userId, bob.id)).get()!;
    expect(row.state).toBe('watching');
    expect(row.lastNotifiedAt).toEqual(T0);
  });

  test('the watches migration backfills existing creators and commenters', () => {
    // Replay history by hand: schema before watches, then data, then the
    // watches migration — asserting the backfill sees pre-existing rows.
    const raw = new Database(join(tmpDir, 'backfill.db'));
    const applyMigration = (file: string): void => {
      const sql = readFileSync(join(process.cwd(), 'drizzle', file), 'utf8');
      for (const stmt of sql.split('--> statement-breakpoint')) raw.exec(stmt);
    };
    applyMigration('0000_lame_scarecrow.sql');
    applyMigration('0001_deep_madripoor.sql');

    const now = T0.getTime();
    raw.exec(`
      INSERT INTO users (id, email, domain, created_at) VALUES
        ('u-owner', 'owner@example.com', 'example.com', ${now}),
        ('u-commenter', 'commenter@example.com', 'example.com', ${now}),
        ('u-bystander', 'bystander@example.com', 'example.com', ${now});
      INSERT INTO documents (id, title, domain, created_by, current_version_id, created_at)
        VALUES ('doc-1', 'Old doc', 'example.com', 'u-owner', NULL, ${now});
      INSERT INTO versions (id, document_id, number, html, published_at)
        VALUES ('v-1', 'doc-1', 1, '<body>x</body>', ${now});
      INSERT INTO comments (id, document_id, parent_id, author_id, body, quoted_text, anchor, status, created_version_id, created_at)
        VALUES ('c-1', 'doc-1', NULL, 'u-commenter', 'hi', 'q', 'null', 'open', 'v-1', ${now});
    `);
    applyMigration('0002_watches.sql');

    const rows = raw
      .prepare('SELECT user_id, state FROM watches WHERE document_id = ? ORDER BY user_id')
      .all('doc-1') as { user_id: string; state: string }[];
    raw.close();

    expect(rows).toEqual([
      { user_id: 'u-commenter', state: 'watching' },
      { user_id: 'u-owner', state: 'watching' },
    ]);
  });

  test('re-watching starts fresh instead of delivering the backlog', async () => {
    makeDoc('d-rewatch');
    autoWatch(db, 'd-rewatch', alice.id, T0);
    setWatching(db, 'd-rewatch', alice.id, false, T0);
    addComment('d-rewatch', bob, at(1), 'missed while away');
    setWatching(db, 'd-rewatch', alice.id, true, at(2));

    expect(await sweep(quietAfter(at(2)))).toEqual([]);

    addComment('d-rewatch', bob, at(10), 'fresh news');
    const sent = await sweep(quietAfter(at(10)));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('fresh news');
    expect(sent[0]!.text).not.toContain('missed while away');
  });
});
