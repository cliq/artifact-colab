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
