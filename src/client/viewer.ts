/**
 * Viewer page client: renders the comment sidebar, talks to the sandboxed
 * artifact iframe through `AnnotatorBridge`, and syncs comments with the
 * REST API. Browser-only, dependency-free; covered by Playwright, not unit
 * tests.
 */

import type { AnchorPosition, AnchorState, AnnotatorAnchorInput } from '../annotator/protocol.js';
import { REACTION_EMOJIS } from '../shared/reactions.js';
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

interface ReactionDTO {
  emoji: string;
  count: number;
  users: string[];
  reactedByMe: boolean;
}

interface ReplyDTO {
  id: string;
  body: string;
  author: AuthorDTO;
  createdAt: string;
  reactions: ReactionDTO[];
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
  reactions: ReactionDTO[];
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
/* While the artifact scrolls, cards track their anchors instantly; easing would make them rubber-band. */
.aligned-zone.scrolling .thread-card.aligned { transition-property: border-color, box-shadow; }
/* Unfocused cards collapse to a summary so many comments fit beside their anchors; clicking one expands it. */
.thread-card.collapsed .thread-body { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; margin-bottom: 0; }
.thread-card.collapsed .replies, .thread-card.collapsed .reply-form, .thread-card.collapsed .thread-actions { display: none; }
.thread-card .thread-collapsed-info { display: none; font-size: 11px; color: var(--color-muted); margin-top: 6px; }
.thread-card.collapsed .thread-collapsed-info:not(:empty) { display: block; }
/* Cards whose anchor is scrolled out of view shrink to a one-line stub pinned at the sidebar's edge. */
.thread-card.stub { padding: 6px 12px; opacity: 0.75; }
.thread-card.stub .thread-quote { margin-bottom: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.thread-card.stub .thread-badges, .thread-card.stub .thread-meta, .thread-card.stub .thread-body, .thread-card.stub.collapsed .thread-collapsed-info { display: none; }
.thread-card.stub:hover { opacity: 1; }
.thread-card.edge-hidden { display: none; }
/* Folds the stubs beyond the nearest few into a count; clicking jumps to the nearest folded comment. */
.edge-more { position: absolute; left: 0; right: 0; margin: 0; font: inherit; font-size: 11px; color: var(--color-muted); background: transparent; border: 1px dashed var(--color-border); border-radius: var(--radius-md); padding: 4px 12px; cursor: pointer; text-align: center; }
.edge-more:hover { color: var(--color-accent); border-color: var(--color-rule-2); }
.edge-more[hidden] { display: none; }
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
.reactions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 4px 0 2px; }
.reaction-chip { font: inherit; font-size: 12px; line-height: 1; padding: 3px 7px; border: 1px solid var(--color-border); border-radius: var(--radius-pill); background: var(--color-surface); color: var(--color-ink-2); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.reaction-chip:hover { border-color: var(--color-rule-2); }
.reaction-chip.mine { border-color: var(--color-accent-bright); background: color-mix(in srgb, var(--color-accent-bright) 12%, var(--color-surface)); }
.reaction-chip .reaction-count { font-family: var(--font-mono); font-size: 11px; }
.reaction-add { font: inherit; font-size: 12px; line-height: 1; width: 24px; height: 22px; padding: 0; border: 1px dashed var(--color-border); border-radius: var(--radius-pill); background: transparent; color: var(--color-muted); cursor: pointer; }
.reaction-add:hover { color: var(--color-accent); border-color: var(--color-rule-2); }
.reaction-palette { display: none; gap: 2px; padding: 3px; border: 1px solid var(--color-border); border-radius: var(--radius-pill); background: var(--color-surface); box-shadow: var(--shadow-whisper); }
.reaction-palette.open { display: inline-flex; }
.reaction-palette button { font: inherit; font-size: 15px; line-height: 1; padding: 3px 5px; border: none; border-radius: var(--radius-pill); background: transparent; cursor: pointer; }
.reaction-palette button:hover { background: var(--color-paper-2); }
/* Collapsed cards and stubs keep the chips (they're signal) but drop the picker. */
.thread-card.collapsed .reaction-add, .thread-card.collapsed .reaction-palette, .thread-card.stub .reactions { display: none; }
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
/* Resolved threads (Resolved/All filters) read as history: muted, with a grey quote bar. */
.thread-card.resolved { background: var(--color-bg); }
.thread-card.resolved .thread-quote { border-left-color: var(--color-rule-2); }
.thread-card.resolved .thread-body, .thread-card.resolved .reply-body { color: var(--color-muted); }
.thread-resolved-meta { font-size: 11px; color: var(--color-muted); margin-bottom: 4px; }
.thread-card.stub .thread-resolved-meta { display: none; }
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
  const noHighlightsBanner = document.getElementById('no-highlights-banner');
  const commentsTitle = document.getElementById('comments-title');
  const railLabel = document.getElementById('comments-rail-label');
  const prevButton = document.getElementById('prev-comment') as HTMLButtonElement | null;
  const nextButton = document.getElementById('next-comment') as HTMLButtonElement | null;
  if (!dataEl?.textContent || !iframe || !sidebar) return;

  const data: ViewerData = JSON.parse(dataEl.textContent);

  injectStyles();

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
  async function sendJson(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ ok: boolean; status: number }> {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-csrf-token': data.csrfToken },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, status: res.status };
  }

  function postJson(path: string, body?: unknown): Promise<{ ok: boolean; status: number }> {
    return sendJson('POST', path, body);
  }

  /**
   * Reaction chips for a comment or reply, plus a "+" that opens the palette.
   * Toggling goes straight to the server; the poll response then re-renders.
   */
  function reactionsBar(commentId: string, reactions: ReactionDTO[]): HTMLElement {
    const bar = el('div', { className: 'reactions' });
    async function toggle(emoji: string, mine: boolean): Promise<void> {
      const res = await sendJson(mine ? 'DELETE' : 'PUT', `/api/comments/${commentId}/reactions/${encodeURIComponent(emoji)}`);
      if (res.ok) await fetchComments();
    }
    for (const reaction of reactions) {
      const chip = el(
        'button',
        {
          className: `reaction-chip${reaction.reactedByMe ? ' mine' : ''}`,
          attrs: { type: 'button', title: reaction.users.join(', ') },
          onClick: (e) => {
            e.stopPropagation();
            void toggle(reaction.emoji, reaction.reactedByMe);
          },
        },
        [reaction.emoji, el('span', { className: 'reaction-count', text: String(reaction.count) })],
      );
      bar.appendChild(chip);
    }
    const palette = el('div', { className: 'reaction-palette' });
    for (const emoji of REACTION_EMOJIS) {
      const mine = reactions.some((r) => r.emoji === emoji && r.reactedByMe);
      palette.appendChild(
        el('button', {
          text: emoji,
          attrs: { type: 'button', title: mine ? 'Remove reaction' : 'React' },
          onClick: (e) => {
            e.stopPropagation();
            palette.classList.remove('open');
            void toggle(emoji, mine);
          },
        }),
      );
    }
    bar.appendChild(
      el('button', {
        className: 'reaction-add',
        text: '+',
        attrs: { type: 'button', title: 'Add reaction', 'aria-label': 'Add reaction' },
        onClick: (e) => {
          e.stopPropagation();
          palette.classList.toggle('open');
        },
      }),
    );
    bar.appendChild(palette);
    return bar;
  }

  // --- Open / Resolved / All filter ---------------------------------------
  // A device preference (like the collapsed sidebar), not per document.
  type CommentFilter = 'open' | 'resolved' | 'all';
  const COMMENT_FILTER_KEY = 'artifact-colab:comments-filter';
  let commentFilter: CommentFilter = 'open';
  try {
    const stored = localStorage.getItem(COMMENT_FILTER_KEY);
    if (stored === 'resolved' || stored === 'all') commentFilter = stored;
  } catch {
    // Ignore: default to open.
  }
  const filterButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.comment-filter button[data-filter]'));
  function inFilter(thread: ThreadDTO): boolean {
    if (commentFilter === 'all') return true;
    return commentFilter === 'resolved' ? thread.status === 'resolved' : thread.status !== 'resolved';
  }
  function setCommentFilter(next: CommentFilter): void {
    if (next === commentFilter) return;
    commentFilter = next;
    try {
      localStorage.setItem(COMMENT_FILTER_KEY, next);
    } catch {
      // Ignore.
    }
    if (focusedCommentId && !threads.some((t) => t.id === focusedCommentId && inFilter(t))) clearFocus();
    sendAnchorsToFrame();
    renderThreads();
  }
  for (const button of filterButtons) {
    button.addEventListener('click', () => {
      const value = button.dataset['filter'];
      if (value === 'open' || value === 'resolved' || value === 'all') setCommentFilter(value);
    });
  }
  function renderFilterButtons(): void {
    const openCount = threads.filter((t) => t.status !== 'resolved').length;
    const resolvedCount = threads.length - openCount;
    for (const button of filterButtons) {
      const value = button.dataset['filter'];
      button.setAttribute('aria-selected', value === commentFilter ? 'true' : 'false');
      const count = value === 'open' ? openCount : value === 'resolved' ? resolvedCount : threads.length;
      let badge = button.querySelector('.count');
      if (!badge) {
        badge = el('span', { className: 'count' });
        button.appendChild(badge);
      }
      badge.textContent = count > 0 ? String(count) : '';
    }
  }

  function sendAnchorsToFrame(): void {
    const anchors: AnnotatorAnchorInput[] = threads.map((t) => ({ id: t.id, anchor: t.anchor, status: t.status }));
    bridge.sendAnchors(anchors, commentFilter !== 'open');
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
    // Expanding/collapsing changes card heights, so the aligned cards reflow.
    alignCards();
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
    const resolvedMeta =
      thread.status === 'resolved'
        ? el('div', {
            className: 'thread-resolved-meta',
            text: `Resolved${thread.resolvedBy ? ` by ${thread.resolvedBy}` : ''}${thread.resolvedAt ? ` · ${formatTime(thread.resolvedAt)}` : ''}`,
          })
        : null;

    const body = el('div', { className: 'thread-body', text: thread.body });
    const reactions = reactionsBar(thread.id, thread.reactions);

    const repliesEl = el('div', { className: 'replies' });
    for (const reply of thread.replies) {
      repliesEl.appendChild(
        el('div', { className: 'reply' }, [
          authorMeta(reply.author, reply.createdAt),
          el('div', { className: 'reply-body', text: reply.body }),
          reactionsBar(reply.id, reply.reactions),
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

    const replyCount = thread.replies.length;
    const collapsedInfo = el('div', {
      className: 'thread-collapsed-info',
      text: replyCount === 0 ? '' : `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`,
    });

    const card = el(
      'div',
      {
        className: `thread-card${focusedCommentId === thread.id ? ' focused' : ''}${thread.status === 'resolved' ? ' resolved' : ''}`,
        attrs: { 'data-comment-id': thread.id },
        onClick: () => {
          // An off-screen anchor (edge stub, or the focused card clamped at an
          // edge): expanding in place would leave the card pinned there, so
          // bring the passage into view as well.
          if (card.dataset['offscreen'] === 'true') bridge.scrollToComment(thread.id);
          focusThread(thread.id);
        },
      },
      [badges, quote, meta, ...(resolvedMeta ? [resolvedMeta] : []), body, reactions, collapsedInfo, repliesEl, replyForm, actions],
    );
    return card;
  }

  /** Open cards that follow their anchors, for the position pass. */
  const alignedCards = new Map<string, HTMLElement>();
  /** Latest viewport-relative anchor tops (frame CSS px) and text offsets from the annotator. */
  const framePositions = new Map<string, AnchorPosition>();
  const alignedZone = el('div', { className: 'aligned-zone' });
  /** How many off-screen stubs an edge pile shows before folding the rest into a count. */
  const MAX_EDGE_STUBS = 3;
  function edgeMoreButton(): HTMLButtonElement {
    const button = el('button', { className: 'edge-more', attrs: { type: 'button' } });
    button.hidden = true;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = button.dataset['targetId'];
      if (!id) return;
      bridge.scrollToComment(id);
      focusThread(id);
    });
    return button;
  }
  const aboveMore = edgeMoreButton();
  const belowMore = edgeMoreButton();
  /** Open cards whose anchor currently has no on-page position (e.g. inside a closed <details>); listed in normal flow. */
  const unplacedZone = el('div', { className: 'unplaced-zone' });
  // Card heights change on their own (reply textarea dragged, error text,
  // avatars loading, collapse toggles); reflow whenever one does.
  const cardResizeObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => alignCards());

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

    renderFilterButtons();
    const shown = threads.filter(inFilter);
    const open = shown.filter((t) => effectiveState(t) !== 'orphaned');
    const orphaned = shown.filter((t) => effectiveState(t) === 'orphaned');

    const sectionTitle = commentFilter === 'open' ? 'Open' : commentFilter === 'resolved' ? 'Resolved' : 'All comments';
    threadsEl.appendChild(el('div', { className: 'section-header', text: sectionTitle }));
    if (open.length === 0) {
      const empty =
        commentFilter === 'open' ? 'No open comments.' : commentFilter === 'resolved' ? 'No resolved comments.' : 'No comments yet.';
      threadsEl.appendChild(el('div', { className: 'section-empty', text: empty }));
    }
    cardResizeObserver?.disconnect();
    unplacedZone.textContent = '';
    for (const thread of open) {
      const card = buildThreadCard(thread);
      card.classList.add('aligned');
      alignedCards.set(thread.id, card);
      alignedZone.appendChild(card);
      cardResizeObserver?.observe(card);
    }
    alignedZone.appendChild(aboveMore);
    alignedZone.appendChild(belowMore);
    threadsEl.appendChild(alignedZone);
    threadsEl.appendChild(unplacedZone);

    if (orphaned.length > 0) {
      threadsEl.appendChild(el('div', { className: 'section-header', text: 'Orphaned' }));
      for (const thread of orphaned) threadsEl.appendChild(buildThreadCard(thread));
    }

    // The header/rail count is always the open work, whatever the filter shows.
    const openCount = threads.filter((t) => t.status !== 'resolved').length;
    const title = openCount > 0 ? `Comments (${openCount})` : 'Comments';
    if (commentsTitle) commentsTitle.textContent = title;
    if (railLabel) railLabel.textContent = title;
    if (prevButton) prevButton.disabled = shown.length === 0;
    if (nextButton) nextButton.disabled = shown.length === 0;

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

  /** Shown comment ids in document order (live anchor position, then list order). */
  function navigableIds(): string[] {
    return threads
      .filter(inFilter)
      .map((t, i) => {
        const pos = framePositions.get(t.id);
        return { id: t.id, top: pos?.top ?? Number.MAX_SAFE_INTEGER, start: pos?.start ?? i };
      })
      .sort((a, b) => a.top - b.top || a.start - b.start)
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

  const CARD_GAP = 10;
  const STUB_GAP = 4;
  /** Anchors this close to the frame's bottom edge count as out of view (their card would not fit anyway). */
  const BOTTOM_EDGE_SLACK = 24;
  /** How much the focused card outweighs its neighbours when a cluster picks where to sit. */
  const FOCUS_WEIGHT = 1000;

  interface AlignEntry {
    id: string;
    card: HTMLElement;
    /** Anchor y in the aligned zone's coordinate space. */
    target: number;
    start: number;
    height: number;
    weight: number;
  }

  /**
   * Google-Docs-style alignment. Each open card aims at its anchor's current
   * on-screen y inside the frame:
   *
   * - Cards whose anchor is scrolled out of view shrink to one-line stubs
   *   stacked at the top/bottom edge, so the zone never grows past the
   *   sidebar's height and off-screen comments stay one click away.
   * - Visible cards that would overlap are merged into clusters; a cluster
   *   sits where its members' combined misalignment is smallest (instead of
   *   every collision pushing the rest of the column further down). The
   *   focused card dominates its cluster, so it stays put at its anchor and
   *   neighbours make way above and below.
   * - Cards with no known position (anchor without a layout box, or before
   *   the annotator's first report) drop into a normal-flow list below.
   */
  function alignCards(): void {
    if (!iframe || !sidebar) return;
    if (alignedCards.size === 0) {
      alignedZone.style.height = '0px';
      return;
    }
    const frameRect = iframe.getBoundingClientRect();
    const zoneRect = alignedZone.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    // zoneRect.top shifts with the sidebar's own scroll; add scrollTop back so
    // targets are in the zone's content space. Otherwise every sidebar scroll
    // re-pins the cards to the viewport and the scroll range grows forever.
    const zoneTop = zoneRect.top + sidebar.scrollTop;
    // Room from the zone's top to the sidebar's bottom edge when the sidebar
    // is unscrolled: the band cards are laid out in.
    const viewportHeight = Math.max(240, sidebarRect.bottom - zoneRect.top - sidebar.scrollTop);

    // Cards with no position drop out of the zone into a normal-flow list.
    const positioned: { id: string; card: HTMLElement; pos: AnchorPosition }[] = [];
    for (const [id, card] of alignedCards) {
      const pos = framePositions.get(id);
      if (pos === undefined) {
        if (card.parentElement !== unplacedZone) unplacedZone.appendChild(card);
        card.classList.remove('aligned', 'stub', 'collapsed');
        card.style.top = '';
        delete card.dataset['offscreen'];
        continue;
      }
      if (card.parentElement !== alignedZone) alignedZone.appendChild(card);
      card.classList.add('aligned');
      positioned.push({ id, card, pos });
    }

    // The focused card must land on its anchor. When the cards packed around
    // it are too tall for that, its nearest neighbours on the crowded side are
    // demoted to edge stubs one at a time until it fits (Docs-style "make way").
    const demoted = new Set<string>();
    for (let attempt = 0; attempt < positioned.length; attempt++) {
      const misfit = layoutPass(positioned, demoted, frameRect.top - zoneTop, frameRect.height, viewportHeight);
      if (misfit === null) break;
      demoted.add(misfit);
    }
  }

  /**
   * One layout pass. Returns the id of a neighbour that should be demoted to
   * a stub so the focused card can reach its anchor, or null when the layout
   * is final.
   */
  function layoutPass(
    positioned: { id: string; card: HTMLElement; pos: AnchorPosition }[],
    demoted: Set<string>,
    frameOffset: number,
    frameHeight: number,
    viewportHeight: number,
  ): string | null {
    // An anchor is off-screen when it is outside the frame's visible extent
    // (which can be shorter than the band in a small window) or past the band.
    const aboveLimit = Math.min(0, frameOffset);
    const belowLimit = Math.min(viewportHeight, frameOffset + frameHeight) - BOTTOM_EDGE_SLACK;
    // 1. Classify: stub above / stub below / visible.
    const placed: AlignEntry[] = [];
    const above: AlignEntry[] = [];
    const below: AlignEntry[] = [];
    let pivot: AlignEntry | null = null;
    const focusedPos = focusedCommentId ? framePositions.get(focusedCommentId) : undefined;
    const pivotTarget = focusedPos ? frameOffset + focusedPos.top * currentScale : null;
    for (const { id, card, pos } of positioned) {
      const focused = id === focusedCommentId;
      const target = frameOffset + pos.top * currentScale;
      const entry: AlignEntry = { id, card, target, start: pos.start, height: 0, weight: focused ? FOCUS_WEIGHT : 1 };
      let offscreen = target < aboveLimit ? above : target > belowLimit ? below : null;
      if (offscreen === null && demoted.has(id) && pivotTarget !== null) {
        offscreen = target < pivotTarget || (target === pivotTarget && pos.start < (focusedPos?.start ?? 0)) ? above : below;
      }
      // The focused card is never reduced to a stub: it clamps to the edge instead.
      const stub = offscreen !== null && !focused;
      card.dataset['offscreen'] = String(offscreen !== null && !demoted.has(id));
      card.classList.toggle('stub', stub);
      card.classList.toggle('collapsed', !focused);
      (stub ? offscreen! : placed).push(entry);
      if (focused) pivot = entry;
    }
    const byPosition = (a: AlignEntry, b: AlignEntry): number => a.target - b.target || a.start - b.start;
    placed.sort(byPosition);
    above.sort(byPosition);
    below.sort(byPosition);

    // Only the few stubs nearest the viewport stay visible; the rest fold
    // into a "N more" button that jumps to the nearest folded comment.
    const foldedAbove = above.splice(0, Math.max(0, above.length - MAX_EDGE_STUBS));
    const foldedBelow = below.splice(MAX_EDGE_STUBS);
    for (const entry of [...above, ...below, ...placed]) entry.card.classList.remove('edge-hidden');
    for (const entry of [...foldedAbove, ...foldedBelow]) entry.card.classList.add('edge-hidden');
    const setFold = (button: HTMLButtonElement, folded: AlignEntry[], nearest: AlignEntry | undefined, where: string): void => {
      button.hidden = folded.length === 0;
      if (nearest === undefined) return;
      button.textContent = `${folded.length} more ${where}`;
      button.dataset['targetId'] = nearest.id;
    };
    setFold(aboveMore, foldedAbove, foldedAbove[foldedAbove.length - 1], 'above');
    setFold(belowMore, foldedBelow, foldedBelow[0], 'below');

    // 2. Measure after the class changes above (they alter heights). Reads
    //    happen before any writes so the browser lays out once.
    for (const entry of [...placed, ...above, ...below]) entry.height = entry.card.offsetHeight;
    const aboveMoreHeight = aboveMore.hidden ? 0 : aboveMore.offsetHeight + STUB_GAP;
    const belowMoreHeight = belowMore.hidden ? 0 : belowMore.offsetHeight + STUB_GAP;

    // 3. Edge piles. Stubs for anchors above the viewport stack down from the
    //    top; those below stack up from the bottom (laid out after the visible
    //    cards, which take priority for the space in between).
    let cursor = 0;
    if (!aboveMore.hidden) {
      aboveMore.style.top = '0px';
      cursor = aboveMoreHeight;
    }
    for (const entry of above) {
      entry.card.style.top = `${cursor}px`;
      cursor += entry.height + STUB_GAP;
    }
    const bandTop = cursor > 0 ? cursor - STUB_GAP + CARD_GAP : 0;
    const belowHeight = below.reduce((sum, entry) => sum + entry.height + STUB_GAP, 0) + belowMoreHeight - STUB_GAP;
    const hasBelow = below.length > 0 || !belowMore.hidden;
    const bandBottom = hasBelow ? viewportHeight - belowHeight - CARD_GAP : viewportHeight;

    // 4. Visible cards: greedy clustering. Each card starts as its own
    //    cluster at its (band-clamped) target; whenever it would overlap the
    //    cluster before it, the two merge and the merged cluster moves to the
    //    weighted mean of its members' ideal tops.
    interface Cluster {
      items: AlignEntry[];
      top: number;
      height: number;
    }
    const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));
    const place = (items: AlignEntry[]): Cluster => {
      // A cluster holding the focused card may run past the band's bottom
      // (the zone grows and the sidebar scrolls) rather than being pushed up
      // off its anchor; every other cluster stays inside the band.
      const maxBottom = items.includes(pivot!) ? Number.POSITIVE_INFINITY : bandBottom;
      let height = 0;
      let weightSum = 0;
      let idealSum = 0;
      for (const item of items) {
        // Where this cluster's top would have to be for `item` to sit exactly on its anchor.
        const ideal = clamp(item.target, bandTop, maxBottom - item.height) - height;
        idealSum += item.weight * ideal;
        weightSum += item.weight;
        height += item.height + CARD_GAP;
      }
      height -= CARD_GAP;
      return { items, height, top: clamp(idealSum / weightSum, bandTop, maxBottom - height) };
    };
    const clusters: Cluster[] = [];
    for (const entry of placed) {
      let cluster = place([entry]);
      while (clusters.length > 0) {
        const previous = clusters[clusters.length - 1]!;
        if (previous.top + previous.height + CARD_GAP <= cluster.top) break;
        clusters.pop();
        cluster = place([...previous.items, ...cluster.items]);
      }
      clusters.push(cluster);
    }
    let visibleBottom = bandTop;
    let misfit: string | null = null;
    for (const cluster of clusters) {
      let top = cluster.top;
      for (const item of cluster.items) {
        item.card.style.top = `${top}px`;
        // The focused card sits too low only when the cards above it in its
        // cluster don't fit between the top pile and its anchor: the topmost
        // one gives way (becomes a stub) and the pass is repeated.
        if (item === pivot && top > Math.max(item.target, bandTop) + 1 && cluster.items.indexOf(item) > 0) {
          misfit = cluster.items[0]!.id;
        }
        top += item.height + CARD_GAP;
      }
      visibleBottom = Math.max(visibleBottom, top - CARD_GAP);
    }

    // When the visible cards need more than the band, the bottom pile yields
    // and the zone grows (the sidebar scrolls) rather than overlapping them.
    cursor = hasBelow ? Math.max(viewportHeight - belowHeight, visibleBottom + CARD_GAP) : visibleBottom;
    for (const entry of below) {
      entry.card.style.top = `${cursor}px`;
      cursor += entry.height + STUB_GAP;
    }
    if (!belowMore.hidden) {
      belowMore.style.top = `${cursor}px`;
      cursor += belowMoreHeight;
    }
    const bottom = Math.max(viewportHeight, visibleBottom, hasBelow ? cursor - STUB_GAP : 0);
    alignedZone.style.height = `${bottom}px`;
    return misfit;
  }

  /** Suppresses the card `top` transition while the artifact is being scrolled. */
  let scrollingTimer: number | undefined;
  function markScrolling(): void {
    alignedZone.classList.add('scrolling');
    if (scrollingTimer !== undefined) window.clearTimeout(scrollingTimer);
    scrollingTimer = window.setTimeout(() => {
      scrollingTimer = undefined;
      alignedZone.classList.remove('scrolling');
    }, 200);
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
      for (const p of positions) framePositions.set(p.id, p);
      markScrolling();
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
