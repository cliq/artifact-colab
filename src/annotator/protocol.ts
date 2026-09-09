/**
 * postMessage vocabulary between the viewer page (parent) and the annotator
 * running inside the sandboxed artifact iframe.
 *
 * The frame has an opaque origin, so origin checks are impossible ("null").
 * Instead the parent generates a random capability token per load, sends it in
 * `annotator-init`, and both sides stamp and verify it on every message.
 * No secrets ever cross this channel.
 */

import type { TextAnchor } from '../anchoring/text.js';

export type AnchorState = 'anchored' | 'ambiguous' | 'orphaned';

export interface AnnotatorAnchorInput {
  id: string;
  anchor: TextAnchor;
  status: 'open' | 'resolved';
}

/**
 * A text range of this frame's normalized text to paint as part of a version
 * diff. `id` is the hunk id, shared with the other frame so the parent can
 * focus and scroll both sides at once. An empty range (start === end) marks
 * where the other version inserted or removed text: nothing is painted, but
 * the position is still reported and scrollable.
 */
export interface DiffRangeInput {
  id: string;
  start: number;
  end: number;
}

/** Parent → frame. */
export type ParentMessage =
  /** `reportText` asks the frame to post its normalized text (and again whenever it changes) — compare mode. */
  | { token: string; type: 'annotator-init'; reportText?: boolean }
  /** `showResolved` paints resolved anchors (muted) instead of hiding them — the sidebar's Resolved/All filters. */
  | { token: string; type: 'anchors'; anchors: AnnotatorAnchorInput[]; showResolved?: boolean }
  /** Version diff to paint: this frame shows the `kind` side of each hunk. */
  | { token: string; type: 'diff'; kind: 'added' | 'removed'; ranges: DiffRangeInput[] }
  /** `id` is a comment id or a diff hunk id. */
  | { token: string; type: 'focus'; commentId: string | null }
  | { token: string; type: 'scroll'; commentId: string };

/** Frame → parent. */
export type FrameMessage =
  | { token: string; type: 'ready' }
  | { token: string; type: 'capabilities'; highlights: boolean }
  | {
      token: string;
      type: 'selection';
      anchor: TextAnchor | null;
      quotedText: string;
      /** Viewport rect of the selection end, for positioning the composer. */
      rect: { top: number; left: number; bottom: number; right: number } | null;
    }
  | { token: string; type: 'highlight:click'; commentIds: string[] }
  /** Diff hunks under a click (compare mode); empty when the click missed every painted change. */
  | { token: string; type: 'diff:click'; ids: string[] }
  /** The frame's normalized text, on request (`reportText`) and after every change to it. */
  | { token: string; type: 'text'; text: string }
  | { token: string; type: 'anchor:states'; states: { id: string; state: AnchorState }[] }
  /** Natural content width, so the parent can scale wide artifacts to fit. */
  | { token: string; type: 'layout'; contentWidth: number }
  /**
   * Current viewport-relative y (frame CSS px) of each located anchor (comment
   * or diff hunk) plus its text offset (a stable tie-breaker for anchors on the same line),
   * streamed on scroll/resize/re-render so the sidebar can align comment
   * cards with the content they reference. Anchors whose range has no box
   * (inside a closed <details>, display:none, …) are left out.
   */
  | { token: string; type: 'positions'; positions: AnchorPosition[] };

export interface AnchorPosition {
  id: string;
  top: number;
  start: number;
}
