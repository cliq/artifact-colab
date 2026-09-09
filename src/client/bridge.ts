/**
 * Parent side of the iframe channel. The sandboxed frame has an opaque origin
 * (event.origin === "null"), so identity is established by `event.source ===
 * iframe.contentWindow` plus a per-load random capability token that both
 * sides stamp on every message. No secrets cross this channel.
 */

import type { TextAnchor } from '../anchoring/text.js';
import type {
  AnchorPosition,
  AnchorState,
  AnnotatorAnchorInput,
  DiffRangeInput,
  FrameMessage,
  ParentMessage,
} from '../annotator/protocol.js';

export interface BridgeCallbacks {
  onReady?: () => void;
  /** The frame's normalized text (only when constructed with `reportText`); repeats whenever it changes. */
  onText?: (text: string) => void;
  onDiffClick?: (ids: string[]) => void;
  onCapabilities?: (highlights: boolean) => void;
  onSelection?: (
    anchor: TextAnchor | null,
    quotedText: string,
    rect: { top: number; left: number; bottom: number; right: number } | null,
  ) => void;
  onHighlightClick?: (commentIds: string[]) => void;
  onAnchorStates?: (states: { id: string; state: AnchorState }[]) => void;
  onLayout?: (contentWidth: number) => void;
  onPositions?: (positions: AnchorPosition[]) => void;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface BridgeOptions {
  /** Ask the annotator to report the frame's normalized text (compare mode). */
  reportText?: boolean;
}

export class AnnotatorBridge {
  private readonly token = randomToken();
  private ready = false;
  private pendingAnchors: { anchors: AnnotatorAnchorInput[]; showResolved: boolean } | null = null;
  private pendingDiff: { kind: 'added' | 'removed'; ranges: DiffRangeInput[] } | null = null;

  constructor(
    private readonly iframe: HTMLIFrameElement,
    private readonly callbacks: BridgeCallbacks,
    private readonly options: BridgeOptions = {},
  ) {
    window.addEventListener('message', this.onMessage);
    this.iframe.addEventListener('load', () => this.init());
    // The frame may already be loaded by the time the bridge is constructed;
    // the annotator accepts only the first init, so a duplicate is harmless.
    this.init();
  }

  private post(msg: ParentMessage): void {
    this.iframe.contentWindow?.postMessage(msg, '*');
  }

  private init(): void {
    this.ready = false;
    this.post({ token: this.token, type: 'annotator-init', reportText: this.options.reportText === true });
  }

  private onMessage = (e: MessageEvent): void => {
    if (e.source !== this.iframe.contentWindow) return;
    const msg = e.data as FrameMessage;
    if (!msg || typeof msg !== 'object' || msg.token !== this.token) return;
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        if (this.pendingAnchors) {
          this.post({ token: this.token, type: 'anchors', ...this.pendingAnchors });
          this.pendingAnchors = null;
        }
        if (this.pendingDiff) {
          this.post({ token: this.token, type: 'diff', ...this.pendingDiff });
          this.pendingDiff = null;
        }
        this.callbacks.onReady?.();
        break;
      case 'text':
        this.callbacks.onText?.(msg.text);
        break;
      case 'diff:click':
        this.callbacks.onDiffClick?.(msg.ids);
        break;
      case 'capabilities':
        this.callbacks.onCapabilities?.(msg.highlights);
        break;
      case 'selection':
        this.callbacks.onSelection?.(msg.anchor, msg.quotedText, msg.rect);
        break;
      case 'highlight:click':
        this.callbacks.onHighlightClick?.(msg.commentIds);
        break;
      case 'anchor:states':
        this.callbacks.onAnchorStates?.(msg.states);
        break;
      case 'layout':
        this.callbacks.onLayout?.(msg.contentWidth);
        break;
      case 'positions':
        this.callbacks.onPositions?.(msg.positions);
        break;
    }
  };

  /** Send the current set of comment anchors; queued until the frame is ready. */
  sendAnchors(anchors: AnnotatorAnchorInput[], showResolved = false): void {
    if (!this.ready) {
      this.pendingAnchors = { anchors, showResolved };
      return;
    }
    this.post({ token: this.token, type: 'anchors', anchors, showResolved });
  }

  /** Paint one side of a version diff; queued until the frame is ready. */
  sendDiff(kind: 'added' | 'removed', ranges: DiffRangeInput[]): void {
    if (!this.ready) {
      this.pendingDiff = { kind, ranges };
      return;
    }
    this.post({ token: this.token, type: 'diff', kind, ranges });
  }

  /** Highlight a comment or diff hunk as focused (null clears). */
  focusAnchor(id: string | null): void {
    this.post({ token: this.token, type: 'focus', commentId: id });
  }

  /** Scroll the frame so a comment's passage or a diff hunk is in view. */
  scrollToAnchor(id: string): void {
    this.post({ token: this.token, type: 'scroll', commentId: id });
  }
}
