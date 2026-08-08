/**
 * Pure-text anchoring: describe a range of a normalized document text as a
 * quote-with-context anchor, and re-locate that anchor in a (possibly edited)
 * normalized text. No DOM, no globals — the DOM adapter lives in index.ts.
 */

export interface TextAnchor {
  /** Algorithm version. */
  v: 1;
  /** The normalized quoted text. */
  exact: string;
  /** Normalized context before the quote (may be shorter near doc start). */
  prefix: string;
  /** Normalized context after the quote (may be shorter near doc end). */
  suffix: string;
  /** Index of `exact` in the normalized document text at creation time. */
  start: number;
  /** Length of the normalized document text at creation time. */
  docLength: number;
}

export interface LocatedAnchor {
  start: number;
  end: number;
  /** 1 for exact/unique matches; the winning context score otherwise. */
  score: number;
  /**
   * True when the quote matched in several places and context + position
   * couldn't clearly separate the winner. Still anchored, but flagged.
   */
  ambiguous: boolean;
}

/** Reserved extension point — deliberately not implemented in MVP. */
export type FuzzyMatcher = (text: string, anchor: TextAnchor) => LocatedAnchor | null;

export interface LocateOptions {
  fuzzy?: FuzzyMatcher;
}

const MIN_CONTEXT = 32;
const MAX_CONTEXT = 128;

/** Winner must beat the runner-up by at least this much to be unambiguous. */
const AMBIGUOUS_MARGIN = 0.05;
/** Below this score a multi-match winner is flagged ambiguous regardless. */
const AMBIGUOUS_SCORE = 0.5;

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    count++;
    if (count > 1) return count; // only uniqueness matters to callers
    i = text.indexOf(needle, i + 1);
  }
  return count;
}

/**
 * Build an anchor for text[start, end). Context starts at MIN_CONTEXT chars a
 * side and grows (doubling) until prefix+exact+suffix is unique in the
 * document or both sides hit MAX_CONTEXT.
 */
export function describeTextAnchor(text: string, start: number, end: number): TextAnchor {
  if (start < 0 || end > text.length || start >= end) {
    throw new RangeError(`invalid anchor range [${start}, ${end}) in text of length ${text.length}`);
  }
  const exact = text.slice(start, end);
  let size = MIN_CONTEXT;
  let prefix = text.slice(Math.max(0, start - size), start);
  let suffix = text.slice(end, end + size);
  while (size < MAX_CONTEXT && countOccurrences(text, prefix + exact + suffix) > 1) {
    size = Math.min(size * 2, MAX_CONTEXT);
    prefix = text.slice(Math.max(0, start - size), start);
    suffix = text.slice(end, end + size);
  }
  return { v: 1, exact, prefix, suffix, start, docLength: text.length };
}

/** Length of the common suffix of `a` and `b` (compared backwards). */
function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the common prefix of `a` and `b`. */
function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Re-locate an anchor in a normalized text. Returns null when the quote does
 * not occur at all (orphaned). Relocation is stateless per version: a quote
 * restored in a later version un-orphans without any special handling.
 */
export function locateTextAnchor(
  text: string,
  anchor: TextAnchor,
  _opts?: LocateOptions,
): LocatedAnchor | null {
  const { exact } = anchor;
  if (exact.length === 0) return null;

  // Fast path: the document (or at least the region) didn't change.
  if (
    anchor.start >= 0 &&
    anchor.start + exact.length <= text.length &&
    text.startsWith(exact, anchor.start)
  ) {
    return { start: anchor.start, end: anchor.start + exact.length, score: 1, ambiguous: false };
  }

  const candidates: number[] = [];
  for (let i = text.indexOf(exact); i !== -1; i = text.indexOf(exact, i + 1)) {
    candidates.push(i);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const start = candidates[0]!;
    return { start, end: start + exact.length, score: 1, ambiguous: false };
  }

  // Multiple occurrences: score by context agreement and position hint.
  const expectedStart = anchor.docLength > 0 ? (anchor.start * text.length) / anchor.docLength : 0;
  const tolerance = Math.max(500, 0.1 * text.length);
  const scored = candidates.map((cand) => {
    const before = text.slice(Math.max(0, cand - anchor.prefix.length), cand);
    const after = text.slice(cand + exact.length, cand + exact.length + anchor.suffix.length);
    const prefixScore =
      anchor.prefix.length === 0 ? 1 : commonSuffixLength(anchor.prefix, before) / anchor.prefix.length;
    const suffixScore =
      anchor.suffix.length === 0 ? 1 : commonPrefixLength(anchor.suffix, after) / anchor.suffix.length;
    const positionScore = 1 - Math.min(1, Math.abs(cand - expectedStart) / tolerance);
    return { cand, score: 0.4 * prefixScore + 0.4 * suffixScore + 0.2 * positionScore };
  });

  // Max score wins; ties go to the lowest index (scored is in index order).
  let winner = scored[0]!;
  for (const s of scored) {
    if (s.score > winner.score) winner = s;
  }
  let runnerUp = -Infinity;
  for (const s of scored) {
    if (s !== winner && s.score > runnerUp) runnerUp = s.score;
  }
  const ambiguous = winner.score - runnerUp < AMBIGUOUS_MARGIN || winner.score < AMBIGUOUS_SCORE;
  return { start: winner.cand, end: winner.cand + exact.length, score: winner.score, ambiguous };
}
