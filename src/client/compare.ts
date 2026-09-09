/**
 * Compare mode of the viewer page: two sandboxed frames (the older version on
 * the left, the shown one on the right), a word-level diff of their rendered
 * text, and a sidebar listing every change. Each frame reports its normalized
 * text through the annotator (after the artifact's own scripts have run, so
 * client-rendered content is compared as displayed); the parent diffs the two
 * texts and sends each frame the ranges to paint on its side.
 *
 * Browser-only; covered by Playwright, not unit tests (the diff itself is in
 * shared/diff.ts and unit-tested there).
 */

import { diffText, wordsAfter, wordsBefore, type DiffHunk } from '../shared/diff.js';
import { AnnotatorBridge } from './bridge.js';
import { FrameScaler } from './frameScale.js';
import { initSidebarCollapse } from './sidebarCollapse.js';

const CONTEXT_WORDS = 4;
const CHANGE_PREVIEW_MAX = 240;

export interface CompareData {
  oldVersionNumber: number;
  newVersionNumber: number;
}

const COMPARE_CSS = `
.compare-summary { font-size: 12px; color: var(--color-muted); margin: 0 0 12px; }
.compare-summary .compare-legend { display: inline-flex; gap: 10px; margin-left: 6px; }
.compare-legend span { padding: 0 5px; border-radius: 3px; }
.compare-legend .legend-added { background: rgba(34, 197, 94, 0.28); }
.compare-legend .legend-removed { background: rgba(239, 68, 68, 0.26); text-decoration: line-through; }
.change-card { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: var(--shadow-whisper); padding: 10px 12px; margin-bottom: 10px; cursor: pointer; font-size: 12.5px; line-height: 1.55; transition: border-color 150ms ease-out, box-shadow 150ms ease-out; }
.change-card:hover { border-color: var(--color-rule-2); }
.change-card.focused { border-color: var(--color-accent-bright); box-shadow: 0 0 0 1px var(--color-accent-bright); }
.change-card .change-kind { font-family: var(--font-mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-muted); margin-bottom: 4px; }
.change-card .change-text { word-break: break-word; }
.change-card .change-context { color: var(--color-muted); }
.change-card del { background: rgba(239, 68, 68, 0.18); color: #991b1b; text-decoration: line-through; text-decoration-color: rgba(153, 27, 27, 0.5); border-radius: 2px; padding: 0 2px; }
.change-card ins { background: rgba(34, 197, 94, 0.22); color: #166534; text-decoration: none; border-radius: 2px; padding: 0 2px; }
.compare-empty { font-size: 12.5px; color: var(--color-muted); }
.compare-empty p { margin: 0 0 6px; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (children) {
    for (const child of children) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function initCompare(compare: CompareData): void {
  const newFrame = document.getElementById('artifact-frame') as HTMLIFrameElement | null;
  const oldFrame = document.getElementById('compare-frame') as HTMLIFrameElement | null;
  const sidebar = document.getElementById('sidebar');
  const title = document.getElementById('comments-title');
  const railLabel = document.getElementById('comments-rail-label');
  const prevButton = document.getElementById('prev-comment') as HTMLButtonElement | null;
  const nextButton = document.getElementById('next-comment') as HTMLButtonElement | null;
  const noHighlightsBanner = document.getElementById('no-highlights-banner');
  if (!newFrame || !oldFrame || !sidebar) return;

  const style = document.createElement('style');
  style.setAttribute('data-artifact-compare', '');
  style.textContent = COMPARE_CSS;
  document.head.appendChild(style);

  if (noHighlightsBanner) {
    noHighlightsBanner.textContent = "This browser can't paint changes inside the artifact; they are still listed here.";
  }

  const oldScaler = new FrameScaler(document.getElementById('compare-pane-old-frame'), oldFrame);
  const newScaler = new FrameScaler(document.getElementById('compare-pane-new-frame'), newFrame);
  const refit = (): void => {
    oldScaler.apply();
    newScaler.apply();
  };
  window.addEventListener('resize', refit);
  initSidebarCollapse(refit);

  let oldText: string | null = null;
  let newText: string | null = null;
  let hunks: DiffHunk[] = [];
  let focusedId: string | null = null;
  const cards = new Map<string, HTMLElement>();

  const label = `v${compare.oldVersionNumber} → v${compare.newVersionNumber}`;

  function setTitle(text: string): void {
    if (title) title.textContent = text;
    if (railLabel) railLabel.textContent = text;
  }
  setTitle('Changes');

  function renderWaiting(): void {
    sidebar!.textContent = '';
    sidebar!.appendChild(el('div', 'compare-empty', [el('p', undefined, [`Comparing ${label}…`])]));
  }

  /** The words around a hunk, taken from whichever text has content there. */
  function contextFor(h: DiffHunk): { before: string; after: string } {
    if (h.newStart < h.newEnd || h.oldStart === h.oldEnd) {
      return { before: wordsBefore(newText!, h.newStart, CONTEXT_WORDS), after: wordsAfter(newText!, h.newEnd, CONTEXT_WORDS) };
    }
    return { before: wordsBefore(oldText!, h.oldStart, CONTEXT_WORDS), after: wordsAfter(oldText!, h.oldEnd, CONTEXT_WORDS) };
  }

  function buildCard(h: DiffHunk): HTMLElement {
    const removed = oldText!.slice(h.oldStart, h.oldEnd);
    const added = newText!.slice(h.newStart, h.newEnd);
    const kind = removed && added ? 'Changed' : added ? 'Added' : 'Removed';
    const { before, after } = contextFor(h);
    const text = el('div', 'change-text');
    if (before) text.appendChild(el('span', 'change-context', [`${h.newStart > 0 || h.oldStart > 0 ? '…' : ''}${before} `]));
    if (removed) text.appendChild(el('del', undefined, [truncate(removed, CHANGE_PREVIEW_MAX)]));
    if (removed && added) text.appendChild(document.createTextNode(' '));
    if (added) text.appendChild(el('ins', undefined, [truncate(added, CHANGE_PREVIEW_MAX)]));
    if (after) text.appendChild(el('span', 'change-context', [` ${after}…`]));
    const card = el('div', `change-card${focusedId === h.id ? ' focused' : ''}`, [el('div', 'change-kind', [kind]), text]);
    card.setAttribute('data-hunk-id', h.id);
    card.addEventListener('click', () => focusHunk(h.id, { scrollFrames: true }));
    return card;
  }

  function renderChanges(): void {
    sidebar!.textContent = '';
    cards.clear();
    const count = hunks.length;
    setTitle(count > 0 ? `Changes (${count})` : 'Changes');
    if (prevButton) prevButton.disabled = count === 0;
    if (nextButton) nextButton.disabled = count === 0;
    if (count === 0) {
      sidebar!.appendChild(
        el('div', 'compare-empty', [
          el('p', undefined, [`No text changes between v${compare.oldVersionNumber} and v${compare.newVersionNumber}.`]),
          el('p', undefined, ['Layout, styling, or images may still differ — look at the two panes side by side.']),
        ]),
      );
      return;
    }
    const legend = el('span', 'compare-legend', [
      el('span', 'legend-added', ['added']),
      el('span', 'legend-removed', ['removed']),
    ]);
    sidebar!.appendChild(el('div', 'compare-summary', [`${count} change${count === 1 ? '' : 's'} from ${label}`, legend]));
    for (const h of hunks) {
      const card = buildCard(h);
      cards.set(h.id, card);
      sidebar!.appendChild(card);
    }
  }

  function applyFocusClasses(): void {
    for (const [id, card] of cards) card.classList.toggle('focused', id === focusedId);
  }

  function focusHunk(id: string, opts?: { scrollFrames?: boolean; scrollCard?: boolean }): void {
    if (focusedId !== id) {
      focusedId = id;
      oldBridge.focusAnchor(id);
      newBridge.focusAnchor(id);
      applyFocusClasses();
    }
    if (opts?.scrollFrames) {
      oldBridge.scrollToAnchor(id);
      newBridge.scrollToAnchor(id);
    }
    if (opts?.scrollCard) cards.get(id)?.scrollIntoView({ block: 'nearest' });
  }

  function clearFocus(): void {
    if (focusedId === null) return;
    focusedId = null;
    oldBridge.focusAnchor(null);
    newBridge.focusAnchor(null);
    applyFocusClasses();
  }

  function navigate(dir: 1 | -1): void {
    if (hunks.length === 0) return;
    const at = focusedId ? hunks.findIndex((h) => h.id === focusedId) : -1;
    const next = at === -1 ? (dir === 1 ? 0 : hunks.length - 1) : (at + dir + hunks.length) % hunks.length;
    focusHunk(hunks[next]!.id, { scrollFrames: true, scrollCard: true });
  }
  prevButton?.addEventListener('click', () => navigate(-1));
  nextButton?.addEventListener('click', () => navigate(1));

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target || target.closest('.change-card') || target.closest('.comment-nav')) return;
    clearFocus();
  });

  function recompute(): void {
    if (oldText === null || newText === null) {
      renderWaiting();
      return;
    }
    hunks = diffText(oldText, newText);
    oldBridge.sendDiff(
      'removed',
      hunks.map((h) => ({ id: h.id, start: h.oldStart, end: h.oldEnd })),
    );
    newBridge.sendDiff(
      'added',
      hunks.map((h) => ({ id: h.id, start: h.newStart, end: h.newEnd })),
    );
    if (focusedId && !hunks.some((h) => h.id === focusedId)) focusedId = null;
    renderChanges();
  }

  const onDiffClick = (ids: string[]): void => {
    const id = ids.find((candidate) => hunks.some((h) => h.id === candidate));
    if (id) focusHunk(id, { scrollCard: true });
    else clearFocus();
  };
  const onCapabilities = (highlights: boolean): void => {
    if (!highlights) noHighlightsBanner?.removeAttribute('hidden');
  };

  const oldBridge = new AnnotatorBridge(
    oldFrame,
    {
      onText: (text) => {
        oldText = text;
        recompute();
      },
      onLayout: (width) => oldScaler.report(width),
      onDiffClick,
      onCapabilities,
    },
    { reportText: true },
  );
  const newBridge = new AnnotatorBridge(
    newFrame,
    {
      onText: (text) => {
        newText = text;
        recompute();
      },
      onLayout: (width) => newScaler.report(width),
      onDiffClick,
      onCapabilities,
    },
    { reportText: true },
  );

  renderWaiting();
}
