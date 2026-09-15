/**
 * Word-level diff of two normalized document texts (the output of the
 * anchoring engine's text index, where words are separated by single spaces).
 * Shared by the viewer's compare mode (browser) and unit tests (node); no DOM.
 *
 * Tokens are whitespace-separated words. Myers' O(ND) algorithm with the
 * linear-space "bisect" refinement (as in diff-match-patch) finds a minimal
 * edit script over the tokens; consecutive edits are coalesced into hunks
 * expressed as character ranges in each text, ready to be mapped onto DOM
 * ranges by the annotator.
 */

export interface DiffHunk {
  /** Stable id (position in the hunk list). */
  id: string;
  /** Character range in the old text that was removed; empty (start === end) for a pure insertion. */
  oldStart: number;
  oldEnd: number;
  /** Character range in the new text that was added; empty for a pure deletion. */
  newStart: number;
  newEnd: number;
}

// Bound preprocessing, the Myers search and the number of sidebar/highlight
// elements independently. Source file size is insufficient: scripts can render
// much more text, and a short rewrite can still require quadratic diff work.
export const MAX_DIFF_TEXT_LENGTH = 100_000;
export const MAX_DIFF_TOKENS = 10_000;
export const MAX_DIFF_WORK = 1_000_000;
export const MAX_DIFF_HUNKS = 200;

export class DiffLimitError extends Error {
  constructor(readonly reason: 'text' | 'tokens' | 'work' | 'hunks') {
    super(`Comparison exceeds the ${reason} limit`);
    this.name = 'DiffLimitError';
  }
}

class WorkBudget {
  private remaining = MAX_DIFF_WORK;

  spend(): void {
    if (--this.remaining < 0) throw new DiffLimitError('work');
  }
}

interface Token {
  text: string;
  start: number;
  end: number;
}

/** Split into words at spaces, remembering where each word sits in the text. */
export function tokenize(text: string, maxTokens = Infinity): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (tokens.length === maxTokens) throw new DiffLimitError('tokens');
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/** A change block over token indices: a[aStart, aEnd) was replaced by b[bStart, bEnd). */
interface TokenChange {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/**
 * Minimal edit script between a[aLo, aHi) and b[bLo, bHi), appended to `out`
 * as change blocks in order. Common prefix/suffix are peeled off first, then
 * the problem is split at a middle snake and both halves recurse.
 */
function diffRange(a: string[], aLo: number, aHi: number, b: string[], bLo: number, bHi: number, out: TokenChange[], budget: WorkBudget): void {
  budget.spend();
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    budget.spend();
    aLo++;
    bLo++;
  }
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
    budget.spend();
    aHi--;
    bHi--;
  }
  if (aLo >= aHi && bLo >= bHi) return;
  if (aLo >= aHi || bLo >= bHi) {
    out.push({ aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bHi });
    return;
  }
  const split = bisect(a, aLo, aHi, b, bLo, bHi, budget);
  if (!split) {
    // No token in common: one replacement block.
    out.push({ aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bHi });
    return;
  }
  diffRange(a, aLo, split.x, b, bLo, split.y, out, budget);
  diffRange(a, split.x, aHi, b, split.y, bHi, out, budget);
}

/**
 * Find the middle snake of the shortest edit script for a[aLo, aHi) vs
 * b[bLo, bHi) by running the forward and reverse Myers searches until they
 * overlap. Returns the absolute split point, or null when the two ranges
 * share nothing (so the shortest script is delete-all + insert-all).
 */
function bisect(
  a: string[],
  aLo: number,
  aHi: number,
  b: string[],
  bLo: number,
  bHi: number,
  budget: WorkBudget,
): { x: number; y: number } | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const vOffset = maxD;
  const vLength = 2 * maxD + 2;
  const v1 = new Int32Array(vLength).fill(-1);
  const v2 = new Int32Array(vLength).fill(-1);
  v1[vOffset + 1] = 0;
  v2[vOffset + 1] = 0;
  const delta = n - m;
  // With an odd delta the overlap is detected in the forward pass, otherwise in the reverse pass.
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      budget.spend();
      const k1Offset = vOffset + k1;
      let x1 = k1 === -d || (k1 !== d && v1[k1Offset - 1]! < v1[k1Offset + 1]!) ? v1[k1Offset + 1]! : v1[k1Offset - 1]! + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
        budget.spend();
        x1++;
        y1++;
      }
      v1[k1Offset] = x1;
      if (x1 > n) {
        k1end += 2;
      } else if (y1 > m) {
        k1start += 2;
      } else if (front) {
        const k2Offset = vOffset + delta - k1;
        if (k2Offset >= 0 && k2Offset < vLength && v2[k2Offset] !== -1) {
          const x2 = n - v2[k2Offset]!;
          if (x1 >= x2) return { x: aLo + x1, y: bLo + y1 };
        }
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      budget.spend();
      const k2Offset = vOffset + k2;
      let x2 = k2 === -d || (k2 !== d && v2[k2Offset - 1]! < v2[k2Offset + 1]!) ? v2[k2Offset + 1]! : v2[k2Offset - 1]! + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - x2 - 1] === b[bHi - y2 - 1]) {
        budget.spend();
        x2++;
        y2++;
      }
      v2[k2Offset] = x2;
      if (x2 > n) {
        k2end += 2;
      } else if (y2 > m) {
        k2start += 2;
      } else if (!front) {
        const k1Offset = vOffset + delta - k2;
        if (k1Offset >= 0 && k1Offset < vLength && v1[k1Offset] !== -1) {
          const x1 = v1[k1Offset]!;
          const y1 = vOffset + x1 - k1Offset;
          if (x1 >= n - x2) return { x: aLo + x1, y: bLo + y1 };
        }
      }
    }
  }
  return null;
}

/**
 * Tidy the raw edit script for reading: adjacent delete/insert blocks become
 * one replacement, and a single unchanged word wedged between two larger
 * changes is absorbed (a rewritten paragraph that happens to keep "the" reads
 * as one change, not two).
 */
function coalesce(changes: TokenChange[]): TokenChange[] {
  const out: TokenChange[] = [];
  for (const next of changes) {
    const prev = out[out.length - 1];
    if (prev) {
      const gapA = next.aStart - prev.aEnd;
      const gapB = next.bStart - prev.bEnd;
      const adjacent = gapA === 0 && gapB === 0;
      const changed = prev.aEnd - prev.aStart + (prev.bEnd - prev.bStart) + (next.aEnd - next.aStart) + (next.bEnd - next.bStart);
      const bridged = gapA === 1 && gapB === 1 && changed >= 8;
      if (adjacent || bridged) {
        prev.aEnd = next.aEnd;
        prev.bEnd = next.bEnd;
        continue;
      }
    }
    out.push({ ...next });
  }
  return out;
}

/** Character offset where token `i` of `tokens` starts (text end past the last token). */
function tokenStart(tokens: Token[], i: number, textLength: number): number {
  return i < tokens.length ? tokens[i]!.start : textLength;
}

/**
 * Diff two texts word by word. Hunks come back in document order (both the
 * old and new ranges are non-decreasing) and never overlap. Throws
 * DiffLimitError when comparison is too large; never returns a partial diff.
 */
export function diffText(oldText: string, newText: string): DiffHunk[] {
  if (oldText.length > MAX_DIFF_TEXT_LENGTH || newText.length > MAX_DIFF_TEXT_LENGTH) throw new DiffLimitError('text');
  const oldTokens = tokenize(oldText, MAX_DIFF_TOKENS);
  const newTokens = tokenize(newText, MAX_DIFF_TOKENS);
  if (oldText === newText) return [];
  const changes: TokenChange[] = [];
  diffRange(
    oldTokens.map((t) => t.text),
    0,
    oldTokens.length,
    newTokens.map((t) => t.text),
    0,
    newTokens.length,
    changes,
    new WorkBudget(),
  );
  const coalesced = coalesce(changes);
  if (coalesced.length > MAX_DIFF_HUNKS) throw new DiffLimitError('hunks');
  return coalesced.map((c, i) => ({
    id: `h${i}`,
    oldStart: c.aStart < c.aEnd ? oldTokens[c.aStart]!.start : tokenStart(oldTokens, c.aStart, oldText.length),
    oldEnd: c.aStart < c.aEnd ? oldTokens[c.aEnd - 1]!.end : tokenStart(oldTokens, c.aStart, oldText.length),
    newStart: c.bStart < c.bEnd ? newTokens[c.bStart]!.start : tokenStart(newTokens, c.bStart, newText.length),
    newEnd: c.bStart < c.bEnd ? newTokens[c.bEnd - 1]!.end : tokenStart(newTokens, c.bStart, newText.length),
  }));
}

/** Up to `words` words of `text` ending at `offset`, for showing a hunk in context. */
export function wordsBefore(text: string, offset: number, words: number): string {
  if (words <= 0) return '';
  const before = text.slice(0, offset).trimEnd();
  // Scan only the requested context. Splitting the full document for every
  // sidebar card would make rendering expensive even after a bounded diff.
  let start = before.length;
  for (let i = 0; i < words; i++) {
    start = before.lastIndexOf(' ', start - 1);
    if (start === -1) return before;
  }
  return before.slice(start + 1);
}

/** Up to `words` words of `text` starting at `offset`. */
export function wordsAfter(text: string, offset: number, words: number): string {
  if (words <= 0) return '';
  const after = text.slice(offset).trimStart();
  let end = -1;
  for (let i = 0; i < words; i++) {
    end = after.indexOf(' ', end + 1);
    if (end === -1) return after;
  }
  return after.slice(0, end);
}
