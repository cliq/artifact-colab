/**
 * Fixture-driven tests for the anchor-state service: one comment's quote
 * survives verbatim into v2 (anchored), one is removed entirely (orphaned),
 * and one becomes ambiguous because v2 duplicates its sentence (with
 * identical surrounding context) twice.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { describeTextAnchor, locateTextAnchor } from '../../src/anchoring/text.js';
import { commentAnchorStates, comments, documents, openDb, users, versions, type DB } from '../../src/server/db/index.js';
import { seedTeamWithDomain } from './teamTestUtils.js';
import {
  computeAnchorState,
  computeForComment,
  computeForCommentVersion,
  indexVersionHtml,
  recomputeForVersion,
} from '../../src/server/services/anchorStates.js';

const ALPHA_SENTENCE = 'Alpha sentence stays the same forever in this document.';
const BETA_SENTENCE = 'Beta sentence will be deleted in the next version of the doc.';
const GAMMA_SENTENCE = 'Gamma sentence will become ambiguous later on in this document.';

const V1_HTML = `<body>
<p>${ALPHA_SENTENCE}</p>
<p>${BETA_SENTENCE}</p>
<p>${GAMMA_SENTENCE}</p>
</body>`;

// Beta's paragraph is gone; Gamma's sentence now appears twice, each preceded
// by the exact same "Intro before duplicate..." paragraph, so both
// occurrences look identical from the anchor's point of view.
const V2_HTML = `<body>
<p>${ALPHA_SENTENCE}</p>
<p>Intro before duplicate one appears right here now.</p>
<p>${GAMMA_SENTENCE}</p>
<p>Intro before duplicate one appears right here now.</p>
<p>${GAMMA_SENTENCE}</p>
</body>`;

describe('anchorStates', () => {
  let tmpDir: string;
  let db: DB;
  let sqlite: import('better-sqlite3').Database;

  const docId = 'doc-1';
  const v1Id = 'ver-1';
  const v2Id = 'ver-2';
  const survivingCommentId = 'comment-alpha';
  const deletedCommentId = 'comment-beta';
  const ambiguousCommentId = 'comment-gamma';

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-anchor-states-'));
    const opened = openDb(join(tmpDir, 'app.db'));
    db = opened.db;
    sqlite = opened.sqlite;

    const now = new Date();
    seedTeamWithDomain(db, 'team-example', 'example.com');
    db.insert(users).values({ id: 'user-1', email: 'alice@example.com', createdAt: now }).run();
    db.insert(documents).values({ id: docId, title: 'Doc', teamId: 'team-example', createdBy: 'user-1', createdAt: now }).run();

    db.insert(versions).values({ id: v1Id, documentId: docId, number: 1, html: V1_HTML, publishedAt: now }).run();
    db.update(documents).set({ currentVersionId: v1Id }).where(eq(documents.id, docId)).run();

    const v1Text = indexVersionHtml(V1_HTML);

    // Sanity-check the fixture against the anchoring engine directly, so this
    // test fails loudly (rather than mysteriously) if either sentence choice
    // stops producing the exact orphaned/ambiguous outcome the test relies on.
    const gammaStart = v1Text.indexOf(GAMMA_SENTENCE);
    const gammaAnchor = describeTextAnchor(v1Text, gammaStart, gammaStart + GAMMA_SENTENCE.length);
    const v2Text = indexVersionHtml(V2_HTML);
    expect(locateTextAnchor(v2Text, gammaAnchor)?.ambiguous).toBe(true);
    const betaStart = v1Text.indexOf(BETA_SENTENCE);
    const betaAnchor = describeTextAnchor(v1Text, betaStart, betaStart + BETA_SENTENCE.length);
    expect(locateTextAnchor(v2Text, betaAnchor)).toBeNull();

    const anchorFor = (sentence: string) => {
      const start = v1Text.indexOf(sentence);
      return describeTextAnchor(v1Text, start, start + sentence.length);
    };

    db.insert(comments)
      .values({
        id: survivingCommentId,
        documentId: docId,
        authorId: 'user-1',
        body: 'looks fine',
        quotedText: ALPHA_SENTENCE,
        anchor: JSON.stringify(anchorFor(ALPHA_SENTENCE)),
        createdVersionId: v1Id,
        createdAt: now,
      })
      .run();

    db.insert(comments)
      .values({
        id: deletedCommentId,
        documentId: docId,
        authorId: 'user-1',
        body: 'this will be removed',
        quotedText: BETA_SENTENCE,
        anchor: JSON.stringify(anchorFor(BETA_SENTENCE)),
        createdVersionId: v1Id,
        createdAt: now,
      })
      .run();

    db.insert(comments)
      .values({
        id: ambiguousCommentId,
        documentId: docId,
        authorId: 'user-1',
        body: 'will become ambiguous',
        quotedText: GAMMA_SENTENCE,
        anchor: JSON.stringify(anchorFor(GAMMA_SENTENCE)),
        createdVersionId: v1Id,
        createdAt: now,
      })
      .run();

    // A reply carries no anchor of its own and must be ignored by anchor-state
    // computation entirely.
    db.insert(comments)
      .values({
        id: 'reply-1',
        documentId: docId,
        parentId: survivingCommentId,
        authorId: 'user-1',
        body: 'a reply',
        quotedText: '',
        anchor: 'null',
        createdVersionId: v1Id,
        createdAt: now,
      })
      .run();

    db.insert(versions).values({ id: v2Id, documentId: docId, number: 2, html: V2_HTML, publishedAt: now }).run();
  });

  afterAll(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function stateFor(commentId: string, versionId: string) {
    return db
      .select()
      .from(commentAnchorStates)
      .where(and(eq(commentAnchorStates.commentId, commentId), eq(commentAnchorStates.versionId, versionId)))
      .get();
  }

  test('recomputeForVersion classifies each top-level comment against v2 and counts orphans', () => {
    const result = recomputeForVersion(db, docId, v2Id);
    expect(result).toEqual({ orphaned: 1, total: 3 });

    const alpha = stateFor(survivingCommentId, v2Id);
    expect(alpha?.state).toBe('anchored');
    expect(alpha?.start).not.toBeNull();
    expect(alpha?.end).not.toBeNull();

    const beta = stateFor(deletedCommentId, v2Id);
    expect(beta).toEqual({ commentId: deletedCommentId, versionId: v2Id, state: 'orphaned', start: null, end: null });

    const gamma = stateFor(ambiguousCommentId, v2Id);
    expect(gamma?.state).toBe('ambiguous');
    expect(gamma?.start).not.toBeNull();

    // The reply has no anchor state row at all — it was never a candidate.
    expect(stateFor('reply-1', v2Id)).toBeUndefined();
  });

  test('recomputeForVersion replaces stale rows on re-run instead of duplicating them', () => {
    recomputeForVersion(db, docId, v2Id);
    recomputeForVersion(db, docId, v2Id);

    const rows = db.select().from(commentAnchorStates).where(eq(commentAnchorStates.versionId, v2Id)).all();
    expect(rows).toHaveLength(3);
  });

  test('computeForComment stores state against the document current version', () => {
    db.update(documents).set({ currentVersionId: v2Id }).where(eq(documents.id, docId)).run();

    computeForComment(db, deletedCommentId);

    expect(stateFor(deletedCommentId, v2Id)?.state).toBe('orphaned');
  });

  test('computeForCommentVersion stores state against an arbitrary (comment, version) pair', () => {
    computeForCommentVersion(db, survivingCommentId, v1Id);

    expect(stateFor(survivingCommentId, v1Id)?.state).toBe('anchored');
  });

  test('computeAnchorState classifies a located range directly from text + anchor', () => {
    const v1Text = indexVersionHtml(V1_HTML);
    const v2Text = indexVersionHtml(V2_HTML);
    const start = v1Text.indexOf(GAMMA_SENTENCE);
    const anchor = describeTextAnchor(v1Text, start, start + GAMMA_SENTENCE.length);

    expect(computeAnchorState(v2Text, anchor).state).toBe('ambiguous');
    expect(computeAnchorState(v1Text, anchor).state).toBe('anchored');
  });
});
