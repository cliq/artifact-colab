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

/** Parent → frame. */
export type ParentMessage =
  | { token: string; type: 'annotator-init' }
  | { token: string; type: 'anchors'; anchors: AnnotatorAnchorInput[] }
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
  | { token: string; type: 'anchor:states'; states: { id: string; state: AnchorState }[] }
  /** Natural content width, so the parent can scale wide artifacts to fit. */
  | { token: string; type: 'layout'; contentWidth: number }
  /**
   * Current viewport-relative y (frame CSS px) of each located anchor,
   * streamed on scroll/resize/re-render so the sidebar can align comment
   * cards with the content they reference.
   */
  | { token: string; type: 'positions'; positions: { id: string; top: number }[] };
