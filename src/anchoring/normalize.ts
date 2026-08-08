/**
 * Text normalization shared by anchor creation and relocation, in the browser
 * and on the server. The whole engine depends on one invariant: every source
 * character maps to exactly one or zero output characters (1:1 or 1:0).
 * Separator/collapsed spaces are emitted as *gap* characters that belong to no
 * source character, which keeps per-character offset mapping exact.
 */

/** Tags whose entire subtree is excluded from the text index. */
export const SKIP_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'head',
  'title',
  'meta',
  'link',
  'svg',
  'canvas',
  'iframe',
  'object',
  'select',
  'textarea',
]);

/**
 * Tags that produce a synthetic separator space when entered or left, so text
 * in adjacent blocks doesn't fuse into one word. Static set — no
 * getComputedStyle anywhere.
 */
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'caption',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'legend',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** Zero-width space, zero-width no-break space (BOM), soft hyphen. */
const DROPPED = new Set(['\u200B', '\uFEFF', '\u00AD']);

/** ASCII whitespace plus NBSP, narrow NBSP, and the Unicode space block. */
const WHITESPACE_RE = /[ \t\n\r\f\v\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

const FOLDED: Record<string, string> = {
  '‘': "'", // left single curly quote
  '’': "'", // right single curly quote / apostrophe
  '“': '"', // left double curly quote
  '”': '"', // right double curly quote
};

/**
 * Fold a single character. Returns null for dropped characters, ' ' for any
 * whitespace, or the (possibly folded) character. Never returns more than one
 * character — the 1:1/1:0 invariant.
 */
export function foldChar(c: string): string | null {
  if (DROPPED.has(c)) return null;
  if (WHITESPACE_RE.test(c)) return ' ';
  return FOLDED[c] ?? c;
}

/**
 * A contiguous run of output characters that map 1:1 onto source characters.
 * Runs break wherever a character was dropped or a gap space was emitted.
 */
export interface MappedRun {
  srcStart: number;
  outStart: number;
  len: number;
}

/**
 * Streaming whitespace collapser. Feed it text (and block-boundary separators)
 * in document order; it maintains collapse state across text nodes.
 * All spaces in the output are gap characters owned by no source character;
 * output never starts or ends with a space.
 */
export class TextCollapser {
  private out = '';
  private pendingGap = false;
  private started = false;

  /** Note a block-element boundary. Coalesces with adjacent whitespace. */
  pushSeparator(): void {
    if (this.started) this.pendingGap = true;
  }

  /**
   * Feed one text node's data. Returns the mapped runs relating output
   * offsets back to source offsets within `data`.
   */
  pushText(data: string): MappedRun[] {
    const runs: MappedRun[] = [];
    let run: MappedRun | null = null;
    for (let i = 0; i < data.length; i++) {
      const f = foldChar(data[i]!);
      if (f === null) {
        run = null; // dropped char breaks source contiguity
        continue;
      }
      if (f === ' ') {
        if (this.started) this.pendingGap = true;
        run = null;
        continue;
      }
      if (this.pendingGap) {
        this.out += ' ';
        this.pendingGap = false;
        run = null; // gap breaks output contiguity
      }
      if (run === null) {
        run = { srcStart: i, outStart: this.out.length, len: 0 };
        runs.push(run);
      }
      this.out += f;
      run.len++;
      this.started = true;
    }
    return runs;
  }

  /** Normalized text so far. Pending gaps are never materialized at the end. */
  get text(): string {
    return this.out;
  }
}

/** Normalize a plain string with the exact policy used for documents. */
export function normalizeString(s: string): string {
  const c = new TextCollapser();
  c.pushText(s);
  return c.text;
}
