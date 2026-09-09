/**
 * Document viewer page: header (title, version picker, export menu), the
 * sandboxed artifact iframe, and the comment sidebar shell. All interactivity
 * lives in the client bundle (/static/viewer.js), which reads its parameters
 * from the #viewer-data JSON block and owns everything inside #sidebar.
 */

import type { FC } from 'hono/jsx';

import type { Document, User, Version } from '../db/schema.js';
import { Layout } from './layout.js';

/** A version plus who published it (null when the publisher is unknown, e.g. a deleted user). */
export type VersionSummary = Pick<Version, 'id' | 'number' | 'publishedAt'> & {
  publisherName: string | null;
  publisherEmail: string | null;
};

/** Display name for a version's publisher: profile name, else the email, else a placeholder. */
export function publisherLabel(version: VersionSummary): string {
  return version.publisherName?.trim() || version.publisherEmail || 'unknown user';
}

export interface DocumentPageProps {
  user: User;
  csrfToken: string;
  document: Document;
  versions: VersionSummary[];
  /** The version being displayed (defaults to the document's current one). */
  shownVersion: VersionSummary;
  /** Compare mode: the older version shown beside `shownVersion`, with the text changes between them painted. */
  compareVersion: VersionSummary | null;
  /** Whether the signed-in user watches this document (comment digest emails). */
  watching: boolean;
  /** Whether the signed-in user may delete this document (member and author-or-team-admin). */
  canDelete: boolean;
  /** Members get the Share menu; guests on a public document get a "Shared with you" note instead. */
  isMember: boolean;
  /** Absolute URL of the document, shown in the Share menu when public. */
  shareUrl: string;
}

const viewerCss = `
/* Full-height app frame: header + toolbar + content share one flex column,
   so no hardcoded header-height math. */
body { display: flex; flex-direction: column; height: 100dvh; }
header.site-header { flex: none; }
/* width/margin reset matters: the app-wide "main { margin: 0 auto }" would
   shrink-wrap a flex-column item to its content width. */
main { flex: 1 1 auto; min-height: 0; max-width: none; width: 100%; margin: 0; padding: 0; }
.viewer { display: flex; height: 100%; }
.viewer-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.viewer-toolbar { display: flex; align-items: center; gap: 16px; padding: 10px 20px; border-bottom: 1px solid var(--color-border); background: var(--color-surface); }
.viewer-toolbar h1 { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.viewer-toolbar .toolbar-spacer { flex: 1; }
.viewer-toolbar .stale-note { font-size: 12px; color: #b45309; background: #fef3c7; border-radius: 4px; padding: 2px 8px; }
.viewer-toolbar label { font-size: 13px; color: var(--color-muted); display: flex; align-items: center; gap: 6px; }
.viewer-toolbar select { font: inherit; font-size: 13px; padding: 3px 6px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface); cursor: pointer; }
.viewer-toolbar .settings-menu summary { font-size: 13px; color: var(--color-muted); padding: 4px 8px; border-radius: 6px; transition: background 150ms ease-out, color 150ms ease-out; }
.viewer-toolbar .settings-menu summary:hover { background: var(--color-bg); color: var(--color-accent); text-decoration: none; }
.viewer-toolbar .watch-form { display: contents; }
.viewer-toolbar .watch-btn { font: inherit; font-size: 13px; color: var(--color-muted); padding: 4px 8px; border: none; border-radius: 6px; background: transparent; cursor: pointer; transition: background 150ms ease-out, color 150ms ease-out; }
.viewer-toolbar .watch-btn:hover { background: var(--color-bg); color: var(--color-accent); }
.viewer-toolbar .watch-btn.watching { color: var(--color-accent); }
.viewer-toolbar .shared-note { font-size: 12px; color: var(--color-muted); background: var(--color-bg); border-radius: 4px; padding: 2px 8px; }
.version-menu summary { font-family: var(--font-mono); font-weight: 600; }
.version-panel { min-width: 260px; padding: 6px; }
.version-option { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; color: var(--color-text); }
.version-option:hover { background: var(--color-paper-2); }
.version-option[aria-selected='true'] { background: var(--color-accent-wash); }
/* Both anchors override the generic full-width menu-link rule: the row itself is the hover surface. */
.version-panel .version-option .version-link { flex: 1; min-width: 0; padding: 0; text-decoration: none; color: inherit; background: transparent; }
/* Icon button entering compare mode against the shown version; the shown row itself has nothing to compare with. */
.version-panel .version-option .version-compare { flex: none; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid transparent; border-radius: 6px; color: var(--color-muted); background: transparent; transition: color 150ms ease-out, background 150ms ease-out, border-color 150ms ease-out; }
.version-panel .version-option .version-compare:hover { color: var(--color-accent); background: var(--color-surface); border-color: var(--color-border); }
.version-option .version-number { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 13px; font-weight: 600; }
.version-option .version-current { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-accent); }
.version-option .version-details { display: block; font-size: 12px; color: var(--color-muted); margin-top: 2px; white-space: nowrap; }
.share-panel { width: 300px; padding: 12px 14px; }
.share-panel h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; padding: 0 2px; }
.share-option { display: grid; grid-template-columns: 16px 1fr; gap: 10px; align-items: start; width: 100%; text-align: left; padding: 8px 10px; margin-bottom: 4px; border: 1px solid transparent; border-radius: 8px; background: transparent; font: inherit; color: var(--color-text); cursor: pointer; }
.share-option:hover { background: var(--color-paper-2); transform: none; }
.share-option[aria-checked='true'] { background: var(--color-accent-wash); border-color: oklch(85% 0.06 55); }
.share-option .radio { width: 16px; height: 16px; margin-top: 1px; border-radius: 50%; border: 1.5px solid var(--color-rule-2); background: var(--color-surface); position: relative; }
.share-option[aria-checked='true'] .radio { border-color: var(--color-accent); }
.share-option[aria-checked='true'] .radio::after { content: ''; position: absolute; inset: 3px; border-radius: 50%; background: var(--color-accent); }
.share-option .name { display: block; font-size: 13px; font-weight: 500; line-height: 1.3; }
.share-option .hint { display: block; font-size: 12px; font-weight: 400; color: var(--color-muted); line-height: 1.4; margin-top: 1px; }
.share-link-row { display: flex; gap: 6px; border-top: 1px solid var(--color-border); padding-top: 10px; margin-top: 8px; }
.share-link-row .share-url { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 11px; color: var(--color-muted); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 6px; padding: 5px 8px; }
.share-copy { font: inherit; font-size: 12px; font-weight: 500; padding: 5px 12px; white-space: nowrap; }
.share-link-note { font-size: 11.5px; color: var(--color-muted); margin: 8px 2px 0; }
.frame-wrap { flex: 1; min-height: 0; overflow: hidden; background: #fff; }
#artifact-frame { width: 100%; height: 100%; border: 0; background: #fff; display: block; }
/* Compare mode: the older version on the left, the shown one on the right. */
.frame-wrap.comparing { display: grid; grid-template-columns: 1fr 1fr; }
.compare-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.compare-pane + .compare-pane { border-left: 1px solid var(--color-border); }
.compare-pane-label { flex: none; display: flex; align-items: center; gap: 8px; padding: 5px 12px; font-size: 12px; color: var(--color-muted); background: var(--color-bg); border-bottom: 1px solid var(--color-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.compare-pane-label .pane-version { font-family: var(--font-mono); font-weight: 600; color: var(--color-ink); }
.compare-pane-label .pane-kind { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 3px; }
.compare-pane-label .pane-kind.old { background: #fee2e2; color: #b91c1c; }
.compare-pane-label .pane-kind.new { background: #dcfce7; color: #15803d; }
.compare-pane-frame { flex: 1; min-height: 0; overflow: hidden; background: #fff; }
.compare-pane-frame iframe { width: 100%; height: 100%; border: 0; background: #fff; display: block; }
.compare-menu summary.comparing { color: var(--color-accent); }
.compare-panel { min-width: 220px; }
.compare-panel .compare-hint { font-size: 11.5px; color: var(--color-muted); padding: 6px 10px 4px; }
@media (max-width: 900px) { .frame-wrap.comparing { grid-template-columns: 1fr; } .compare-pane.old { display: none; } }
.sidebar { width: 360px; flex: none; border-left: 1px solid var(--color-border); background: var(--color-surface); display: flex; flex-direction: column; }
.sidebar-header { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 8px 12px 8px 16px; font-size: 12px; font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; color: var(--color-muted); border-bottom: 1px solid var(--color-border); }
.comment-nav { display: flex; gap: 4px; }
.comment-nav button { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; background: transparent; border: 1px solid transparent; border-radius: 6px; color: var(--color-muted); cursor: pointer; transition: background 150ms ease-out, color 150ms ease-out; }
.comment-nav button:hover:not(:disabled) { background: var(--color-bg); color: var(--color-accent); }
.comment-nav button:disabled { opacity: 0.35; cursor: default; }
.sidebar-inner { overflow-y: auto; flex: 1; padding: 12px 16px; }
.comment-filter { flex: none; display: flex; gap: 2px; margin: 10px 16px 0; padding: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-pill); background: var(--color-bg); }
.comment-filter button { flex: 1; font: inherit; font-size: 12px; font-weight: 500; padding: 4px 8px; border: none; border-radius: var(--radius-pill); background: transparent; color: var(--color-muted); cursor: pointer; transition: background 150ms ease-out, color 150ms ease-out; }
.comment-filter button:hover { color: var(--color-accent); }
.comment-filter button[aria-selected='true'] { background: var(--color-surface); color: var(--color-ink); box-shadow: var(--shadow-whisper); }
.comment-filter .count { font-family: var(--font-mono); font-size: 10px; margin-left: 4px; color: var(--color-muted); }
.sidebar.collapsed .comment-filter { display: none; }
#no-highlights-banner { padding: 8px 12px; background: #fef3c7; font-size: 12px; border-bottom: 1px solid #fde68a; }
.sidebar.collapsed { width: 40px; }
.sidebar.collapsed .sidebar-header, .sidebar.collapsed #no-highlights-banner, .sidebar.collapsed .sidebar-inner { display: none; }
.sidebar-expand { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px 0; width: 100%; background: transparent; border: none; cursor: pointer; color: var(--color-muted); transition: background 150ms ease-out, color 150ms ease-out; }
.sidebar-expand:hover { background: var(--color-bg); color: var(--color-accent); }
.sidebar-expand .rail-label { writing-mode: vertical-rl; font-size: 12px; font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; }
[hidden] { display: none !important; }
@media (max-width: 900px) { .sidebar { width: 300px; } }
`;

/**
 * One entry per visibility: `summary` labels the collapsed Share menu, `note`
 * captions the link box. Both ride along as data attributes so the client can
 * apply a change in place without duplicating the strings.
 */
const shareOptions = [
  {
    value: 'private',
    name: 'Only you',
    hint: 'Hidden from the rest of the team. Existing comments stay in the document.',
    summary: 'Private',
    note: 'Right now this link only opens for you.',
  },
  {
    value: 'team',
    name: 'Team only',
    hint: 'Only members of your team can view and comment.',
    summary: 'Share',
    note: 'Right now this link only opens for your team.',
  },
  {
    value: 'public',
    name: 'Anyone with the link',
    hint: 'Anyone signed in with the link can view and comment.',
    summary: 'Public',
    note: 'Anyone signed in can open this link.',
  },
] as const;

/**
 * URL of the viewer for `shown` (the current version needs no query), optionally
 * comparing it with `compare`. The older of the two is always the base, so the
 * "before" pane never shows the newer version.
 */
export function viewerUrl(document: Document, shown: VersionSummary, compare?: VersionSummary | null): string {
  const params = new URLSearchParams();
  const [before, after] = compare && compare.number > shown.number ? [shown, compare] : [compare, shown];
  if (after.id !== document.currentVersionId || before) params.set('version', String(after.number));
  if (before) params.set('compare', String(before.number));
  const query = params.toString();
  return `/d/${document.id}${query ? `?${query}` : ''}`;
}

export const DocumentPage: FC<DocumentPageProps> = ({
  user,
  csrfToken,
  document,
  versions,
  shownVersion,
  compareVersion,
  watching,
  canDelete,
  isMember,
  shareUrl,
}) => {
  const backToUrl = viewerUrl(document, shownVersion, compareVersion);
  const isCurrent = shownVersion.id === document.currentVersionId;
  const previousVersion = [...versions].reverse().find((v) => v.number < shownVersion.number) ?? null;
  // Only the creator can make a document private (the server enforces it too).
  const visibleShareOptions = shareOptions.filter((o) => o.value !== 'private' || document.createdBy === user.id);
  const currentShare = shareOptions.find((o) => o.value === document.visibility) ?? shareOptions[1];
  // Rendered via dangerouslySetInnerHTML: JSX would entity-escape the JSON,
  // and entities are never decoded inside a <script> element. Escaping "<"
  // keeps a "</script>" inside any value from breaking out of the block.
  const viewerData = JSON.stringify({
    slug: document.id,
    title: document.title,
    versionId: shownVersion.id,
    versionNumber: shownVersion.number,
    isCurrentVersion: isCurrent,
    csrfToken,
    compare: compareVersion ? { versionNumber: compareVersion.number } : null,
  }).replaceAll('<', '\\u003c');
  return (
    <Layout title={document.title} user={user} csrfToken={csrfToken}>
      {/* Raw injection, not a text child: JSX escaping would turn the quotes in
          [aria-checked='true'] and content: '' into &#39;, which browsers never
          decode inside <style>, silently dropping those rules. */}
      <style dangerouslySetInnerHTML={{ __html: viewerCss }}></style>
      <script id="viewer-data" type="application/json" dangerouslySetInnerHTML={{ __html: viewerData }}></script>
      <div class="viewer">
        <div class="viewer-main">
          <div class="viewer-toolbar">
            <h1>{document.title}</h1>
            {compareVersion ? (
              <span class="stale-note">
                comparing v{compareVersion.number} → v{shownVersion.number} — commenting disabled
              </span>
            ) : (
              !isCurrent && <span class="stale-note">viewing an old version — commenting disabled</span>
            )}
            <div class="toolbar-spacer"></div>
            {/* A menu rather than a <select>: the closed state shows only the
                version number while each row carries the full timestamp and
                publisher (a native select shows the same text in both places). */}
            <details class="settings-menu version-menu">
              <summary id="version-picker" aria-label={`Version ${shownVersion.number}`}>
                v{shownVersion.number}
              </summary>
              <div class="settings-menu-items version-panel" role="listbox" aria-label="Versions">
                {[...versions].reverse().map((v) => (
                  <div class="version-option" role="option" aria-selected={v.id === shownVersion.id ? 'true' : 'false'} data-version={String(v.number)}>
                    <a class="version-link" href={viewerUrl(document, v)}>
                      <span class="version-number">
                        v{v.number}
                        {v.id === document.currentVersionId && <span class="version-current">current</span>}
                      </span>
                      <span class="version-details">
                        <time datetime={v.publishedAt.toISOString()}>{v.publishedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</time>
                        {' · '}
                        {publisherLabel(v)}
                      </span>
                    </a>
                    {v.id !== shownVersion.id && (
                      <a
                        class="version-compare"
                        href={viewerUrl(document, shownVersion, v)}
                        title={`Show what changed between v${Math.min(v.number, shownVersion.number)} and v${Math.max(v.number, shownVersion.number)}`}
                        aria-label={`Compare v${shownVersion.number} with v${v.number}`}
                      >
                        {/* A split view: the two panes the comparison opens. */}
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" stroke-width="1.6" />
                          <path d="M8 2.75v10.5" stroke="currentColor" stroke-width="1.6" />
                        </svg>
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </details>
            {/* Only while comparing (entered from a row's Compare button in the versions menu): switch the base or leave. */}
            {compareVersion && (
              <details class="settings-menu compare-menu">
                <summary id="compare-picker" class="comparing">
                  Comparing with v{compareVersion.number}
                </summary>
                <div class="settings-menu-items compare-panel">
                  <div class="compare-hint">Show what changed in v{shownVersion.number} since…</div>
                  {[...versions]
                    .reverse()
                    .filter((v) => v.id !== shownVersion.id)
                    .map((v) => (
                      <a href={viewerUrl(document, shownVersion, v)} data-compare={String(v.number)} aria-current={compareVersion.id === v.id ? 'true' : undefined}>
                        v{v.number}
                        {previousVersion?.id === v.id ? ' (previous)' : ''} · {publisherLabel(v)}
                      </a>
                    ))}
                  <a href={viewerUrl(document, shownVersion)}>Stop comparing</a>
                </div>
              </details>
            )}
            {isMember ? (
              <details class="settings-menu share-menu">
                <summary>{currentShare.summary}</summary>
                <div class="settings-menu-items share-panel" role="radiogroup" aria-label="Who can open this artifact">
                  <h2>Who can open this artifact</h2>
                  {visibleShareOptions.map((option) => (
                    <form method="post" action={`/d/${document.id}/share`}>
                      <input type="hidden" name="_csrf" value={csrfToken} />
                      <input type="hidden" name="visibility" value={option.value} />
                      <input type="hidden" name="next" value={backToUrl} />
                      <button
                        type="submit"
                        class="share-option"
                        role="radio"
                        aria-checked={document.visibility === option.value ? 'true' : 'false'}
                        data-summary={option.summary}
                        data-note={option.note}
                      >
                        <span class="radio"></span>
                        <span>
                          <span class="name">{option.name}</span>
                          <span class="hint">{option.hint}</span>
                        </span>
                      </button>
                    </form>
                  ))}
                  <div class="share-link-row">
                    <input class="share-url" type="text" readonly value={shareUrl} onfocus="this.select()" />
                    <button type="button" id="copy-share-link" class="share-copy">
                      Copy link
                    </button>
                  </div>
                  <p class="share-link-note">{currentShare.note}</p>
                </div>
              </details>
            ) : (
              <span class="shared-note" title="This artifact was shared with you by its team">
                Shared with you
              </span>
            )}
            <form method="post" action={`/d/${document.id}/watch`} class="watch-form">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <input type="hidden" name="watching" value={watching ? 'false' : 'true'} />
              <input type="hidden" name="next" value={backToUrl} />
              <button
                type="submit"
                class={`watch-btn${watching ? ' watching' : ''}`}
                title={watching ? 'You get comment digests by email — click to stop' : 'Email me new comments on this artifact'}
              >
                {watching ? 'Watching ✓' : 'Watch'}
              </button>
            </form>
            <details class="settings-menu export-menu">
              <summary>{canDelete ? 'More' : 'Export'}</summary>
              <div class="settings-menu-items">
                <a href={`/api/docs/${document.id}/export.md`} download={`${document.id}-comments.md`}>
                  Export comments as Markdown…
                </a>
                <a href={`/api/docs/${document.id}/export.json`} download={`${document.id}-comments.json`}>
                  Export comments as JSON…
                </a>
                <a href={`/api/docs/${document.id}/export.zip`} download>
                  Export artifact…
                </a>
                {canDelete && (
                  <a class="danger-link" href={`/d/${document.id}/delete`}>
                    Delete artifact…
                  </a>
                )}
              </div>
            </details>
          </div>
          {compareVersion ? (
            <div class="frame-wrap comparing" id="frame-wrap">
              <div class="compare-pane old" id="compare-pane-old">
                <div class="compare-pane-label">
                  <span class="pane-kind old">Before</span>
                  <span class="pane-version">v{compareVersion.number}</span>
                  <span>{publisherLabel(compareVersion)}</span>
                </div>
                <div class="compare-pane-frame" id="compare-pane-old-frame">
                  <iframe
                    id="compare-frame"
                    sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
                    src={`/d/${document.id}/frame?version=${compareVersion.number}`}
                    title={`${document.title} — v${compareVersion.number}`}
                  ></iframe>
                </div>
              </div>
              <div class="compare-pane new" id="compare-pane-new">
                <div class="compare-pane-label">
                  <span class="pane-kind new">After</span>
                  <span class="pane-version">v{shownVersion.number}</span>
                  <span>{publisherLabel(shownVersion)}</span>
                  {isCurrent && <span class="version-current">current</span>}
                </div>
                <div class="compare-pane-frame" id="compare-pane-new-frame">
                  <iframe
                    id="artifact-frame"
                    sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
                    src={`/d/${document.id}/frame?version=${shownVersion.number}`}
                    title={`${document.title} — v${shownVersion.number}`}
                  ></iframe>
                </div>
              </div>
            </div>
          ) : (
            <div class="frame-wrap" id="frame-wrap">
              <iframe
                id="artifact-frame"
                sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
                src={`/d/${document.id}/frame?version=${shownVersion.number}`}
                title={document.title}
              ></iframe>
            </div>
          )}
        </div>
        <aside class="sidebar" id="comments-sidebar">
          <button
            type="button"
            id="expand-sidebar"
            class="sidebar-expand"
            title={compareVersion ? 'Show changes' : 'Show comments'}
            aria-label={compareVersion ? 'Show changes' : 'Show comments'}
            hidden
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 3L5.5 8L10 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="rail-label" id="comments-rail-label">{compareVersion ? 'Changes' : 'Comments'}</span>
          </button>
          <div class="sidebar-header">
            <span id="comments-title">{compareVersion ? 'Changes' : 'Comments'}</span>
            <div class="comment-nav">
              <button type="button" id="prev-comment" aria-label={compareVersion ? 'Previous change' : 'Previous comment'} disabled>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M10 3L5.5 8L10 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <button type="button" id="next-comment" aria-label={compareVersion ? 'Next change' : 'Next comment'} disabled>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 3L10.5 8L6 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                id="collapse-sidebar"
                title={compareVersion ? 'Hide changes' : 'Hide comments'}
                aria-label={compareVersion ? 'Hide changes' : 'Hide comments'}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 3L10.5 8L6 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                  <path d="M11 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
              </button>
            </div>
          </div>
          <div class="comment-filter" role="tablist" aria-label="Which comments to show" hidden={compareVersion !== null}>
            <button type="button" role="tab" data-filter="open" aria-selected="true">
              Open
            </button>
            <button type="button" role="tab" data-filter="resolved" aria-selected="false">
              Resolved
            </button>
            <button type="button" role="tab" data-filter="all" aria-selected="false">
              All
            </button>
          </div>
          <div id="no-highlights-banner" hidden>
            This browser can't paint in-page highlights; comments still work from the sidebar.
          </div>
          <div class="sidebar-inner" id="sidebar"></div>
        </aside>
      </div>
      <script src="/static/viewer.js"></script>
    </Layout>
  );
};

/** Confirmation step for deleting an artifact, mirroring the admin team-delete page. */
export const DocumentDeletePage: FC<{
  user: User;
  csrfToken: string;
  document: Document;
  counts: { versions: number; comments: number };
}> = ({ user, csrfToken, document, counts }) => (
  <Layout title={`Delete ${document.title} - Artifact Colab`} user={user} csrfToken={csrfToken}>
    <p class="muted">
      <a href={`/d/${document.id}`}>← Back to {document.title}</a>
    </p>
    <h1>Delete {document.title}?</h1>
    <p>
      This permanently deletes the artifact, its {counts.versions} version{counts.versions === 1 ? '' : 's'} and{' '}
      {counts.comments} comment thread{counts.comments === 1 ? '' : 's'}, and any uploaded assets. There is no undo.
    </p>
    <form method="post" action={`/d/${document.id}/delete`}>
      <input type="hidden" name="_csrf" value={csrfToken} />
      <button type="submit" class="danger">
        Delete {document.title} permanently
      </button>
    </form>
  </Layout>
);
