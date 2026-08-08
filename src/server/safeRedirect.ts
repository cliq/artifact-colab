/**
 * Validates a caller-supplied `next` redirect target, returning it only when
 * it points somewhere within this app — otherwise undefined, so the caller
 * falls back to a safe default.
 *
 * A naive `startsWith('/') && !startsWith('//')` check is not enough: browsers
 * (and the WHATWG URL parser) normalize a backslash to a forward slash and
 * strip embedded tab/newline characters before resolving, so `/\evil.com` or
 * `/\t/evil.com` sail past the string check yet resolve to an external origin
 * — an open redirect. Resolving against a sentinel base and confirming the
 * origin is unchanged closes every such variant in one place.
 */
const SENTINEL_BASE = 'http://local.invalid';

export function safeLocalPath(next: string | undefined): string | undefined {
  if (!next || next[0] !== '/') return undefined;
  try {
    const url = new URL(next, SENTINEL_BASE);
    if (url.origin !== SENTINEL_BASE) return undefined;
    return url.pathname + url.search + url.hash;
  } catch {
    return undefined;
  }
}
