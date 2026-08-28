/**
 * Seeds a scratch database with a long artifact and a deliberately awkward
 * set of comments, for eyeballing the sidebar's card alignment:
 *
 *   - two comments on the same sentence (equal anchor y)
 *   - three comments packed into one short paragraph
 *   - a thread with many replies (a very tall card)
 *   - a comment inside a closed <details> (zero-size range)
 *   - an ambiguous anchor (repeated sentence) and an orphaned one
 *   - comments far below the fold, and one on the very last line
 *   - a resolved comment
 *
 * Usage: DATABASE_PATH=test-results/alignment-tmp/app.db npx tsx scripts/alignment-baseline.ts
 * Prints the document URL path and a session cookie for the viewer.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { describeTextAnchor } from '../src/anchoring/text.js';
import { createSession, getOrCreateUser } from '../src/server/auth.js';
import { comments, documents, openDb, teamDomains, teams, versions } from '../src/server/db/index.js';
import { indexVersionHtml } from '../src/server/services/anchorStates.js';

const SLUG = 'alignment-baseline';
const REPEATED = 'This sentence appears more than once in the document.';

function section(n: number, extra = ''): string {
  return `
<h2 id="s${n}">Section ${n}: ${['Scope', 'Timeline', 'Risks', 'Budget', 'Staffing', 'Rollout', 'Metrics', 'Support'][n % 8]}</h2>
<p>Paragraph ${n}.1 sets the stage for section ${n}. It runs long enough to wrap across several lines in a typical viewer,
so anchors inside it land at distinct vertical positions. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do
eiusmod tempor incididunt ut labore et dolore magna aliqua. Unique marker S${n}A ends this paragraph.</p>
${extra}
<p>Paragraph ${n}.2 continues with supporting detail. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris
nisi ut aliquip ex ea commodo consequat. Unique marker S${n}B ends this paragraph.</p>`;
}

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>body{font:16px/1.6 Georgia,serif;max-width:720px;margin:40px auto;padding:0 24px;color:#222}h1{font-size:32px}h2{margin-top:40px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}details{margin:16px 0;padding:8px 12px;border:1px solid #ddd}</style>
</head><body>
<h1>Alignment Baseline</h1>
<p class="lede">The opening line carries the first comment. A second comment sits on the very same line to test ties.</p>
<p>Dense paragraph: alpha claim here. Beta claim here. Gamma claim here. All three are commented.</p>
<p>${REPEATED}</p>
${section(1)}
${section(2, `<details><summary>Hidden appendix (closed by default)</summary><p>The hidden sentence inside the closed details element is commented.</p></details>`)}
${section(3, `<table><tr><th>Item</th><th>Owner</th></tr><tr><td>Table cell under review</td><td>Alice</td></tr></table>`)}
${section(4)}
<p>${REPEATED}</p>
${section(5)}
${section(6)}
${section(7)}
${section(8)}
<p>The closing line is the last thing in the document.</p>
</body></html>`;

const dbPath = process.env.DATABASE_PATH ?? 'test-results/alignment-tmp/app.db';
mkdirSync(dirname(dbPath), { recursive: true });
const { db, sqlite } = openDb(dbPath);
const now = new Date('2026-08-28T12:00:00Z');

db.insert(teams).values({ id: 'team-example', name: 'Example', createdAt: now }).onConflictDoNothing().run();
db.insert(teamDomains).values({ domain: 'example.com', teamId: 'team-example', createdAt: now }).onConflictDoNothing().run();
const alice = getOrCreateUser(db, 'alice@example.com', now);
const bob = getOrCreateUser(db, 'bob@example.com', now);

db.insert(documents)
  .values({ id: SLUG, title: 'Alignment Baseline', teamId: 'team-example', createdBy: alice.id, createdAt: now })
  .onConflictDoNothing()
  .run();
db.delete(comments).where((await import('drizzle-orm')).eq(comments.documentId, SLUG)).run();
db.delete(versions).where((await import('drizzle-orm')).eq(versions.documentId, SLUG)).run();
db.insert(versions).values({ id: 'ver-baseline', documentId: SLUG, number: 1, html: HTML, publishedAt: now, publishedBy: alice.id }).run();
db.update(documents).set({ currentVersionId: 'ver-baseline' }).where((await import('drizzle-orm')).eq(documents.id, SLUG)).run();

const text = indexVersionHtml(HTML);
let seq = 0;
function comment(
  quote: string,
  body: string,
  opts: { author?: typeof alice; replies?: number; status?: 'open' | 'resolved'; occurrence?: number; orphan?: boolean } = {},
): void {
  let start = -1;
  if (!opts.orphan) {
    start = text.indexOf(quote);
    for (let i = 1; i < (opts.occurrence ?? 1) && start !== -1; i++) start = text.indexOf(quote, start + 1);
    if (start === -1) throw new Error(`quote not found: ${quote}`);
  }
  const anchor = opts.orphan
    ? { exact: quote, prefix: 'nonexistent prefix ', suffix: ' nonexistent suffix', start: 10 }
    : describeTextAnchor(text, start, start + quote.length);
  const id = `c${String(++seq).padStart(2, '0')}`;
  const author = opts.author ?? alice;
  const created = new Date(now.getTime() + seq * 60_000);
  db.insert(comments)
    .values({
      id,
      documentId: SLUG,
      parentId: null,
      authorId: author.id,
      body,
      quotedText: quote,
      anchor: JSON.stringify(anchor),
      status: opts.status ?? 'open',
      createdVersionId: 'ver-baseline',
      createdAt: created,
      resolvedAt: opts.status === 'resolved' ? created : null,
      resolvedBy: opts.status === 'resolved' ? bob.id : null,
    })
    .run();
  for (let r = 0; r < (opts.replies ?? 0); r++) {
    db.insert(comments)
      .values({
        id: `${id}-r${r}`,
        documentId: SLUG,
        parentId: id,
        authorId: r % 2 === 0 ? bob.id : alice.id,
        body: `Reply ${r + 1}: ${['Agreed.', 'Not sure this holds — see the timeline section.', 'Fixed in the next revision.', 'Can we get a source for this?'][r % 4]}`,
        quotedText: quote,
        anchor: JSON.stringify(anchor),
        status: 'open',
        createdVersionId: 'ver-baseline',
        createdAt: new Date(created.getTime() + (r + 1) * 1000),
      })
      .run();
  }
}

comment('The opening line carries the first comment.', 'First comment, top of the document.');
comment('same line', 'Second comment on the same line as the first — a tie in anchor position.', { author: bob });
comment('alpha claim', 'Alpha: needs a citation.');
comment('Beta claim', 'Beta: this contradicts section 3.', { author: bob });
comment('Gamma claim', 'Gamma: fine as is, but the wording is awkward and this comment body is intentionally long so the card wraps to several lines and takes up vertical space in the sidebar.');
comment(REPEATED, 'This anchor is ambiguous: the sentence appears twice.', { occurrence: 1 });
comment('Unique marker S1A', 'A long discussion thread lives here.', { replies: 8, author: bob });
comment('The hidden sentence inside the closed details element is commented.', 'Anchor inside a closed <details>: zero-size range.');
comment('Table cell under review', 'Comment on a table cell.', { author: bob });
comment('Unique marker S4B', 'Mid-document comment, usually below the fold on first load.');
comment('Unique marker S6A', 'Far below the fold.', { author: bob, replies: 1 });
comment('The closing line is the last thing in the document.', 'Comment on the very last line.');
comment('This text no longer exists anywhere', 'Orphaned comment — its text was removed.', { orphan: true });
comment('Unique marker S2B', 'Already resolved.', { status: 'resolved' });

const { token } = createSession(db, alice.id, new Date());
sqlite.close();
console.log(JSON.stringify({ path: `/d/${SLUG}`, sessionCookie: token }));
