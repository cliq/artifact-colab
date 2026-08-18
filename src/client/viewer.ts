/**
 * Viewer page client: renders the comment sidebar, talks to the sandboxed
 * artifact iframe through `AnnotatorBridge`, and syncs comments with the
 * REST API. Browser-only, dependency-free; covered by Playwright, not unit
 * tests.
 */

import type { AnchorState, AnnotatorAnchorInput } from '../annotator/protocol.js';
import type { TextAnchor } from '../anchoring/text.js';
import { AnnotatorBridge } from './bridge.js';

const POLL_INTERVAL_MS = 30_000;
const QUOTE_PREVIEW_MAX = 200;

interface ViewerData {
  slug: string;
  title: string;
  versionId: string;
  versionNumber: number;
  isCurrentVersion: boolean;
  csrfToken: string;
}

interface AuthorDTO {
  email: string;
  name: string | null;
  avatarUrl: string;
  /** Author is not a member of the document's team (public-doc guest). */
  isGuest: boolean;
}

interface ReplyDTO {
  id: string;
  body: string;
  author: AuthorDTO;
  createdAt: string;
}

interface AnchorStateDTO {
  state: AnchorState;
  start: number | null;
  end: number | null;
}

interface ThreadDTO {
  id: string;
  body: string;
  quotedText: string;
  anchor: TextAnchor;
  status: 'open' | 'resolved';
  author: AuthorDTO;
  createdAt: string;
  createdVersionId: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  anchorState: AnchorStateDTO | null;
  replies: ReplyDTO[];
}

const SIDEBAR_CSS = `
#sidebar { font-family: inherit; font-size: 13px; color: var(--color-ink-2); }
.section-header { font-family: var(--font-mono); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-muted); margin: 16px 0 8px; }
.section-header:first-child { margin-top: 0; }
.section-empty { font-size: 12px; color: var(--color-muted); margin-bottom: 8px; }
.thread-card { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: var(--shadow-whisper); padding: 12px; margin-bottom: 10px; cursor: pointer; transition: border-color 150ms ease-out, box-shadow 150ms ease-out; }
.aligned-zone { position: relative; }
.thread-card.aligned { position: absolute; left: 0; right: 0; margin: 0; transition: top 140ms ease-out, border-color 150ms ease-out, box-shadow 150ms ease-out; }
.thread-card:hover { border-color: var(--color-rule-2); }
.thread-card.focused { border-color: var(--color-accent-bright); box-shadow: 0 0 0 1px var(--color-accent-bright); }
.thread-quote { font-style: italic; font-size: 12px; color: var(--color-muted); cursor: pointer; margin-bottom: 6px; border-left: 2px solid var(--color-accent-bright); padding-left: 6px; }
.thread-quote:hover { color: var(--color-accent); }
.thread-badges { margin-bottom: 4px; }
.badge { display: inline-block; font-family: var(--font-mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; padding: 1px 6px; border-radius: 3px; margin-right: 4px; }
.badge-orphaned { background: #fee2e2; color: #b91c1c; }
.badge-ambiguous { background: #fef3c7; color: #92400e; }
.badge-guest { background: var(--color-paper-2); color: var(--color-muted); border: 1px solid var(--color-border); padding: 0 5px; }
.thread-meta { font-size: 11px; color: var(--color-muted); margin-bottom: 4px; display: flex; align-items: center; gap: 5px; }
.thread-meta .author { font-weight: 600; color: var(--color-ink); }
.thread-meta .avatar { width: 16px; height: 16px; border-radius: 50%; flex: none; }
.thread-body { margin-bottom: 6px; white-space: pre-wrap; word-break: break-word; }
.replies { margin: 6px 0 6px 8px; border-left: 1px solid var(--color-border); padding-left: 8px; }
.reply { margin-bottom: 6px; }
.reply-body { white-space: pre-wrap; word-break: break-word; }
.reply-form { display: flex; align-items: flex-end; gap: 6px; margin-top: 6px; }
.reply-form textarea { flex: 1; font: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid var(--color-rule-2); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); resize: vertical; min-height: 28px; }
.thread-actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
button.ac-btn { font: inherit; font-size: 12px; font-weight: 500; padding: 4px 12px; border: 1px solid var(--color-rule-2); border-radius: var(--radius-pill); background: transparent; color: var(--color-text); cursor: pointer; }
button.ac-btn:hover { background: var(--color-paper-2); }
button.ac-btn-primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-accent-ink); }
button.ac-btn-primary:hover { background: var(--color-accent-hover); }
.ac-error { color: #b91c1c; font-size: 11px; }
#ac-composer { border: 1px solid var(--color-accent-bright); border-radius: var(--radius-md); background: var(--color-surface); padding: 10px; margin-bottom: 16px; }
#ac-composer textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 6px; border: 1px solid var(--color-rule-2); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); resize: vertical; min-height: 60px; margin: 6px 0; }
.composer-actions { display: flex; justify-content: flex-end; gap: 8px; }
details.resolved-section summary { cursor: pointer; font-family: var(--font-mono); font-size: 11px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 16px 0 8px; }
`;

interface ElOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
  onClick?: (e: Event) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options?: ElOptions,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options?.className) node.className = options.className;
  if (options?.text !== undefined) node.textContent = options.text;
  if (options?.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, value);
  }
  if (options?.onClick) node.addEventListener('click', options.onClick);
  if (children) {
    for (const child of children) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
  }
  return node;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Gravatar + display name (profile name when set, email otherwise) + guest badge + relative time. */
function authorMeta(author: AuthorDTO, createdAt: string): HTMLElement {
  const parts: (Node | string)[] = [
    el('img', {
      className: 'avatar',
      attrs: { src: author.avatarUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' },
    }),
    el('span', { className: 'author', attrs: { title: author.email }, text: author.name ?? author.email }),
  ];
  if (author.isGuest) {
    parts.push(el('span', { className: 'badge badge-guest', text: 'guest', attrs: { title: 'Not a member of this team' } }));
  }
  parts.push(document.createTextNode(` · ${formatTime(createdAt)}`));
  return el('div', { className: 'thread-meta' }, parts);
}

const NEWLINE_HINT = 'Enter to send · Shift+Enter for a line break';

/** Slack-style submit: Enter sends, Shift/Alt+Enter inserts a line break. */
function submitOnEnter(textarea: HTMLTextAreaElement, submit: () => void): void {
  textarea.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.shiftKey || e.altKey) return;
    e.preventDefault();
    submit();
  });
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return rtf.format(-diffSec, 'second');
  if (abs < 3600) return rtf.format(-Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(diffSec / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(-Math.round(diffSec / 86400), 'day');
  return date.toLocaleDateString();
}

function injectStyles(): void {
  const style = document.createElement('style');
  style.setAttribute('data-artifact-viewer', '');
  style.textContent = SIDEBAR_CSS;
  document.head.appendChild(style);
}

function init(): void {
  const dataEl = document.getElementById('viewer-data');
  const iframe = document.getElementById('artifact-frame') as HTMLIFrameElement | null;
  const sidebar = document.getElementById('sidebar');
  const versionPicker = document.getElementById('version-picker') as HTMLSelectElement | null;
  const noHighlightsBanner = document.getElementById('no-highlights-banner');
  const commentsTitle = document.getElementById('comments-title');
  const railLabel = document.getElementById('comments-rail-label');
  const prevButton = document.getElementById('prev-comment') as HTMLButtonElement | null;
  const nextButton = document.getElementById('next-comment') as HTMLButtonElement | null;
  if (!dataEl?.textContent || !iframe || !sidebar) return;

  const data: ViewerData = JSON.parse(dataEl.textContent);

  injectStyles();

  versionPicker?.addEventListener('change', () => {
    location.href = `${location.pathname}?version=${encodeURIComponent(versionPicker.value)}`;
  });

  const copyLinkButton = document.getElementById('copy-share-link') as HTMLButtonElement | null;
  copyLinkButton?.addEventListener('click', () => {
    const urlInput = document.querySelector<HTMLInputElement>('.share-link-row .share-url');
    if (!urlInput) return;
    urlInput.select();
    // execCommand fallback keeps copy working on plain-HTTP instances,
    // where the async clipboard API is unavailable.
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(urlInput.value).catch(() => document.execCommand('copy'));
    } else {
      document.execCommand('copy');
    }
    copyLinkButton.textContent = 'Copied';
    window.setTimeout(() => {
      copyLinkButton.textContent = 'Copy link';
    }, 2000);
  });

  // Share options apply in place: the panel stays open so the link can be
  // copied right after changing who it opens for, with the caption and menu
  // label refreshed to match. The plain form POST (full reload, panel closed)
  // remains the no-JS fallback.
  document.querySelectorAll<HTMLFormElement>('.share-panel form').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const clicked = form.querySelector<HTMLButtonElement>('.share-option');
      if (!clicked) return;
      const body = new URLSearchParams();
      new FormData(form).forEach((value, key) => body.append(key, String(value)));
      fetch(form.action, { method: 'POST', body })
        .then((res) => {
          if (!res.ok) throw new Error(`share failed: ${res.status}`);
          document.querySelectorAll('.share-option').forEach((option) => {
            option.setAttribute('aria-checked', option === clicked ? 'true' : 'false');
          });
          const note = document.querySelector('.share-link-note');
          if (note && clicked.dataset['note']) note.textContent = clicked.dataset['note'];
          const summary = document.querySelector('.share-menu summary');
          if (summary && clicked.dataset['summary']) summary.textContent = clicked.dataset['summary'];
        })
        .catch(() => form.submit());
    });
  });

  let threads: ThreadDTO[] = [];
  let lastJson: string | null = null;
  const liveStates = new Map<string, AnchorState>();
  /** In-progress reply text per thread, so re-renders don't lose typing. */
  const replyDrafts = new Map<string, string>();
  let focusedCommentId: string | null = null;
  let pendingAnchor: TextAnchor | null = null;
  let pendingQuotedText = '';

  // --- composer -------------------------------------------------------
  const composerQuote = el('div', { className: 'thread-quote' });
  const composerTextarea = el('textarea', {
    attrs: { placeholder: 'Add a comment…', title: NEWLINE_HINT },
  });
  submitOnEnter(composerTextarea, () => void saveComment());
  const composerError = el('div', { className: 'ac-error' });
  const composer = el(
    'div',
    { attrs: { id: 'ac-composer' } },
    [
      composerQuote,
      composerTextarea,
      composerError,
      el('div', { className: 'composer-actions' }, [
        el('button', {
          className: 'ac-btn',
          text: 'Cancel',
          onClick: () => {
            composerTextarea.value = '';
            hideComposer();
          },
        }),
        el('button', {
          className: 'ac-btn ac-btn-primary',
          text: 'Save',
          onClick: () => void saveComment(),
        }),
      ]),
    ],
  );
  composer.hidden = true;

  const threadsEl = el('div', { attrs: { id: 'ac-threads' } });

  sidebar.textContent = '';
  sidebar.appendChild(composer);
  sidebar.appendChild(threadsEl);

  function showComposer(quotedText: string): void {
    composerQuote.textContent = truncate(quotedText, QUOTE_PREVIEW_MAX);
    composer.hidden = false;
  }

  function hideComposer(): void {
    composer.hidden = true;
    composerError.textContent = '';
    pendingAnchor = null;
    pendingQuotedText = '';
  }

  async function saveComment(): Promise<void> {
    const body = composerTextarea.value.trim();
    if (!body || !pendingAnchor) return;
    const res = await postJson(`/api/docs/${data.slug}/comments`, {
      body,
      quotedText: pendingQuotedText,
      anchor: pendingAnchor,
      versionId: data.versionId,
    });
    if (res.ok) {
      composerTextarea.value = '';
      hideComposer();
      await fetchComments();
    } else {
      composerError.textContent = 'Could not save comment.';
    }
  }

  // --- networking -------------------------------------------------------
  async function postJson(path: string, body?: unknown): Promise<{ ok: boolean; status: number }> {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': data.csrfToken },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, status: res.status };
  }

  function sendAnchorsToFrame(): void {
    const anchors: AnnotatorAnchorInput[] = threads.map((t) => ({ id: t.id, anchor: t.anchor, status: t.status }));
    bridge.sendAnchors(anchors);
  }

  async function fetchComments(): Promise<void> {
    try {
      const res = await fetch(`/api/docs/${data.slug}/comments?version=${encodeURIComponent(data.versionId)}`);
      if (!res.ok) return;
      const json = await res.text();
      const parsed = JSON.parse(json) as { comments: ThreadDTO[] };
      threads = parsed.comments;
      sendAnchorsToFrame();
      if (json !== lastJson) {
        lastJson = json;
        renderThreads();
      }
    } catch {
      // Network hiccup; the next poll retries.
    }
  }

  // --- rendering ----------------------------------------------------
  function effectiveState(thread: ThreadDTO): AnchorState | null {
    return liveStates.get(thread.id) ?? thread.anchorState?.state ?? null;
  }

  // Focus changes must not rebuild the card DOM: a rebuild replaces the reply
  // textarea mid-click and steals focus from it.
  function applyFocusClasses(): void {
    for (const card of threadsEl.querySelectorAll('.thread-card')) {
      card.classList.toggle('focused', card.getAttribute('data-comment-id') === focusedCommentId);
    }
  }

  function focusThread(id: string, opts?: { scroll?: boolean }): void {
    if (focusedCommentId !== id) {
      focusedCommentId = id;
      bridge.focusComment(id);
      applyFocusClasses();
    }
    if (opts?.scroll) {
      threadsEl.querySelector(`[data-comment-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }

  function clearFocus(): void {
    if (focusedCommentId === null) return;
    focusedCommentId = null;
    bridge.focusComment(null);
    applyFocusClasses();
  }

  // Clicking anywhere on the parent page outside a comment card (or the
  // composer/nav controls) deselects the focused comment. Clicks inside the
  // artifact frame don't bubble here — the annotator reports those, and an
  // empty hit list clears focus via onHighlightClick.
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.thread-card') || target.closest('#ac-composer') || target.closest('.comment-nav')) return;
    clearFocus();
  });

  function buildThreadCard(thread: ThreadDTO): HTMLElement {
    const state = effectiveState(thread);
    const badges = el('div', { className: 'thread-badges' });
    if (thread.status === 'open' && state === 'orphaned') {
      badges.appendChild(el('span', { className: 'badge badge-orphaned', text: 'orphaned' }));
    }
    if (state === 'ambiguous') {
      badges.appendChild(el('span', { className: 'badge badge-ambiguous', text: 'ambiguous' }));
    }

    const quote = el('div', {
      className: 'thread-quote',
      text: truncate(thread.quotedText, QUOTE_PREVIEW_MAX),
      onClick: (e) => {
        e.stopPropagation();
        bridge.scrollToComment(thread.id);
        focusThread(thread.id);
      },
    });

    const meta = authorMeta(thread.author, thread.createdAt);

    const body = el('div', { className: 'thread-body', text: thread.body });

    const repliesEl = el('div', { className: 'replies' });
    for (const reply of thread.replies) {
      repliesEl.appendChild(
        el('div', { className: 'reply' }, [
          authorMeta(reply.author, reply.createdAt),
          el('div', { className: 'reply-body', text: reply.body }),
        ]),
      );
    }

    const replyError = el('div', { className: 'ac-error' });
    const replyTextarea = el('textarea', {
      attrs: { placeholder: 'Reply…', 'data-reply-for': thread.id, title: NEWLINE_HINT },
    });
    replyTextarea.value = replyDrafts.get(thread.id) ?? '';
    replyTextarea.addEventListener('input', () => {
      if (replyTextarea.value) replyDrafts.set(thread.id, replyTextarea.value);
      else replyDrafts.delete(thread.id);
    });
    // Starting a reply brings the passage under discussion into view. A click
    // listener (not focus) so the focus restore after a sidebar rebuild can't
    // scroll the artifact mid-typing.
    replyTextarea.addEventListener('click', () => {
      bridge.scrollToComment(thread.id);
    });
    async function submitReply(): Promise<void> {
      const value = replyTextarea.value.trim();
      if (!value) return;
      const res = await postJson(`/api/comments/${thread.id}/replies`, { body: value });
      if (res.ok) {
        replyTextarea.value = '';
        replyDrafts.delete(thread.id);
        await fetchComments();
      } else {
        replyError.textContent = 'Could not post reply.';
      }
    }
    submitOnEnter(replyTextarea, () => void submitReply());
    const replyForm = el('div', { className: 'reply-form' }, [
      replyTextarea,
      el('button', {
        className: 'ac-btn',
        text: 'Reply',
        onClick: (e) => {
          e.stopPropagation();
          void submitReply();
        },
      }),
    ]);

    const actions = el('div', { className: 'thread-actions' }, [
      thread.status === 'open'
        ? el('button', {
            className: 'ac-btn',
            text: 'Resolve',
            onClick: (e) => {
              e.stopPropagation();
              void (async () => {
                const res = await postJson(`/api/comments/${thread.id}/resolve`);
                if (res.ok) await fetchComments();
                else replyError.textContent = 'Could not resolve comment.';
              })();
            },
          })
        : el('button', {
            className: 'ac-btn',
            text: 'Reopen',
            onClick: (e) => {
              e.stopPropagation();
              void (async () => {
                const res = await postJson(`/api/comments/${thread.id}/reopen`);
                if (res.ok) await fetchComments();
                else replyError.textContent = 'Could not reopen comment.';
              })();
            },
          }),
      replyError,
    ]);

    const card = el(
      'div',
      {
        className: `thread-card${focusedCommentId === thread.id ? ' focused' : ''}`,
        attrs: { 'data-comment-id': thread.id },
        onClick: () => focusThread(thread.id),
      },
      [badges, quote, meta, body, repliesEl, replyForm, actions],
    );
    return card;
  }

  /** Cards in the aligned zone, for the position pass. */
  const alignedCards = new Map<string, HTMLElement>();
  /** Latest viewport-relative anchor tops (frame CSS px) from the annotator. */
  const framePositions = new Map<string, number>();
  const alignedZone = el('div', { className: 'aligned-zone' });

  function renderThreads(): void {
    // Rebuilding replaces every node; if the user is typing a reply, carry
    // focus and caret over to the replacement textarea.
    const active = document.activeElement;
    const activeReplyId =
      active instanceof HTMLTextAreaElement ? active.getAttribute('data-reply-for') : null;
    const caret = active instanceof HTMLTextAreaElement
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null;

    threadsEl.textContent = '';
    alignedZone.textContent = '';
    alignedCards.clear();

    const open = threads.filter((t) => t.status === 'open' && effectiveState(t) !== 'orphaned');
    const orphaned = threads.filter((t) => t.status === 'open' && effectiveState(t) === 'orphaned');
    const resolved = threads.filter((t) => t.status === 'resolved');

    threadsEl.appendChild(el('div', { className: 'section-header', text: 'Open' }));
    if (open.length === 0) {
      threadsEl.appendChild(el('div', { className: 'section-empty', text: 'No open comments.' }));
    }
    for (const thread of open) {
      const card = buildThreadCard(thread);
      card.classList.add('aligned');
      alignedCards.set(thread.id, card);
      alignedZone.appendChild(card);
    }
    threadsEl.appendChild(alignedZone);

    if (orphaned.length > 0) {
      threadsEl.appendChild(el('div', { className: 'section-header', text: 'Orphaned' }));
      for (const thread of orphaned) threadsEl.appendChild(buildThreadCard(thread));
    }

    const details = el('details', { className: 'resolved-section' });
    details.appendChild(el('summary', { text: `Resolved (${resolved.length})` }));
    for (const thread of resolved) details.appendChild(buildThreadCard(thread));
    threadsEl.appendChild(details);

    const openCount = open.length + orphaned.length;
    const title = openCount > 0 ? `Comments (${openCount})` : 'Comments';
    if (commentsTitle) commentsTitle.textContent = title;
    if (railLabel) railLabel.textContent = title;
    if (prevButton) prevButton.disabled = openCount === 0;
    if (nextButton) nextButton.disabled = openCount === 0;

    if (activeReplyId) {
      const replacement = threadsEl.querySelector<HTMLTextAreaElement>(
        `textarea[data-reply-for="${activeReplyId}"]`,
      );
      if (replacement) {
        replacement.focus();
        if (caret) replacement.setSelectionRange(caret.start, caret.end);
      }
    }

    alignCards();
  }

  /** Open comment ids in document order (live anchor position, then list order). */
  function navigableIds(): string[] {
    return threads
      .filter((t) => t.status === 'open')
      .map((t, i) => ({ id: t.id, pos: framePositions.get(t.id) ?? Number.MAX_SAFE_INTEGER - i }))
      .sort((a, b) => a.pos - b.pos)
      .map((t) => t.id);
  }

  function navigateComments(dir: 1 | -1): void {
    const ids = navigableIds();
    if (ids.length === 0) return;
    const at = focusedCommentId ? ids.indexOf(focusedCommentId) : -1;
    const next = at === -1 ? (dir === 1 ? 0 : ids.length - 1) : (at + dir + ids.length) % ids.length;
    const id = ids[next]!;
    focusThread(id, { scroll: true });
    bridge.scrollToComment(id);
  }

  prevButton?.addEventListener('click', () => navigateComments(-1));
  nextButton?.addEventListener('click', () => navigateComments(1));

  /**
   * Google-Docs-style alignment: each open card aims at its anchor's current
   * on-screen y inside the frame; overlapping targets sweep downward so cards
   * never collide. Cards without a known position stack after the last one.
   */
  function alignCards(): void {
    if (!iframe || !sidebar || alignedCards.size === 0) {
      alignedZone.style.height = '0px';
      return;
    }
    const frameRect = iframe.getBoundingClientRect();
    const zoneRect = alignedZone.getBoundingClientRect();
    // zoneRect.top shifts with the sidebar's own scroll; add scrollTop back so
    // targets are in the zone's content space. Otherwise every sidebar scroll
    // re-pins the cards to the viewport and the scroll range grows forever.
    const zoneTop = zoneRect.top + sidebar.scrollTop;

    const entries = [...alignedCards.entries()].map(([id, card]) => {
      const frameTop = framePositions.get(id);
      const target =
        frameTop === undefined ? Number.MAX_SAFE_INTEGER : frameRect.top + frameTop * currentScale - zoneTop;
      return { card, target };
    });
    entries.sort((a, b) => a.target - b.target);

    let cursor = 0;
    let bottom = 0;
    for (const entry of entries) {
      const top = Math.max(entry.target === Number.MAX_SAFE_INTEGER ? cursor : entry.target, cursor, 0);
      entry.card.style.top = `${top}px`;
      cursor = top + entry.card.offsetHeight + 10;
      bottom = Math.max(bottom, cursor);
    }
    alignedZone.style.height = `${bottom}px`;
  }

  // --- fit-to-width scaling ---------------------------------------------
  // Claude artifacts are often laid out for a full browser window. The
  // annotator reports the frame's natural content width; when it exceeds the
  // space next to the sidebar, the whole frame is scaled down to fit (the
  // browser maps pointer coordinates through the transform, so selection and
  // click hit-testing inside the frame keep working).
  const frameWrap = document.getElementById('frame-wrap');
  let naturalWidth = 0;
  let currentScale = 1;

  function applyFrameScale(): void {
    if (!frameWrap || !iframe) return;
    const available = frameWrap.clientWidth;
    const availableHeight = frameWrap.clientHeight;
    if (naturalWidth <= available + 4) {
      currentScale = 1;
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.transform = '';
      return;
    }
    currentScale = available / naturalWidth;
    iframe.style.width = `${naturalWidth}px`;
    iframe.style.height = `${availableHeight / currentScale}px`;
    iframe.style.transform = `scale(${currentScale})`;
    iframe.style.transformOrigin = '0 0';
  }

  window.addEventListener('resize', () => {
    applyFrameScale();
    alignCards();
  });

  // --- collapsible sidebar ------------------------------------------------
  // The collapsed choice is a device preference (like the agent picker on the
  // settings page), so it lives in localStorage, not per document.
  const sidebarAside = document.getElementById('comments-sidebar');
  const collapseButton = document.getElementById('collapse-sidebar');
  const expandButton = document.getElementById('expand-sidebar');
  const SIDEBAR_COLLAPSED_KEY = 'artifact-colab:comments-collapsed';

  function setSidebarCollapsed(collapsed: boolean, persist: boolean): void {
    if (!sidebarAside || !expandButton) return;
    sidebarAside.classList.toggle('collapsed', collapsed);
    expandButton.hidden = !collapsed;
    if (persist) {
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
      } catch {
        // Private browsing: the toggle still works, it just isn't remembered.
      }
    }
    // The frame just gained or lost the sidebar's width.
    applyFrameScale();
    alignCards();
  }

  collapseButton?.addEventListener('click', () => setSidebarCollapsed(true, true));
  expandButton?.addEventListener('click', () => setSidebarCollapsed(false, true));
  try {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') setSidebarCollapsed(true, false);
  } catch {
    // Ignore: default to expanded.
  }

  // --- bridge -----------------------------------------------------------
  const bridge = new AnnotatorBridge(iframe, {
    onLayout: (contentWidth) => {
      // Only ever grow within one document load: once scaled, the frame's
      // inner viewport equals the content width, so later reports shrink.
      if (contentWidth > naturalWidth) {
        naturalWidth = contentWidth;
        applyFrameScale();
      }
    },
    onPositions: (positions) => {
      framePositions.clear();
      for (const p of positions) framePositions.set(p.id, p.top);
      alignCards();
    },
    onCapabilities: (highlights) => {
      if (!highlights) noHighlightsBanner?.removeAttribute('hidden');
    },
    onSelection: (anchor, quotedText, _rect) => {
      if (!data.isCurrentVersion) return;
      if (anchor) {
        pendingAnchor = anchor;
        pendingQuotedText = quotedText;
        showComposer(quotedText);
      } else if (composerTextarea.value.trim().length === 0) {
        hideComposer();
      }
    },
    onHighlightClick: (commentIds) => {
      const id = commentIds.find((candidate) => threads.some((t) => t.id === candidate));
      if (id) focusThread(id, { scroll: true });
      else clearFocus();
    },
    onAnchorStates: (states) => {
      // The annotator re-sends states on every artifact DOM mutation; only
      // rebuild the sidebar when a state actually changed.
      let changed = false;
      for (const s of states) {
        if (liveStates.get(s.id) !== s.state) {
          liveStates.set(s.id, s.state);
          changed = true;
        }
      }
      if (changed) renderThreads();
    },
  });

  void fetchComments();
  setInterval(() => void fetchComments(), POLL_INTERVAL_MS);
}

function boot(): void {
  init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
