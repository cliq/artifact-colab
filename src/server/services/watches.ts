/**
 * Watching and comment digests. Users auto-watch documents they publish or
 * comment on (unless they explicitly unwatched — that choice is sticky), and
 * can toggle watching on any document. A periodic sweep emails each watcher
 * the comments they haven't seen, but only once a document has been quiet for
 * `DIGEST_QUIET_MS` — so a burst of comments lands as one email, not many.
 */

import { and, eq, gt, inArray } from 'drizzle-orm';

import { extractMentionEmails } from '../../shared/mentions.js';
import type { DB } from '../db/index.js';
import { comments, documents, teamMembers, users, watches, type Comment, type User } from '../db/schema.js';

export const DIGEST_QUIET_MS = 5 * 60 * 1000;

/**
 * Subscribe as a side effect of creating or commenting. Never overwrites an
 * existing row: a sticky 'unwatched' must survive later comments.
 */
export function autoWatch(db: DB, documentId: string, userId: string, now: Date): void {
  db.insert(watches)
    .values({ documentId, userId, state: 'watching', lastNotifiedAt: now, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

/**
 * Subscribe someone because a comment mentioned them. Being called out by name
 * is an explicit signal, so unlike `autoWatch` this overrides a sticky
 * 'unwatched'. The cursor is placed just before the comment: the mentioned
 * person gets that comment in their next digest but not the backlog that
 * accumulated while they weren't watching. An existing 'watching' row keeps
 * its cursor — it already covers the comment.
 */
export function watchForMention(db: DB, documentId: string, userId: string, commentCreatedAt: Date): void {
  const justBefore = new Date(commentCreatedAt.getTime() - 1);
  const existing = db
    .select({ state: watches.state })
    .from(watches)
    .where(and(eq(watches.documentId, documentId), eq(watches.userId, userId)))
    .get();
  if (existing?.state === 'watching') return;
  db.insert(watches)
    .values({ documentId, userId, state: 'watching', lastNotifiedAt: justBefore, createdAt: commentCreatedAt, updatedAt: commentCreatedAt })
    .onConflictDoUpdate({
      target: [watches.documentId, watches.userId],
      set: { state: 'watching', lastNotifiedAt: justBefore, updatedAt: commentCreatedAt },
    })
    .run();
}

/**
 * The team members a comment body mentions (`@email`), looked up by email.
 * Outsiders — people who can't see the document — never resolve, so an `@`
 * in front of a stranger's address is just text.
 */
export function resolveMentions(db: DB, teamId: string, body: string): User[] {
  const emails = extractMentionEmails(body);
  if (emails.length === 0) return [];
  return db
    .select({ user: users })
    .from(users)
    .innerJoin(teamMembers, and(eq(teamMembers.userId, users.id), eq(teamMembers.teamId, teamId)))
    .where(inArray(users.email, emails))
    .all()
    .map((row) => row.user);
}

/**
 * Explicit toggle from the Watch button — the only path that clears
 * 'unwatched'. Resets the digest cursor: watching starts from now, never
 * from a backlog accumulated while unwatched.
 */
export function setWatching(db: DB, documentId: string, userId: string, watching: boolean, now: Date): void {
  const state = watching ? 'watching' : 'unwatched';
  db.insert(watches)
    .values({ documentId, userId, state, lastNotifiedAt: now, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [watches.documentId, watches.userId],
      set: { state, lastNotifiedAt: now, updatedAt: now },
    })
    .run();
}

export function isWatching(db: DB, documentId: string, userId: string): boolean {
  const row = db
    .select({ state: watches.state })
    .from(watches)
    .where(and(eq(watches.documentId, documentId), eq(watches.userId, userId)))
    .get();
  return row?.state === 'watching';
}

export interface DigestEmail {
  to: string;
  documentId: string;
  subject: string;
  text: string;
}

export type DigestSender = (email: DigestEmail) => Promise<void>;

/** Whether `item`'s body mentions the recipient — by `@email`. */
function mentionsRecipient(item: Comment, recipientEmail: string): boolean {
  return extractMentionEmails(item.body).includes(recipientEmail.toLowerCase());
}

function digestText(
  baseUrl: string,
  docTitle: string,
  docId: string,
  items: Comment[],
  authorEmails: Map<string, string>,
  recipientEmail: string,
): string {
  const lines: string[] = [`New comments on "${docTitle}":`, ''];
  for (const item of items) {
    const person = authorEmails.get(item.authorId) ?? 'someone';
    const author = item.viaTokenLabel ? `${person} (via ${item.viaTokenLabel})` : person;
    const mentioned = mentionsRecipient(item, recipientEmail);
    if (item.parentId === null) {
      lines.push(`${author} ${mentioned ? 'mentioned you' : 'commented'} on "${item.quotedText}":`);
    } else {
      lines.push(`${author} ${mentioned ? 'mentioned you in a reply' : 'replied'}:`);
    }
    lines.push(item.body, '');
  }
  lines.push(`View and reply: ${baseUrl}/d/${docId}`);
  return lines.join('\n');
}

/**
 * One sweep pass: for every watched document whose newest comment is older
 * than the quiet window, email each watcher everything created since their
 * cursor (minus their own comments) and advance the cursor. Cursors advance
 * to the newest processed comment — never to `now` — so a comment landing
 * mid-sweep is picked up next time. Returns the emails it sent.
 */
export async function runDigestSweep(db: DB, baseUrl: string, send: DigestSender, now: Date = new Date()): Promise<DigestEmail[]> {
  const watchers = db.select().from(watches).where(eq(watches.state, 'watching')).all();
  const sent: DigestEmail[] = [];
  if (watchers.length === 0) return sent;

  const emailCache = new Map<string, string>();
  const emailOf = (userId: string): string | undefined => {
    if (!emailCache.has(userId)) {
      const row = db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get();
      if (row) emailCache.set(userId, row.email);
    }
    return emailCache.get(userId);
  };

  // Group watchers by document so each document's comments load once.
  const byDoc = new Map<string, typeof watchers>();
  for (const w of watchers) {
    const group = byDoc.get(w.documentId) ?? [];
    group.push(w);
    byDoc.set(w.documentId, group);
  }

  for (const [documentId, docWatchers] of byDoc) {
    const oldestCursor = docWatchers.reduce(
      (min, w) => (w.lastNotifiedAt < min ? w.lastNotifiedAt : min),
      docWatchers[0]!.lastNotifiedAt,
    );
    const fresh = db
      .select()
      .from(comments)
      .where(and(eq(comments.documentId, documentId), gt(comments.createdAt, oldestCursor)))
      .orderBy(comments.createdAt)
      .all();
    if (fresh.length === 0) continue;

    // Debounce: wait until the conversation has gone quiet before batching.
    const newest = fresh[fresh.length - 1]!.createdAt;
    if (now.getTime() - newest.getTime() < DIGEST_QUIET_MS) continue;

    const doc = db.select().from(documents).where(eq(documents.id, documentId)).get();
    if (!doc) continue;

    for (const watch of docWatchers) {
      const unseen = fresh.filter((item) => item.createdAt > watch.lastNotifiedAt);
      if (unseen.length === 0) continue;

      const toEmail = unseen.filter((item) => item.authorId !== watch.userId);
      if (toEmail.length > 0) {
        const to = emailOf(watch.userId);
        if (to) {
          const authorEmails = new Map<string, string>();
          for (const item of toEmail) {
            const email = emailOf(item.authorId);
            if (email) authorEmails.set(item.authorId, email);
          }
          const count = toEmail.length;
          const mentioned = toEmail.some((item) => mentionsRecipient(item, to));
          const email: DigestEmail = {
            to,
            documentId,
            subject: `${count} new comment${count === 1 ? '' : 's'} on "${doc.title}"${mentioned ? ' (you were mentioned)' : ''}`,
            text: digestText(baseUrl, doc.title, doc.id, toEmail, authorEmails, to),
          };
          try {
            await send(email);
            sent.push(email);
          } catch (err) {
            // Leave the cursor untouched so the next sweep retries.
            console.error(`Failed to send digest to ${to} for ${documentId}:`, err);
            continue;
          }
        }
      }

      // Advance past everything seen this pass (own comments included), even
      // when nothing was mailed — own-only activity must not retrigger later.
      const newestSeen = unseen[unseen.length - 1]!.createdAt;
      db.update(watches)
        .set({ lastNotifiedAt: newestSeen, updatedAt: now })
        .where(and(eq(watches.documentId, documentId), eq(watches.userId, watch.userId)))
        .run();
    }
  }

  return sent;
}
