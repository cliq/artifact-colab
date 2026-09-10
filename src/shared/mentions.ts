/**
 * User mentions in comment bodies. A mention is the author's email address
 * written with a leading `@` — `@bob@example.com` — which is what the picker
 * inserts and what an agent can type by hand. Mentions live in the body text
 * itself: the server resolves them against the document's team when the
 * comment is created (to subscribe the people named) and when it is read (so
 * the sidebar can paint them as chips), so nothing extra is stored.
 */

/**
 * `@` followed by an email, not glued to a preceding word character (so
 * `a@b@c.com` isn't two mentions). The domain match is greedy but must end in
 * a dotted TLD, so trailing punctuation (`@bob@example.com.`) is left out.
 */
const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

/** Lowercased, deduplicated emails mentioned in `body`, in order of first appearance. */
export function extractMentionEmails(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) {
    seen.add(match[2]!.toLowerCase());
  }
  return [...seen];
}

export type MentionSegment = { type: 'text'; text: string } | { type: 'mention'; email: string };

/**
 * Split `body` into text runs and mentions, keeping only mentions whose
 * (lowercased) email is in `known` — an `@` in front of a stranger's email
 * stays plain text. Every character of `body` lands in exactly one segment.
 */
export function splitMentions(body: string, known: ReadonlySet<string>): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(MENTION_RE)) {
    const email = match[2]!;
    if (!known.has(email.toLowerCase())) continue;
    // The match includes the one-character lead-in (or nothing at line start).
    const start = match.index! + match[1]!.length;
    if (start > cursor) segments.push({ type: 'text', text: body.slice(cursor, start) });
    segments.push({ type: 'mention', email });
    cursor = start + 1 + email.length;
  }
  if (cursor < body.length) segments.push({ type: 'text', text: body.slice(cursor) });
  return segments;
}
