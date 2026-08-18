/**
 * Document viewer page: header (title, version picker, export menu), the
 * sandboxed artifact iframe, and the comment sidebar shell. All interactivity
 * lives in the client bundle (/static/viewer.js), which reads its parameters
 * from the #viewer-data JSON block and owns everything inside #sidebar.
 */

import type { FC } from 'hono/jsx';

import type { Document, User, Version } from '../db/schema.js';
import { Layout } from './layout.js';

export interface DocumentPageProps {
  user: User;
  csrfToken: string;
  document: Document;
  versions: Pick<Version, 'id' | 'number' | 'publishedAt'>[];
  /** The version being displayed (defaults to the document's current one). */
  shownVersion: Pick<Version, 'id' | 'number' | 'publishedAt'>;
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
.share-panel { min-width: 260px; padding: 10px 12px; }
.share-panel p { font-size: 12px; color: var(--color-muted); margin: 0 0 8px; }
.share-panel .share-url { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-bg); color: var(--color-muted); margin-bottom: 8px; }
.share-panel button { font: inherit; font-size: 12px; padding: 4px 10px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface); cursor: pointer; }
.share-panel button:hover { color: var(--color-accent); border-color: var(--color-accent); }
.frame-wrap { flex: 1; min-height: 0; overflow: hidden; background: #fff; }
#artifact-frame { width: 100%; height: 100%; border: 0; background: #fff; display: block; }
.sidebar { width: 360px; flex: none; border-left: 1px solid var(--color-border); background: var(--color-surface); display: flex; flex-direction: column; }
.sidebar-header { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 8px 12px 8px 16px; font-size: 12px; font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; color: var(--color-muted); border-bottom: 1px solid var(--color-border); }
.comment-nav { display: flex; gap: 4px; }
.comment-nav button { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; background: transparent; border: 1px solid transparent; border-radius: 6px; color: var(--color-muted); cursor: pointer; transition: background 150ms ease-out, color 150ms ease-out; }
.comment-nav button:hover:not(:disabled) { background: var(--color-bg); color: var(--color-accent); }
.comment-nav button:disabled { opacity: 0.35; cursor: default; }
.sidebar-inner { overflow-y: auto; flex: 1; padding: 12px 16px; }
#no-highlights-banner { padding: 8px 12px; background: #fef3c7; font-size: 12px; border-bottom: 1px solid #fde68a; }
.sidebar.collapsed { width: 40px; }
.sidebar.collapsed .sidebar-header, .sidebar.collapsed #no-highlights-banner, .sidebar.collapsed .sidebar-inner { display: none; }
.sidebar-expand { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px 0; width: 100%; background: transparent; border: none; cursor: pointer; color: var(--color-muted); transition: background 150ms ease-out, color 150ms ease-out; }
.sidebar-expand:hover { background: var(--color-bg); color: var(--color-accent); }
.sidebar-expand .rail-label { writing-mode: vertical-rl; font-size: 12px; font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; }
[hidden] { display: none !important; }
@media (max-width: 900px) { .sidebar { width: 300px; } }
`;

export const DocumentPage: FC<DocumentPageProps> = ({ user, csrfToken, document, versions, shownVersion, watching, canDelete, isMember, shareUrl }) => {
  const backToUrl =
    shownVersion.id === document.currentVersionId ? `/d/${document.id}` : `/d/${document.id}?version=${shownVersion.number}`;
  // Rendered via dangerouslySetInnerHTML: JSX would entity-escape the JSON,
  // and entities are never decoded inside a <script> element. Escaping "<"
  // keeps a "</script>" inside any value from breaking out of the block.
  const viewerData = JSON.stringify({
    slug: document.id,
    title: document.title,
    versionId: shownVersion.id,
    versionNumber: shownVersion.number,
    isCurrentVersion: shownVersion.id === document.currentVersionId,
    csrfToken,
  }).replaceAll('<', '\\u003c');
  return (
    <Layout title={document.title} user={user} csrfToken={csrfToken}>
      <style>{viewerCss}</style>
      <script id="viewer-data" type="application/json" dangerouslySetInnerHTML={{ __html: viewerData }}></script>
      <div class="viewer">
        <div class="viewer-main">
          <div class="viewer-toolbar">
            <h1>{document.title}</h1>
            {shownVersion.id !== document.currentVersionId && (
              <span class="stale-note">viewing an old version — commenting disabled</span>
            )}
            <div class="toolbar-spacer"></div>
            <label>
              Version
              <select id="version-picker">
                {versions.map((v) => (
                  <option value={String(v.number)} selected={v.id === shownVersion.id}>
                    v{v.number}
                  </option>
                ))}
              </select>
            </label>
            {isMember ? (
              <details class="settings-menu share-menu">
                <summary>{document.visibility === 'public' ? 'Sharing on' : 'Share'}</summary>
                <div class="settings-menu-items share-panel">
                  {document.visibility === 'public' ? (
                    <>
                      <p>Anyone signed in with the link can view and comment.</p>
                      <input class="share-url" type="text" readonly value={shareUrl} onfocus="this.select()" />
                      <form method="post" action={`/d/${document.id}/share`}>
                        <input type="hidden" name="_csrf" value={csrfToken} />
                        <input type="hidden" name="visibility" value="team" />
                        <input type="hidden" name="next" value={backToUrl} />
                        <button type="submit">Stop sharing</button>
                      </form>
                    </>
                  ) : (
                    <>
                      <p>Team only. Sharing lets anyone signed in with the link view and comment.</p>
                      <form method="post" action={`/d/${document.id}/share`}>
                        <input type="hidden" name="_csrf" value={csrfToken} />
                        <input type="hidden" name="visibility" value="public" />
                        <input type="hidden" name="next" value={backToUrl} />
                        <button type="submit">Share with anyone signed in</button>
                      </form>
                    </>
                  )}
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
                  Markdown
                </a>
                <a href={`/api/docs/${document.id}/export.json`} download={`${document.id}-comments.json`}>
                  JSON
                </a>
                {canDelete && (
                  <a class="danger-link" href={`/d/${document.id}/delete`}>
                    Delete artifact…
                  </a>
                )}
              </div>
            </details>
          </div>
          <div class="frame-wrap" id="frame-wrap">
            <iframe
              id="artifact-frame"
              sandbox="allow-scripts"
              src={`/d/${document.id}/frame?version=${shownVersion.number}`}
              title={document.title}
            ></iframe>
          </div>
        </div>
        <aside class="sidebar" id="comments-sidebar">
          <button type="button" id="expand-sidebar" class="sidebar-expand" title="Show comments" aria-label="Show comments" hidden>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 3L5.5 8L10 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="rail-label" id="comments-rail-label">Comments</span>
          </button>
          <div class="sidebar-header">
            <span id="comments-title">Comments</span>
            <div class="comment-nav">
              <button type="button" id="prev-comment" aria-label="Previous comment" disabled>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M10 3L5.5 8L10 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <button type="button" id="next-comment" aria-label="Next comment" disabled>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 3L10.5 8L6 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <button type="button" id="collapse-sidebar" title="Hide comments" aria-label="Hide comments">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 3L10.5 8L6 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                  <path d="M11 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
              </button>
            </div>
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
