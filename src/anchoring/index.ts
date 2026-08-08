/**
 * DOM adapter for the anchoring engine: builds a normalized text index over a
 * DOM tree and maps offsets between the normalized text and DOM positions.
 *
 * Every function takes its root/index as an argument — no DOM globals — so the
 * same code runs in the browser (annotator) and on the server (linkedom).
 * Node kinds are detected via nodeType numbers, never instanceof, because
 * linkedom/happy-dom/browser classes live in different realms.
 */

import { BLOCK_TAGS, SKIP_TAGS, TextCollapser } from './normalize.js';

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

/**
 * Document-order helpers. Hand-rolled rather than compareDocumentPosition:
 * linkedom returns inverted FOLLOWING/PRECEDING bits for disjoint nodes.
 */
function pathFromRoot(node: Node): Node[] {
  const path: Node[] = [];
  for (let n: Node | null = node; n; n = n.parentNode) path.push(n);
  return path.reverse();
}

/** True if `a` contains `b` (strictly). */
function containsNode(a: Node, b: Node): boolean {
  for (let n = b.parentNode; n; n = n.parentNode) if (n === a) return true;
  return false;
}

/** True if `a` starts before `b` in pre-order. An ancestor starts first. */
function startsBefore(a: Node, b: Node): boolean {
  if (a === b) return false;
  const pa = pathFromRoot(a);
  const pb = pathFromRoot(b);
  const n = Math.min(pa.length, pb.length);
  let i = 0;
  while (i < n && pa[i] === pb[i]) i++;
  if (i === n) return pa.length < pb.length; // one contains the other
  if (i === 0) return false; // disconnected trees: no defined order
  for (let s = pa[i]!.nextSibling; s; s = s.nextSibling) {
    if (s === pb[i]) return true;
  }
  return false;
}

/**
 * A contiguous run of normalized-text characters mapping 1:1 onto characters
 * of one Text node. Gap spaces between chunks belong to no node.
 */
export interface TextChunk {
  textStart: number;
  node: Text;
  nodeStart: number;
  len: number;
}

export interface TextIndex {
  /** The normalized document text. */
  text: string;
  /** All chunks, sorted by textStart (= document order). */
  chunks: TextChunk[];
  /** Text node → indices into `chunks`, sorted by nodeStart. */
  byNode: Map<Text, number[]>;
  /** The root the index was built from. */
  root: Node;
}

export interface NormalizeOptions {
  /** Lowercase tag names to skip in addition to the built-in set. */
  extraSkipTags?: string[];
}

function isSkippedElement(el: Element, skipTags: ReadonlySet<string>): boolean {
  const tag = el.localName.toLowerCase();
  if (skipTags.has(tag)) return true;
  if (el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  return false;
}

/** Build the normalized text index for a DOM subtree. */
export function buildTextIndex(root: Node, opts?: NormalizeOptions): TextIndex {
  const skipTags = opts?.extraSkipTags
    ? new Set([...SKIP_TAGS, ...opts.extraSkipTags.map((t) => t.toLowerCase())])
    : SKIP_TAGS;
  const collapser = new TextCollapser();
  const chunks: TextChunk[] = [];
  const byNode = new Map<Text, number[]>();

  const visit = (node: Node): void => {
    const type = node.nodeType;
    if (type === TEXT_NODE) {
      const textNode = node as Text;
      const runs = collapser.pushText(textNode.data);
      if (runs.length > 0) {
        const indices = byNode.get(textNode) ?? [];
        for (const run of runs) {
          indices.push(chunks.length);
          chunks.push({ textStart: run.outStart, node: textNode, nodeStart: run.srcStart, len: run.len });
        }
        byNode.set(textNode, indices);
      }
      return;
    }
    if (type === ELEMENT_NODE) {
      const el = node as Element;
      if (isSkippedElement(el, skipTags)) return;
      const isBlock = BLOCK_TAGS.has(el.localName.toLowerCase());
      if (isBlock) collapser.pushSeparator();
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
      if (isBlock) collapser.pushSeparator();
      return;
    }
    if (type === DOCUMENT_NODE || type === DOCUMENT_FRAGMENT_NODE) {
      // Two linkedom quirks force childNodes iteration here instead of a
      // firstChild/nextSibling chain: the doctype's nextSibling doesn't link
      // to <html> (the chain stops early), and for fragment-style HTML with
      // multiple top-level elements, documentElement is just the FIRST
      // element — walking only it would miss the rest of the page.
      const children = node.childNodes;
      for (let i = 0; i < children.length; i++) visit(children[i]!);
      return;
    }
    // comments, processing instructions, doctypes: no text contribution
  };
  visit(root);

  return { text: collapser.text, chunks, byNode, root };
}

/** Binary search: first index in [0, n) where pred is true (pred monotonic). */
function lowerBound(n: number, pred: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Text offset of the first indexed content at or after the DOM boundary point
 * (container, offset). Returns ix.text.length when nothing follows.
 */
function firstTextPositionAtOrAfter(ix: TextIndex, container: Node, offset: number): number {
  const children = container.childNodes;
  let isAtOrAfter: (chunkNode: Node) => boolean;
  if (offset < children.length) {
    const boundary = children[offset]!;
    isAtOrAfter = (chunkNode) =>
      chunkNode === boundary || containsNode(boundary, chunkNode) || startsBefore(boundary, chunkNode);
  } else {
    // Boundary sits at the end of `container`: everything inside is before it.
    isAtOrAfter = (chunkNode) =>
      chunkNode !== container && !containsNode(container, chunkNode) && startsBefore(container, chunkNode);
  }
  const i = lowerBound(ix.chunks.length, (k) => isAtOrAfter(ix.chunks[k]!.node));
  return i < ix.chunks.length ? ix.chunks[i]!.textStart : ix.text.length;
}

/**
 * Map a DOM position to a normalized text offset. Element containers with
 * child-index offsets resolve to the first text position at/after that point.
 * Positions inside dropped/collapsed regions snap forward to the next content;
 * a position exactly at the end of a chunk maps to the offset just after its
 * last character (which is the gap offset between words).
 */
export function domToTextOffset(ix: TextIndex, node: Node, offset: number): number {
  if (node.nodeType !== TEXT_NODE) {
    return firstTextPositionAtOrAfter(ix, node, offset);
  }
  const indices = ix.byNode.get(node as Text);
  if (!indices || indices.length === 0) {
    // Whitespace-only or unindexed text node: resolve like an element boundary.
    const parent = node.parentNode;
    if (!parent) return ix.text.length;
    let childIndex = 0;
    for (let c = parent.firstChild; c && c !== node; c = c.nextSibling) childIndex++;
    return firstTextPositionAtOrAfter(ix, parent, childIndex);
  }
  // Last chunk of this node whose nodeStart <= offset.
  const k = lowerBound(indices.length, (i) => ix.chunks[indices[i]!]!.nodeStart > offset);
  if (k === 0) return ix.chunks[indices[0]!]!.textStart;
  const chunk = ix.chunks[indices[k - 1]!]!;
  if (offset <= chunk.nodeStart + chunk.len) {
    return chunk.textStart + (offset - chunk.nodeStart);
  }
  // Offset in a dropped/collapsed tail: snap to the next chunk, or chunk end.
  if (k < indices.length) return ix.chunks[indices[k]!]!.textStart;
  return chunk.textStart + chunk.len;
}

/** DOM position of the character at text offset i (must lie inside a chunk). */
function positionOfChar(ix: TextIndex, i: number): { node: Text; offset: number } | null {
  const k = lowerBound(ix.chunks.length, (c) => ix.chunks[c]!.textStart + ix.chunks[c]!.len > i);
  if (k >= ix.chunks.length) return null;
  const chunk = ix.chunks[k]!;
  if (i < chunk.textStart) return null; // gap character
  return { node: chunk.node, offset: chunk.nodeStart + (i - chunk.textStart) };
}

/**
 * Map a normalized text offset to a DOM position. Offsets that fall on a gap
 * space map to the end of the preceding chunk, so
 * domToTextOffset(...textOffsetToDom(ix, i)) === i for every i in
 * [0, text.length].
 */
export function textOffsetToDom(ix: TextIndex, offset: number): { node: Text; offset: number } {
  if (ix.chunks.length === 0) throw new RangeError('text index is empty');
  const i = Math.max(0, Math.min(offset, ix.text.length));
  const at = positionOfChar(ix, i);
  if (at) return at;
  // Gap or end-of-text: end of the last chunk starting at or before i.
  const k = lowerBound(ix.chunks.length, (c) => ix.chunks[c]!.textStart > i);
  const chunk = ix.chunks[Math.max(0, k - 1)]!;
  const delta = Math.min(i - chunk.textStart, chunk.len);
  return { node: chunk.node, offset: chunk.nodeStart + delta };
}

/** Minimal structural Range type (works with linkedom, which lacks full Range). */
export interface AbstractRange {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
}

/** Map a DOM Range to a normalized text range (start <= end guaranteed). */
export function domRangeToTextRange(ix: TextIndex, range: AbstractRange): { start: number; end: number } {
  const a = domToTextOffset(ix, range.startContainer, range.startOffset);
  const b = domToTextOffset(ix, range.endContainer, range.endOffset);
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/**
 * Materialize a normalized text range as a DOM Range. The start snaps forward
 * over gap characters, the end snaps backward, so the Range covers exactly the
 * content characters of [start, end). Requires a Range-capable document
 * (browser/happy-dom); returns null for an empty/gap-only range.
 */
export function textRangeToDomRange(ix: TextIndex, start: number, end: number): Range | null {
  const s = Math.max(0, start);
  const e = Math.min(end, ix.text.length);
  if (s >= e) return null;

  // First content character at/after s that is still before e.
  let sk = lowerBound(ix.chunks.length, (c) => ix.chunks[c]!.textStart + ix.chunks[c]!.len > s);
  if (sk >= ix.chunks.length) return null;
  const sChunk = ix.chunks[sk]!;
  const sChar = Math.max(s, sChunk.textStart);
  if (sChar >= e) return null;

  // Last content character before e.
  const ek = lowerBound(ix.chunks.length, (c) => ix.chunks[c]!.textStart >= e);
  const eChunk = ix.chunks[ek - 1]!; // ek >= 1 because sChunk.textStart < e
  const eChar = Math.min(e - 1, eChunk.textStart + eChunk.len - 1);

  const doc: Document | null =
    ix.root.nodeType === DOCUMENT_NODE ? (ix.root as Document) : ix.root.ownerDocument;
  if (!doc || typeof doc.createRange !== 'function') {
    throw new Error('textRangeToDomRange requires a Range-capable document');
  }
  const range = doc.createRange();
  range.setStart(sChunk.node, sChunk.nodeStart + (sChar - sChunk.textStart));
  range.setEnd(eChunk.node, eChunk.nodeStart + (eChar - eChunk.textStart) + 1);
  return range;
}
