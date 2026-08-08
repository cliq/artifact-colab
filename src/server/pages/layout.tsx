/**
 * Shared page shell: doctype/head boilerplate plus the top nav (brand, signed
 * in user, and a Settings menu with agent-connection and sign-out). Every page
 * renders through this so the CSS link and nav only need to be written once.
 */

import type { FC } from 'hono/jsx';

import type { User } from '../db/schema.js';

// The Settings dropdown is a <details> element (works without JS); this only
// closes it again when the user clicks elsewhere on the page.
const menuScript = `
document.addEventListener('click', function (e) {
  document.querySelectorAll('details.settings-menu[open]').forEach(function (menu) {
    if (!menu.contains(e.target)) menu.removeAttribute('open');
  });
});
document.querySelectorAll('time[datetime]').forEach(function (el) {
  var date = new Date(el.getAttribute('datetime'));
  if (isNaN(date)) return;
  el.title = el.textContent;
  el.textContent = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
});
`;

export interface LayoutProps {
  title: string;
  user?: User;
  csrfToken: string;
  /** Shows the Admin link in the settings menu. Pages that don't know simply omit it. */
  isInstanceAdmin?: boolean;
  children?: unknown;
}

export const Layout: FC<LayoutProps> = ({ title, user, csrfToken, isInstanceAdmin, children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@400;600&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/static/app.css" />
      </head>
      <body>
        <header class="site-header">
          <div class="site-header-inner">
            <a class="brand" href="/">
              Artifact Colab
            </a>
            {user && (
              <div class="header-right">
                <a href="/">Artifacts</a>
                <span class="muted">{user.email}</span>
                <details class="settings-menu">
                  <summary>Settings</summary>
                  <div class="settings-menu-items">
                    <a href="/settings/profile">Profile</a>
                    <a href="/settings/tokens">Connect agents</a>
                    {isInstanceAdmin && <a href="/admin">Admin</a>}
                    <form method="post" action="/auth/signout">
                      <input type="hidden" name="_csrf" value={csrfToken} />
                      <button type="submit" class="link-button">
                        Sign out
                      </button>
                    </form>
                  </div>
                </details>
              </div>
            )}
          </div>
        </header>
        <main>{children}</main>
        <script dangerouslySetInnerHTML={{ __html: menuScript }}></script>
      </body>
    </html>
  );
};
