/**
 * Annotator runtime, inlined into artifact HTML served in the sandboxed
 * iframe. Paints comment highlights via the CSS Custom Highlight API (never
 * wraps spans — artifact JS re-renders must keep working), captures text
 * selections, and talks to the parent viewer via token-stamped postMessage.
 *
 * Browser-only by design; covered by the Playwright e2e, not unit tests.
 */

import { describeAnchor } from '../anchoring/anchor.js';
import { buildTextIndex, domToTextOffset, textRangeToDomRange, type TextIndex } from '../anchoring/index.js';
import { locateTextAnchor } from '../anchoring/text.js';
import type { AnnotatorAnchorInput, FrameMessage, ParentMessage } from './protocol.js';

const MAX_SELECTION_CHARS = 10_000;
const RELOCATE_DEBOUNCE_MS = 200;

interface LocatedComment {
  input: AnnotatorAnchorInput;
  start: number;
  end: number;
  ambiguous: boolean;
  range: Range;
}

const HIGHLIGHT_CSS = `
::highlight(ac-open) { background-color: rgba(255, 200, 40, 0.4); color: inherit; }
::highlight(ac-ambiguous) { background-color: rgba(255, 200, 40, 0.2); }
::highlight(ac-focused) { background-color: rgba(255, 145, 0, 0.6); }
`;

function start(): void {
  let token: string | null = null;
  let ix: TextIndex | null = null;
  let anchors: AnnotatorAnchorInput[] = [];
  let located: LocatedComment[] = [];
  let focusedId: string | null = null;
  let relocateTimer: number | undefined;
  let observer: MutationObserver | null = null;

  const highlightsSupported = typeof CSS !== 'undefined' && 'highlights' in CSS;

  const post = (msg: FrameMessage): void => {
    window.parent.postMessage(msg, '*');
  };

  function injectStyles(): void {
    const style = document.createElement('style');
    style.setAttribute('data-artifact-annotator', '');
    style.textContent = HIGHLIGHT_CSS;
    (document.head ?? document.documentElement).appendChild(style);
  }

  function rebuildIndex(): void {
    ix = buildTextIndex(document);
  }

  function paint(): void {
    if (!highlightsSupported || !ix) return;
    try {
      const open: Range[] = [];
      const ambiguous: Range[] = [];
      const focused: Range[] = [];
      for (const c of located) {
        if (c.input.id === focusedId) {
          focused.push(c.range);
          continue;
        }
        if (c.input.status === 'resolved') continue; // resolved fade out entirely
        (c.ambiguous ? ambiguous : open).push(c.range);
      }
      const registry = CSS.highlights;
      const priorities: [string, Range[], number][] = [
        ['ac-open', open, 1],
        ['ac-ambiguous', ambiguous, 1],
        ['ac-focused', focused, 2],
      ];
      for (const [name, ranges, priority] of priorities) {
        if (ranges.length === 0) {
          registry.delete(name);
          continue;
        }
        const highlight = new Highlight(...ranges);
        highlight.priority = priority;
        registry.set(name, highlight);
      }
    } catch {
      // Painting must never break the artifact.
    }
  }

  function reportLayout(): void {
    if (!token) return;
    // scrollWidth exceeds the viewport exactly when the artifact's content
    // doesn't fit the frame — the parent uses this to scale-to-fit.
    const contentWidth = Math.ceil(
      Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    );
    post({ token, type: 'layout', contentWidth });
  }

  let positionsFrame: number | undefined;

  function reportPositions(): void {
    if (!token) return;
    const positions = located.map((c) => ({ id: c.input.id, top: c.range.getBoundingClientRect().top }));
    post({ token, type: 'positions', positions });
  }

  function schedulePositions(): void {
    if (positionsFrame !== undefined) return;
    positionsFrame = requestAnimationFrame(() => {
      positionsFrame = undefined;
      try {
        reportPositions();
      } catch {
        /* never break the artifact */
      }
    });
  }

  function relocateAll(): void {
    rebuildIndex();
    const currentIx = ix!;
    located = [];
    const states: { id: string; state: 'anchored' | 'ambiguous' | 'orphaned' }[] = [];
    for (const input of anchors) {
      const res = locateTextAnchor(currentIx.text, input.anchor);
      if (!res) {
        states.push({ id: input.id, state: 'orphaned' });
        continue;
      }
      const range = textRangeToDomRange(currentIx, res.start, res.end);
      if (!range) {
        states.push({ id: input.id, state: 'orphaned' });
        continue;
      }
      located.push({ input, start: res.start, end: res.end, ambiguous: res.ambiguous, range });
      states.push({ id: input.id, state: res.ambiguous ? 'ambiguous' : 'anchored' });
    }
    paint();
    if (token) post({ token, type: 'anchor:states', states });
    reportLayout();
    schedulePositions();
  }

  function scheduleRelocate(): void {
    if (relocateTimer !== undefined) clearTimeout(relocateTimer);
    relocateTimer = window.setTimeout(() => {
      relocateTimer = undefined;
      try {
        relocateAll();
      } catch {
        // Never propagate into the artifact's world.
      }
    }, RELOCATE_DEBOUNCE_MS);
  }

  function startObserver(): void {
    observer = new MutationObserver(scheduleRelocate);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  }

  function onSelection(): void {
    if (!token || !ix) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      post({ token, type: 'selection', anchor: null, quotedText: '', rect: null });
      return;
    }
    const range = sel.getRangeAt(0);
    let anchor;
    try {
      anchor = describeAnchor(document, range, { index: ix });
    } catch {
      anchor = null;
    }
    if (!anchor || anchor.exact.length > MAX_SELECTION_CHARS) {
      post({ token, type: 'selection', anchor: null, quotedText: '', rect: null });
      return;
    }
    const r = range.getBoundingClientRect();
    post({
      token,
      type: 'selection',
      anchor,
      quotedText: anchor.exact,
      rect: { top: r.top, left: r.left, bottom: r.bottom, right: r.right },
    });
  }

  function caretTextOffset(x: number, y: number): number | null {
    if (!ix) return null;
    let node: Node | null = null;
    let offset = 0;
    const docAny = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    if (typeof docAny.caretPositionFromPoint === 'function') {
      const pos = docAny.caretPositionFromPoint(x, y);
      if (pos) {
        node = pos.offsetNode;
        offset = pos.offset;
      }
    } else if (typeof docAny.caretRangeFromPoint === 'function') {
      const r = docAny.caretRangeFromPoint(x, y);
      if (r) {
        node = r.startContainer;
        offset = r.startOffset;
      }
    }
    if (!node) return null;
    try {
      return domToTextOffset(ix, node, offset);
    } catch {
      return null;
    }
  }

  function onClick(e: MouseEvent): void {
    if (!token) return;
    const at = caretTextOffset(e.clientX, e.clientY);
    const hit =
      at === null
        ? []
        : located.filter((c) => c.input.status === 'open' && c.start <= at && at < c.end).map((c) => c.input.id);
    // An empty hit list means "clicked outside any highlight" — the parent
    // uses it to clear the focused comment.
    post({ token, type: 'highlight:click', commentIds: hit });
  }

  function scrollToComment(commentId: string): void {
    const c = located.find((l) => l.input.id === commentId);
    if (!c) return;
    const rect = c.range.getBoundingClientRect();
    window.scrollTo({ top: rect.top + window.scrollY - window.innerHeight / 3, behavior: 'smooth' });
  }

  function onMessage(e: MessageEvent): void {
    if (e.source !== window.parent) return;
    const msg = e.data as ParentMessage;
    if (!msg || typeof msg !== 'object' || typeof msg.token !== 'string') return;
    if (msg.type === 'annotator-init') {
      if (token !== null) return; // token is set once per load
      token = msg.token;
      post({ token, type: 'capabilities', highlights: highlightsSupported });
      rebuildIndex();
      startObserver();
      post({ token, type: 'ready' });
      reportLayout();
      window.addEventListener('resize', () => scheduleRelocate());
      // Capture phase reaches scroll events from nested scrollable elements too.
      window.addEventListener('scroll', schedulePositions, { capture: true, passive: true });
      return;
    }
    if (msg.token !== token) return;
    switch (msg.type) {
      case 'anchors':
        anchors = Array.isArray(msg.anchors) ? msg.anchors : [];
        try {
          relocateAll();
        } catch {
          /* keep the artifact alive */
        }
        break;
      case 'focus':
        focusedId = msg.commentId;
        paint();
        break;
      case 'scroll':
        scrollToComment(msg.commentId);
        break;
    }
  }

  injectStyles();
  window.addEventListener('message', onMessage);
  document.addEventListener('mouseup', () => setTimeout(onSelection, 0));
  document.addEventListener('click', onClick, true); // ::highlight is not hit-testable
}

try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => start());
  } else {
    start();
  }
} catch {
  // The annotator must never take the artifact down with it.
}
