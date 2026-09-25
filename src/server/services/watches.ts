/**
 * Watching and comment digests. Users auto-watch documents they publish or
 * comment on (unless they explicitly unwatched — that choice is sticky), and
 * can toggle watching on any document. A periodic sweep emails each watcher
 * the comments they haven't seen, but only once a document has been quiet for
 * `DIGEST_QUIET_MS` — so a burst of comments lands as one email, not many.
 */

import { and, eq, gt } from 'drizzle-orm';

import { mentionableUsers, resolveDocumentAccess } from './access.js';
import { escapeHtml, renderCommentEmailHtml } from './markdown.js';
import { extractMentionEmails } from '../../shared/mentions.js';
import type { DBOrTx } from '../db/index.js';
import { comments, documents, users, watches, type Comment, type Document, type User } from '../db/schema.js';

export const DIGEST_QUIET_MS = 5 * 60 * 1000;

/**
 * Subscribe as a side effect of creating or commenting. Never overwrites an
 * existing row: a sticky 'unwatched' must survive later comments.
 */
export function autoWatch(db: DBOrTx, documentId: string, userId: string, now: Date): void {
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
export function watchForMention(db: DBOrTx, documentId: string, userId: string, commentCreatedAt: Date): void {
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

/** Mentions resolve only within the actor's authorized local collaborator directory. */
export function resolveMentions(
  db: DBOrTx,
  document: Pick<Document, 'id' | 'teamId' | 'visibility' | 'createdBy'>,
  actorId: string,
  body: string,
): User[] {
  const emails = extractMentionEmails(body);
  if (emails.length === 0) return [];
  return mentionableUsers(db, document.id, actorId).filter((user) => emails.includes(user.email));
}

/**
 * Explicit toggle from the Watch button — the only path that clears
 * 'unwatched'. Resets the digest cursor: watching starts from now, never
 * from a backlog accumulated while unwatched.
 */
export function setWatching(db: DBOrTx, documentId: string, userId: string, watching: boolean, now: Date): void {
  const state = watching ? 'watching' : 'unwatched';
  db.insert(watches)
    .values({ documentId, userId, state, lastNotifiedAt: now, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [watches.documentId, watches.userId],
      set: { state, lastNotifiedAt: now, updatedAt: now },
    })
    .run();
}

export function isWatching(db: DBOrTx, documentId: string, userId: string): boolean {
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
  html: string;
}

export type DigestSender = (email: DigestEmail) => Promise<void>;

interface DigestItem {
  comment: Comment;
  authorEmail: string;
  mentioned: boolean;
  /** Resolved mentions in the body: lowercased email → display name. */
  mentions: Map<string, string>;
}

const WATCH_FOOTER = 'You get these emails because you watch this artifact; use its Watch button to stop.';

function digestText(baseUrl: string, docTitle: string, docId: string, items: DigestItem[]): string {
  const lines: string[] = [`New comments on "${docTitle}":`, ''];
  for (const { comment: item, authorEmail, mentioned } of items) {
    const author = item.viaTokenLabel ? `${authorEmail} (via ${item.viaTokenLabel})` : authorEmail;
    if (item.parentId === null) {
      lines.push(`${author} ${mentioned ? 'mentioned you' : 'commented'} on "${item.quotedText}":`);
    } else {
      lines.push(`${author} ${mentioned ? 'mentioned you in a reply' : 'replied'}:`);
    }
    lines.push(item.body, '');
  }
  lines.push(`View and reply: ${baseUrl}/d/${docId}`, '', WATCH_FOOTER);
  return lines.join('\n');
}

/**
 * The same digest as HTML, so comment bodies show their Markdown formatting.
 * Styles are inline and the layout is a single centered column, the one
 * shape email clients agree on.
 */
function digestHtml(baseUrl: string, docTitle: string, docId: string, items: DigestItem[]): string {
  const url = escapeHtml(`${baseUrl}/d/${docId}`);
  const entries = items.map(({ comment: item, authorEmail, mentioned, mentions }) => {
    const agent = item.viaTokenLabel
      ? ` <span style="display:inline-block;padding:0 5px;border:1px solid #f0c7ae;border-radius:4px;background:#fdf1ea;color:#c2410c;font-size:11px;">` +
        `<span style="text-transform:uppercase;letter-spacing:0.02em;opacity:0.75;">Agent</span> ${escapeHtml(item.viaTokenLabel)}</span>`
      : '';
    const action =
      item.parentId === null ? (mentioned ? 'mentioned you on' : 'commented on') : mentioned ? 'mentioned you in a reply' : 'replied';
    const quote =
      item.parentId === null
        ? `<div style="margin:6px 0 8px;padding:0 0 0 10px;border-left:3px solid #c2410c;color:#6f665f;font-style:italic;">${escapeHtml(item.quotedText ?? '')}</div>`
        : '';
    return (
      `<div style="padding:14px 0;border-top:1px solid #ece6dd;">` +
      `<div style="font-size:13px;color:#6f665f;margin-bottom:6px;"><strong style="color:#2a2522;">${escapeHtml(authorEmail)}</strong>${agent} ${action}</div>` +
      quote +
      `<div style="font-size:14px;line-height:1.5;color:#2a2522;">${renderCommentEmailHtml(item.body, mentions)}</div>` +
      `</div>`
    );
  });
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(docTitle)}</title></head>
<body style="margin:0;padding:0;background:#faf8f5;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2a2522;">
<div style="font-size:13px;color:#6f665f;margin-bottom:4px;">New comments on</div>
<div style="font-size:18px;font-weight:600;margin-bottom:12px;"><a href="${url}" style="color:#2a2522;text-decoration:none;">${escapeHtml(docTitle)}</a></div>
${entries.join('\n')}
<div style="padding:16px 0;border-top:1px solid #ece6dd;"><a href="${url}" style="display:inline-block;padding:8px 14px;border-radius:6px;background:#c2410c;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;">View and reply</a></div>
<div style="font-size:12px;color:#9a918a;">${escapeHtml(WATCH_FOOTER)}</div>
</div>
</body>
</html>
`;
}

/**
 * One sweep pass: for every watched document whose newest comment is older
 * than the quiet window, email each watcher everything created since their
 * cursor (minus their own comments) and advance the cursor. Cursors advance
 * to the newest processed comment — never to `now` — so a comment landing
 * mid-sweep is picked up next time. Returns the emails it sent.
 */
export async function runDigestSweep(db: DBOrTx, baseUrl: string, send: DigestSender, now: Date = new Date()): Promise<DigestEmail[]> {
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
      // A previous send awaits network I/O: both access and preference may have changed.
      if (!resolveDocumentAccess(db, documentId, watch.userId) || !isWatching(db, documentId, watch.userId)) continue;
      const unseen = fresh.filter((item) => item.createdAt > watch.lastNotifiedAt);
      if (unseen.length === 0) continue;

      const toEmail = unseen.filter((item) => item.authorId !== watch.userId);
      if (toEmail.length > 0) {
        const to = emailOf(watch.userId);
        if (to) {
          const items: DigestItem[] = toEmail.map((comment) => {
            const resolved = resolveMentions(db, doc, comment.authorId, comment.body);
            return {
              comment,
              authorEmail: emailOf(comment.authorId) ?? 'someone',
              mentioned: resolved.some((user) => user.id === watch.userId),
              mentions: new Map(resolved.map((user) => [user.email.toLowerCase(), user.name ?? user.email])),
            };
          });
          const count = items.length;
          const mentioned = items.some((item) => item.mentioned);
          const email: DigestEmail = {
            to,
            documentId,
            subject: `${count} new comment${count === 1 ? '' : 's'} on "${doc.title}"${mentioned ? ' (you were mentioned)' : ''}`,
            text: digestText(baseUrl, doc.title, doc.id, items),
            html: digestHtml(baseUrl, doc.title, doc.id, items),
          };
          try {
            if (!resolveDocumentAccess(db, documentId, watch.userId) || !isWatching(db, documentId, watch.userId)) continue;
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
