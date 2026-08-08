/**
 * Timestamp that renders in the visitor's timezone. The server emits a <time>
 * element carrying the UTC instant; a script in the Layout rewrites its text
 * with the browser's locale and timezone. The UTC text is the no-JS fallback.
 */

import type { FC } from 'hono/jsx';

export const LocalTime: FC<{ date: Date }> = ({ date }) => (
  <time datetime={date.toISOString()}>{formatUtc(date)}</time>
);

/** e.g. "2026-08-08 14:32 UTC" — only shown when JS is unavailable. */
function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
