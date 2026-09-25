/**
 * The app's hand-written stylesheet, embedded as a string so it ships with
 * the compiled server output without a separate static-asset build step.
 * Served by `GET /static/app.css` in `routes/pages.ts`.
 *
 * Visual language mirrors the marketing site (artifact-colab-web): warm paper
 * background, ink text, burnt-orange accent, Geist / Geist Mono, pill buttons.
 */

export const appCss: string = `
:root {
  color-scheme: light;

  /* palette shared with the landing page (tokens.css) */
  --color-paper:        oklch(98.4% 0.004 80);
  --color-paper-2:      oklch(96.2% 0.006 80);
  --color-card:         oklch(99.2% 0.002 80);
  --color-rule:         oklch(90% 0.007 75);
  --color-rule-2:       oklch(83% 0.009 70);
  --color-neutral:      oklch(46% 0.014 58);
  --color-ink:          oklch(21% 0.008 55);
  --color-ink-2:        oklch(33% 0.010 55);
  --color-accent-bright: oklch(58% 0.190 45);
  --color-accent-deep:  oklch(50% 0.160 45);
  --color-accent-ink:   oklch(98% 0.012 75);
  --color-accent-wash:  oklch(93% 0.045 70);
  --color-focus:        oklch(50% 0.160 45);

  /* legacy aliases the page styles were written against */
  --color-bg: var(--color-paper);
  --color-surface: var(--color-card);
  --color-text: var(--color-ink);
  --color-muted: var(--color-neutral);
  --color-border: var(--color-rule);
  --color-accent: var(--color-accent-deep);
  --color-accent-hover: oklch(45% 0.145 45);

  --font-body: 'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-pill: 999px;

  --shadow-whisper: 0 1px 2px oklch(20% 0.01 55 / 0.05);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-micro: 120ms;
  --dur-short: 220ms;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: 15px;
  line-height: 1.55;
  accent-color: var(--color-accent);
  -webkit-font-smoothing: antialiased;
}

::selection {
  background: var(--color-accent-wash);
}

:focus {
  outline: none;
}

:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

a {
  color: var(--color-accent);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

header.site-header {
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}

.site-header-inner {
  padding: 0.6rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* Wordmark matches the landing page: mono face with a small accent square. */
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.55em;
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 0.95rem;
  letter-spacing: -0.01em;
  color: var(--color-text);
  white-space: nowrap;
}

.brand::before {
  content: '';
  width: 0.62em;
  height: 0.62em;
  border-radius: 2px;
  background: var(--color-accent-bright);
}

.brand:hover {
  text-decoration: none;
  color: var(--color-ink);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 1rem;
}

/* Header nav reads like the landing nav: quiet neutral links, ink on hover. */
.header-right > a {
  font-size: 0.9rem;
  color: var(--color-neutral);
}

.header-right > a:hover {
  color: var(--color-ink);
  text-decoration: none;
}

.header-right .muted {
  font-size: 0.875rem;
}

.header-right a,
.header-right button.link-button {
  font-size: 0.9rem;
}

.settings-menu {
  position: relative;
}

.settings-menu summary {
  list-style: none;
  cursor: pointer;
  font-size: 0.9rem;
  color: var(--color-neutral);
  transition: color var(--dur-micro) var(--ease-out);
}

.settings-menu summary::-webkit-details-marker {
  display: none;
}

.settings-menu summary::after {
  content: ' ▾';
  font-size: 0.7rem;
}

.settings-menu summary:hover {
  color: var(--color-ink);
}

.settings-menu-items {
  position: absolute;
  right: 0;
  top: calc(100% + 0.4rem);
  min-width: 10rem;
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px oklch(20% 0.01 55 / 0.08);
  padding: 0.25rem;
  z-index: 10;
}

/* The sign-out form must not add a box around its button. */
.settings-menu-items form {
  display: contents;
}

.settings-menu-items a,
.settings-menu-items button.link-button {
  display: block;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  padding: 0.45rem 0.65rem;
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  color: var(--color-text);
}

.settings-menu-items a:hover,
.settings-menu-items button.link-button:hover {
  text-decoration: none;
  background: var(--color-paper-2);
  color: var(--color-accent);
}

/* Destructive menu entries (e.g. the viewer's "Delete artifact…"). */
.settings-menu-items a.danger-link,
.settings-menu-items a.danger-link:hover {
  color: #b42318;
}

.settings-menu-items a.danger-link:hover {
  background: #fef3f2;
}

main {
  max-width: 720px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}

main.documents-page {
  max-width: 1200px;
}

.documents-table-scroll {
  position: relative;
  overflow-x: auto;
}

.documents-table {
  min-width: 720px;
}

.documents-table th:first-child {
  width: 100%;
  min-width: 300px;
}

.documents-table th:not(:first-child) {
  white-space: nowrap;
}

.document-title {
  display: block;
  font-weight: 500;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.document-owner {
  margin-top: 0.25rem;
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}

.documents-table time[data-split] span {
  display: block;
  white-space: nowrap;
}

main.wide {
  max-width: 960px;
}

h1 {
  font-size: 1.375rem;
  font-weight: 700;
  letter-spacing: -0.025em;
  margin: 0 0 1rem;
}

h2 {
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.015em;
  margin: 2rem 0 0.75rem;
}

p {
  margin: 0 0 1rem;
}

.muted {
  color: var(--color-muted);
}

/* Share-level marker (Private / Team / Public) in the document list. */
.share-badge {
  display: inline-block;
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-muted);
  background: var(--color-paper-2);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-pill);
  padding: 0.1rem 0.5rem;
  white-space: nowrap;
}
.share-badge-public {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: transparent;
}

.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-whisper);
  padding: 1.25rem 1.5rem;
  margin-bottom: 1rem;
}

table {
  width: 100%;
  border-collapse: collapse;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

th, td {
  text-align: left;
  padding: 0.625rem 1rem;
  border-bottom: 1px solid var(--color-border);
  vertical-align: middle;
}

th {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-muted);
  font-weight: 600;
}

tr:last-child td {
  border-bottom: none;
}

.empty-state {
  text-align: center;
  padding: 3rem 1.5rem;
  color: var(--color-muted);
}

label {
  display: block;
  font-weight: 500;
  margin-bottom: 0.375rem;
}

input[type='text'],
input[type='email'] {
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--color-rule-2);
  border-radius: var(--radius-sm);
  font-family: inherit;
  font-size: 0.95rem;
  background: var(--color-surface);
  color: var(--color-text);
}

input[type='text']:focus,
input[type='email']:focus {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}

.field {
  margin-bottom: 1rem;
}

/* Pill buttons, straight from the landing page's .btn. */
button,
input[type='submit'] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4em;
  background: var(--color-accent);
  color: var(--color-accent-ink);
  border: none;
  border-radius: var(--radius-pill);
  padding: 0.5rem 1.1rem;
  font-family: inherit;
  font-size: 0.95rem;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
  transition: background var(--dur-short) var(--ease-out), transform 100ms var(--ease-out);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }

  button:hover,
  input[type='submit']:hover {
    transform: none;
  }
}

button:hover,
input[type='submit']:hover {
  background: var(--color-accent-hover);
  transform: translateY(-1px);
}

button:active,
input[type='submit']:active {
  transform: translateY(0);
}

button.secondary {
  background: transparent;
  color: var(--color-text);
  border: 1px solid var(--color-rule-2);
}

button.secondary:hover {
  background: var(--color-paper-2);
}

button.link-button {
  background: none;
  border: none;
  border-radius: 0;
  color: var(--color-accent);
  padding: 0;
  font-size: inherit;
  font-weight: 400;
  cursor: pointer;
}

button.link-button:hover {
  background: none;
  transform: none;
}

.token-plaintext {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  background: var(--color-paper-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 0.75rem;
  word-break: break-all;
  margin: 0.5rem 0;
}

.error-message {
  color: #b42318;
  font-size: 0.9rem;
  margin-bottom: 1rem;
}

.form-card {
  max-width: 400px;
}

/* Settings page structure */
.page-intro {
  margin-top: -0.5rem;
  margin-bottom: 2rem;
}

.settings-section {
  margin-bottom: 2.5rem;
}

.settings-section h2 {
  font-size: 1.05rem;
  margin: 0 0 0.75rem;
}

.card.table-card {
  padding: 0;
  overflow: hidden;
}

/* Admin usage figures: a row of compact number tiles. */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 0.75rem;
}

.stat {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-whisper);
  padding: 0.85rem 1rem;
}

.stat-value {
  font-size: 1.35rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.stat-label {
  margin-top: 0.15rem;
  font-size: 0.78rem;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.table-card table {
  border: none;
}

.cell-actions {
  text-align: right;
}

/* Solid red primary action (e.g. the team-delete confirmation). */
button.danger {
  background: #b42318;
  color: #fff;
}

button.danger:hover {
  background: #912018;
}

/* Outline variant for inline row actions (Revoke, Remove, Cancel). */
button.secondary.danger {
  background: transparent;
  color: #b42318;
  border-color: #f0c7c2;
}

button.secondary.danger:hover {
  background: #fef3f2;
}

.form-row {
  display: flex;
  align-items: flex-end;
  gap: 0.75rem;
}

.form-row .field {
  margin-bottom: 0;
}

.field-grow {
  flex: 1;
}

.form-card.form-card {
  max-width: 520px;
}

/* First-run team wizard: the "who can join" radio choice. */
#team-wizard fieldset {
  border: none;
  padding: 0;
  margin: 0 0 1rem;
}

#team-wizard legend {
  font-weight: 500;
  margin-bottom: 0.375rem;
}

#team-wizard fieldset label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: normal;
  margin-bottom: 0.375rem;
}

.callout {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-whisper);
  padding: 1rem 1.25rem;
  margin-bottom: 2rem;
}

.callout-accent {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px var(--color-accent);
}

.callout-title {
  font-weight: 600;
  margin-bottom: 0.5rem;
}

.callout h3 {
  font-size: 0.95rem;
  margin: 1.25rem 0 0.25rem;
}

.callout p {
  margin: 0.25rem 0 0.5rem;
}

.copy-row {
  display: flex;
  align-items: stretch;
  gap: 0.5rem;
}

.copy-row .token-plaintext,
.copy-row .snippet {
  flex: 1;
  margin: 0;
  min-width: 0;
}

.copy-btn {
  flex: none;
  align-self: center;
}

/* Agent picker on the token settings page: radios styled as a segmented pill. */
.segmented {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  border: 1px solid var(--color-rule-2);
  border-radius: var(--radius-pill);
  background: var(--color-paper-2);
  padding: 3px;
  margin: 0.25rem 0 0.75rem;
}

.segmented label {
  cursor: pointer;
}

.segmented input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.segmented span {
  display: inline-flex;
  align-items: center;
  padding: 0.4rem 0.9rem;
  border-radius: var(--radius-pill);
  font-size: 0.9rem;
  color: var(--color-ink-2);
  transition: background var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out);
}

.segmented label:hover span {
  color: var(--color-ink);
}

.segmented input:checked + span {
  background: var(--color-ink);
  color: var(--color-paper);
}

.segmented input:focus-visible + span {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.snippet {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  background: var(--color-ink);
  color: var(--color-paper);
  border-radius: var(--radius-md);
  padding: 0.875rem 1rem;
  overflow-x: auto;
  white-space: pre;
  margin: 0.5rem 0;
}

.small {
  font-size: 0.85rem;
}

.page-title-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}

.team-group {
  margin-bottom: 2.5rem;
}

.shared-section-note {
  margin: -0.35rem 0 0.9rem;
  color: var(--color-muted);
  font-size: 0.85rem;
}

select {
  font-family: inherit;
  font-size: 0.95rem;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--color-rule-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
}

.inline-form {
  display: inline;
}

.cell-actions form {
  display: inline-block;
  margin-left: 0.5rem;
}

.profile-avatar-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.profile-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  flex: none;
  border: 1px solid var(--color-border);
}

.locked-note {
  font-size: 0.8rem;
  font-family: var(--font-mono);
  color: var(--color-muted);
  border: 1px solid var(--color-rule-2);
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
}

/* Project browsing and assignment. */
.documents-heading,
.project-heading,
.team-actions,
.view-switch,
.project-dialog-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.documents-heading,
.project-heading {
  justify-content: space-between;
}

.documents-heading h1,
.project-heading h1 {
  margin-bottom: 0;
}

.documents-heading {
  margin-bottom: 1.25rem;
}

.team-actions {
  margin-left: auto;
}

.view-switch {
  gap: 0.3rem;
  font-size: 0.875rem;
}

.view-switch a {
  color: var(--color-muted);
  padding: 0.25rem 0.55rem;
  border-radius: var(--radius-pill);
}

.view-switch a[aria-current='page'] {
  color: var(--color-accent-ink);
  background: var(--color-accent);
  text-decoration: none;
}

.compact-button {
  padding: 0.3rem 0.75rem;
  font-size: 0.85rem;
  white-space: nowrap;
}

.document-project-action {
  width: 1%;
  white-space: nowrap;
  text-align: right;
}

.project-tag {
  display: inline-block;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-ink-2);
  background: var(--color-accent-wash);
  border: 1px solid color-mix(in srgb, var(--color-accent) 25%, var(--color-border));
  border-radius: var(--radius-pill);
  padding: 0.1rem 0.55rem;
  font-size: 0.78rem;
}

.project-table-wrap {
  margin-bottom: 1.5rem;
}

.projects-table > thead > tr > th:first-child {
  width: 100%;
}

.table-sort,
.project-toggle {
  padding: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  justify-content: flex-start;
}

.table-sort {
  text-transform: inherit;
  letter-spacing: inherit;
  white-space: nowrap;
}

.table-sort:hover,
.project-toggle:hover {
  background: transparent;
  color: var(--color-accent);
  transform: none;
}

.table-sort:focus-visible,
.project-toggle:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 4px;
}

.sort-indicator {
  width: 1em;
  opacity: 0.5;
}

th[aria-sort='ascending'] .sort-indicator,
th[aria-sort='descending'] .sort-indicator {
  opacity: 1;
  color: var(--color-accent);
}

.project-row {
  cursor: pointer;
  scroll-margin-top: 1rem;
}

.project-row:hover,
.project-row:has([aria-expanded='true']) {
  background: var(--color-paper-2);
}

.project-toggle {
  width: 100%;
  color: var(--color-accent);
  gap: 0.65rem;
}

.project-chevron {
  flex: none;
  width: 0.45rem;
  height: 0.45rem;
  margin-right: 0.2rem;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform var(--dur-short) var(--ease-out);
}

.project-toggle[aria-expanded='true'] .project-chevron {
  transform: rotate(45deg);
}

.project-contents > td {
  padding: 0.75rem 1rem 1.25rem 2rem;
  background: var(--color-paper-2);
}

.project-row-actions {
  width: 1%;
  padding: 0.4rem 0.75rem;
  cursor: default;
}

.project-settings-button {
  width: 2.25rem;
  height: 1.75rem;
  padding: 0;
}

.project-settings-button:hover {
  transform: none;
}

.project-settings-button[aria-expanded='true'] {
  background: var(--color-paper-2);
}

.project-settings-button:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}

.project-actions-menu {
  position: fixed;
  inset: auto;
  margin: 0;
  max-width: calc(100vw - 1rem);
}

.project-actions-menu:not(:popover-open) {
  display: none;
}

.unfiled-heading {
  margin: 0 0 0.65rem;
  font-size: 0.95rem;
}

.unfiled-empty {
  padding: 1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.project-feedback {
  min-height: 1.4em;
  margin: 0.5rem 0 0.75rem;
  font-size: 0.9rem;
}

.project-feedback[data-kind='error'],
.project-dialog-feedback[data-kind='error'] {
  color: #b42318;
}

.project-feedback[data-kind='success'],
.project-dialog-feedback[data-kind='success'] {
  color: #15803d;
}

.breadcrumbs {
  display: flex;
  gap: 0.45rem;
  margin-bottom: 0.75rem;
  color: var(--color-muted);
  font-size: 0.85rem;
}

.project-heading {
  margin-bottom: 0.25rem;
}

.project-menu .settings-menu-items button.link-button {
  display: block;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  padding: 0.45rem 0.65rem;
  border-radius: var(--radius-sm);
  color: var(--color-text);
}

.project-menu .settings-menu-items button.link-button:hover {
  background: var(--color-paper-2);
  color: var(--color-accent);
}

.project-menu .settings-menu-items button.danger-link,
.project-menu .settings-menu-items button.danger-link:hover {
  color: #b42318;
}

.project-menu .settings-menu-items button.danger-link:hover {
  background: #fef3f2;
}

.project-empty-state {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.project-dialog {
  width: min(420px, calc(100vw - 2rem));
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  box-shadow: 0 16px 48px oklch(20% 0.01 55 / 0.2);
  padding: 0;
}

.project-dialog::backdrop {
  background: oklch(20% 0.01 55 / 0.35);
}

.project-dialog-form {
  padding: 1.25rem;
}

.project-dialog-form h2 {
  margin: 0 0 1rem;
}

.project-dialog-form select,
.project-dialog-form input[type='text'] {
  width: 100%;
}

.project-new-choice,
.project-existing-choice {
  margin-top: 0.75rem;
}

.project-new-fields label {
  margin-top: 0.75rem;
}

.project-dialog-feedback {
  min-height: 1.4em;
  margin: 0.75rem 0;
  font-size: 0.85rem;
}

.project-dialog-actions {
  justify-content: flex-end;
  margin-top: 1rem;
}

@media (max-width: 640px) {
  .site-header-inner {
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .header-right {
    flex-wrap: wrap;
    gap: 0.75rem;
    max-width: 100%;
  }

  .header-right > .muted {
    overflow-wrap: anywhere;
  }

  .documents-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .team-actions {
    flex-wrap: wrap;
  }
}

/* Admin backups: a link styled as the outline row-action button, and the packing bar. */
a.button-link {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--color-rule-2);
  border-radius: var(--radius-pill);
  padding: 0.5rem 1.1rem;
  font-size: 0.95rem;
  font-weight: 500;
  line-height: 1.2;
  color: var(--color-text);
  text-decoration: none;
}

a.button-link:hover {
  background: var(--color-paper-2);
}

.backup-progress {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.backup-progress[hidden] {
  display: none;
}

.backup-progress progress {
  width: 100%;
  height: 0.6rem;
  accent-color: var(--color-accent);
}

.backup-start button:disabled {
  opacity: 0.55;
  cursor: default;
  transform: none;
}

.backup-hint[hidden] {
  display: none;
}

.backup-name {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  word-break: break-all;
}

.backup-actions {
  white-space: nowrap;
}

.nowrap {
  white-space: nowrap;
}

.backup-narrow {
  display: none;
  margin-top: 0.25rem;
}

@media (max-width: 640px) {
  .backup-wide {
    display: none;
  }

  .backup-narrow {
    display: block;
  }

  .backup-actions {
    white-space: normal;
  }

  .backup-actions form,
  .backup-actions a.button-link {
    display: flex;
    justify-content: center;
    margin: 0 0 0.4rem;
  }

  .backup-actions form button {
    width: 100%;
  }
}
`;
