import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from './context.js';
import type { DocumentsView } from './services/documentLists.js';

export function documentsView(c: Context<AppEnv>): DocumentsView {
  const key = `documents-view-${c.get('user').id}`;
  const query = c.req.query('view');
  if (query === 'folders' || query === 'tags') {
    setCookie(c, key, query, { path: '/', httpOnly: true, sameSite: 'Lax', secure: c.get('config').baseUrl.startsWith('https:'), maxAge: 365 * 24 * 60 * 60 });
    return query;
  }
  return getCookie(c, key) === 'tags' ? 'tags' : 'folders';
}
