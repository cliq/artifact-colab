/**
 * Annotator runtime, inlined into artifact HTML served in the sandboxed
 * iframe. Paints comment highlights via the CSS Custom Highlight API (never
 * wraps spans — artifact JS re-renders must keep working), captures text
 * selections, and talks to the parent viewer via token-stamped postMessage.
 *
 * Browser-only by design; covered by the Playwright e2e, not unit tests.
 */

import { installExternalLinks } from './links.js';

import { describeAnchor } from '../anchoring/anchor.js';
import { buildTextIndex, domToTextOffset, textRangeToDomRange, type TextIndex } from '../anchoring/index.js';
import { locateTextAnchor } from '../anchoring/text.js';
import type { AnchorPosition, AnnotatorAnchorInput, DiffRangeInput, FrameMessage, ParentMessage } from './protocol.js';

installExternalLinks(document);

const MAX_SELECTION_CHARS = 10_000;
const RELOCATE_DEBOUNCE_MS = 200;

interface LocatedComment {
  input: AnnotatorAnchorInput;
  start: number;
  end: number;
  ambiguous: boolean;
  range: Range;
}

/** A version-diff hunk mapped onto this frame's DOM. */
interface LocatedDiff {
  id: string;
  start: number;
  /** The range to paint (and scroll to); null for an empty hunk. */
  range: Range | null;
  /** Where an empty hunk sits: the neighbouring character, for positions and scrolling only. */
  probe: Range;
}

const HIGHLIGHT_CSS = `
::highlight(ac-open) { background-color: rgba(255, 200, 40, 0.4); color: inherit; }
::highlight(ac-ambiguous) { background-color: rgba(255, 200, 40, 0.2); }
::highlight(ac-resolved) { background-color: rgba(120, 120, 120, 0.18); color: inherit; }
::highlight(ac-focused) { background-color: rgba(255, 145, 0, 0.6); }
::highlight(ac-added) { background-color: rgba(34, 197, 94, 0.28); color: inherit; }
::highlight(ac-removed) { background-color: rgba(239, 68, 68, 0.26); color: inherit; text-decoration: line-through; text-decoration-color: rgba(153, 27, 27, 0.6); }
::highlight(ac-diff-focused) { background-color: rgba(255, 145, 0, 0.6); color: inherit; }
`;

function start(): void {
  let token: string | null = null;
  let ix: TextIndex | null = null;
  let anchors: AnnotatorAnchorInput[] = [];
  let located: LocatedComment[] = [];
  let focusedId: string | null = null;
  let showResolved = false;
  let relocateTimer: number | undefined;
  let observer: MutationObserver | null = null;
  /** Compare mode: post the normalized text to the parent whenever it changes. */
  let reportText = false;
  let lastReportedText: string | null = null;
  let diffKind: 'added' | 'removed' = 'added';
  let diffRanges: DiffRangeInput[] = [];
  let locatedDiff: LocatedDiff[] = [];

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

  function maybeReportText(): void {
    if (!reportText || !token || !ix) return;
    if (ix.text === lastReportedText) return;
    lastReportedText = ix.text;
    post({ token, type: 'text', text: ix.text });
  }

  /** Map the diff hunks onto DOM ranges of the current index. */
  function locateDiff(currentIx: TextIndex): void {
    locatedDiff = [];
    if (diffRanges.length === 0 || currentIx.text.length === 0) return;
    for (const input of diffRanges) {
      const range = input.start < input.end ? textRangeToDomRange(currentIx, input.start, input.end) : null;
      // An empty hunk (text only on the other side) still needs a spot to
      // scroll to and report: the character right after it, or the last one.
      const probeStart = Math.min(input.start, currentIx.text.length - 1);
      const probe = range ?? textRangeToDomRange(currentIx, probeStart, probeStart + 1);
      if (!probe) continue;
      locatedDiff.push({ id: input.id, start: input.start, range, probe });
    }
  }

  function paint(): void {
    if (!highlightsSupported || !ix) return;
    try {
      const open: Range[] = [];
      const ambiguous: Range[] = [];
      const resolved: Range[] = [];
      const focused: Range[] = [];
      for (const c of located) {
        if (c.input.id === focusedId) {
          focused.push(c.range);
          continue;
        }
        if (c.input.status === 'resolved') {
          // Hidden unless the sidebar is showing resolved threads.
          if (showResolved) resolved.push(c.range);
          continue;
        }
        (c.ambiguous ? ambiguous : open).push(c.range);
      }
      const diffRangesToPaint: Range[] = [];
      const diffFocused: Range[] = [];
      for (const d of locatedDiff) {
        if (!d.range) continue;
        (d.id === focusedId ? diffFocused : diffRangesToPaint).push(d.range);
      }
      const registry = CSS.highlights;
      const priorities: [string, Range[], number][] = [
        ['ac-resolved', resolved, 0],
        ['ac-open', open, 1],
        ['ac-ambiguous', ambiguous, 1],
        ['ac-focused', focused, 2],
        ['ac-added', diffKind === 'added' ? diffRangesToPaint : [], 1],
        ['ac-removed', diffKind === 'removed' ? diffRangesToPaint : [], 1],
        ['ac-diff-focused', diffFocused, 2],
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
    const positions: AnchorPosition[] = [];
    for (const c of located) {
      const rect = c.range.getBoundingClientRect();
      // A collapsed rect means the anchor has no layout box right now (closed
      // <details>, display:none); reporting y=0 would pin its card to the top.
      if (rect.width === 0 && rect.height === 0) continue;
      positions.push({ id: c.input.id, top: rect.top, start: c.start });
    }
    for (const d of locatedDiff) {
      const rect = d.probe.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      positions.push({ id: d.id, top: rect.top, start: d.start });
    }
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
    maybeReportText();
    locateDiff(currentIx);
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
    if (diffRanges.length > 0) {
      const ids =
        at === null ? [] : diffRanges.filter((d) => d.start < d.end && d.start <= at && at < d.end).map((d) => d.id);
      post({ token, type: 'diff:click', ids });
    }
  }

  /** Bring a comment's highlight, or a diff hunk, into view. */
  function scrollToAnchor(id: string): void {
    const range = located.find((l) => l.input.id === id)?.range ?? locatedDiff.find((d) => d.id === id)?.probe;
    if (!range) return;
    const rect = range.getBoundingClientRect();
    window.scrollTo({ top: rect.top + window.scrollY - window.innerHeight / 3, behavior: 'smooth' });
  }

  function onMessage(e: MessageEvent): void {
    if (e.source !== window.parent) return;
    const msg = e.data as ParentMessage;
    if (!msg || typeof msg !== 'object' || typeof msg.token !== 'string') return;
    if (msg.type === 'annotator-init') {
      if (token !== null) return; // token is set once per load
      token = msg.token;
      reportText = msg.reportText === true;
      post({ token, type: 'capabilities', highlights: highlightsSupported });
      rebuildIndex();
      startObserver();
      post({ token, type: 'ready' });
      maybeReportText();
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
        showResolved = msg.showResolved === true;
        try {
          relocateAll();
        } catch {
          /* keep the artifact alive */
        }
        break;
      case 'diff':
        diffKind = msg.kind === 'removed' ? 'removed' : 'added';
        diffRanges = Array.isArray(msg.ranges) ? msg.ranges : [];
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
        scrollToAnchor(msg.commentId);
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
