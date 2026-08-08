/**
 * Parent side of the iframe channel. The sandboxed frame has an opaque origin
 * (event.origin === "null"), so identity is established by `event.source ===
 * iframe.contentWindow` plus a per-load random capability token that both
 * sides stamp on every message. No secrets cross this channel.
 */

import type { TextAnchor } from '../anchoring/text.js';
import type { AnchorState, AnnotatorAnchorInput, FrameMessage, ParentMessage } from '../annotator/protocol.js';

export interface BridgeCallbacks {
  onReady?: () => void;
  onCapabilities?: (highlights: boolean) => void;
  onSelection?: (
    anchor: TextAnchor | null,
    quotedText: string,
    rect: { top: number; left: number; bottom: number; right: number } | null,
  ) => void;
  onHighlightClick?: (commentIds: string[]) => void;
  onAnchorStates?: (states: { id: string; state: AnchorState }[]) => void;
  onLayout?: (contentWidth: number) => void;
  onPositions?: (positions: { id: string; top: number }[]) => void;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class AnnotatorBridge {
  private readonly token = randomToken();
  private ready = false;
  private pendingAnchors: AnnotatorAnchorInput[] | null = null;

  constructor(
    private readonly iframe: HTMLIFrameElement,
    private readonly callbacks: BridgeCallbacks,
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
    this.post({ token: this.token, type: 'annotator-init' });
  }

  private onMessage = (e: MessageEvent): void => {
    if (e.source !== this.iframe.contentWindow) return;
    const msg = e.data as FrameMessage;
    if (!msg || typeof msg !== 'object' || msg.token !== this.token) return;
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        if (this.pendingAnchors) {
          this.post({ token: this.token, type: 'anchors', anchors: this.pendingAnchors });
          this.pendingAnchors = null;
        }
        this.callbacks.onReady?.();
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
  sendAnchors(anchors: AnnotatorAnchorInput[]): void {
    if (!this.ready) {
      this.pendingAnchors = anchors;
      return;
    }
    this.post({ token: this.token, type: 'anchors', anchors });
  }

  focusComment(commentId: string | null): void {
    this.post({ token: this.token, type: 'focus', commentId });
  }

  scrollToComment(commentId: string): void {
    this.post({ token: this.token, type: 'scroll', commentId });
  }
}
