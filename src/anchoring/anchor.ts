/**
 * High-level anchor API over the DOM adapter: describe a user selection as a
 * TextAnchor and re-locate an anchor as a DOM Range.
 */

import {
  buildTextIndex,
  domRangeToTextRange,
  textRangeToDomRange,
  type AbstractRange,
  type TextIndex,
} from './index.js';
import { describeTextAnchor, locateTextAnchor, type LocateOptions, type TextAnchor } from './text.js';

export interface AnchorOptions {
  /** Reuse a prebuilt index instead of rebuilding it from root. */
  index?: TextIndex;
}

/**
 * Describe a DOM Range as a TextAnchor. Whitespace at the selection ends is
 * trimmed into the context (double-click selections include a trailing space;
 * triple-click selections end at offset 0 of the next block). Returns null
 * when the trimmed selection is empty.
 */
export function describeAnchor(root: Node, range: AbstractRange, opts?: AnchorOptions): TextAnchor | null {
  const ix = opts?.index ?? buildTextIndex(root);
  let { start, end } = domRangeToTextRange(ix, range);
  while (start < end && ix.text[start] === ' ') start++;
  while (end > start && ix.text[end - 1] === ' ') end--;
  if (start >= end) return null;
  return describeTextAnchor(ix.text, start, end);
}

/**
 * Re-locate an anchor in a DOM tree, returning a live Range or null when the
 * quote no longer exists (orphaned). Requires a Range-capable document; on the
 * server, use buildTextIndex + locateTextAnchor directly instead.
 */
export function locateAnchor(
  root: Node,
  anchor: TextAnchor,
  opts?: AnchorOptions & LocateOptions,
): Range | null {
  const ix = opts?.index ?? buildTextIndex(root);
  const located = locateTextAnchor(ix.text, anchor, opts);
  if (!located) return null;
  return textRangeToDomRange(ix, located.start, located.end);
}
