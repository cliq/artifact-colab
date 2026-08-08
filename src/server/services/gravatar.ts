/**
 * Gravatar avatar URLs (https://docs.gravatar.com/api/avatars/). The hash is
 * computed server-side so the client never needs the author's raw email
 * beyond what it already displays, and the scheme lives in exactly one place.
 */

import { createHash } from 'node:crypto';

/**
 * `d=mp` falls back to the neutral "mystery person" silhouette for emails
 * without a Gravatar; `s=80` covers 2x displays of the 16–40px avatars we
 * render.
 */
export function gravatarUrl(email: string): string {
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `https://gravatar.com/avatar/${hash}?d=mp&s=80`;
}
