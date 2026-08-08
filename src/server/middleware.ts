/**
 * HTTP-facing auth and CSRF middleware. Service logic (hashing, DB lookups)
 * lives in `auth.ts`; this module is only responsible for reading requests,
 * setting cookies/headers, and deciding how to respond on failure.
 */

import { randomBytes } from 'node:crypto';

import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { getSessionUser, getTokenAuth } from './auth.js';
import type { AppEnv } from './context.js';

// /api/publish is Bearer-authed (no cookies), so CSRF doesn't apply — and the
// check would otherwise consume the multipart body before the handler runs.
const CSRF_EXEMPT_PREFIXES = ['/mcp', '/auth/', '/api/publish'];
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isSecure(baseUrl: string): boolean {
  return baseUrl.startsWith('https');
}

export function setSessionCookie(c: Context<AppEnv>, token: string, maxAgeSeconds: number): void {
  const config = c.get('config');
  setCookie(c, 'session', token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: isSecure(config.baseUrl),
    maxAge: maxAgeSeconds,
  });
}

export function sessionAuth(opts: { redirect: boolean }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const db = c.get('db');
    const token = getCookie(c, 'session');
    const user = token ? getSessionUser(db, token, new Date()) : null;

    if (!user) {
      if (opts.redirect) {
        const url = new URL(c.req.url);
        const next = encodeURIComponent(url.pathname + url.search);
        return c.redirect(`/signin?next=${next}`, 302);
      }
      return c.json({ error: 'unauthorized' }, 401);
    }

    c.set('user', user);
    await next();
  };
}

export function bearerAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const db = c.get('db');
    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    const auth = bearer ? getTokenAuth(db, bearer, new Date()) : null;

    if (!auth) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'invalid or missing token' }, 401);
    }

    c.set('user', auth.user);
    c.set('tokenTeamId', auth.token.teamId);
    await next();
  };
}

export function csrfProtect(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (CSRF_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      await next();
      return;
    }

    const method = c.req.method;

    if (method === 'GET') {
      const config = c.get('config');
      const existing = getCookie(c, 'csrf');
      const csrfToken = existing ?? randomBytes(32).toString('hex');
      // Expose the token to handlers: on a first-ever visit the cookie is
      // only being set on THIS response, so reading the request cookie during
      // render would come up empty and forms would carry a blank _csrf.
      c.set('csrfToken', csrfToken);

      await next();

      if (!existing) {
        setCookie(c, 'csrf', csrfToken, {
          httpOnly: false,
          sameSite: 'Lax',
          path: '/',
          secure: isSecure(config.baseUrl),
        });
      }
      return;
    }

    if (MUTATING_METHODS.has(method)) {
      const cookieValue = getCookie(c, 'csrf');
      const headerValue = c.req.header('x-csrf-token');
      let formValue: string | undefined;
      if (!headerValue) {
        try {
          const body = await c.req.parseBody();
          formValue = typeof body['_csrf'] === 'string' ? body['_csrf'] : undefined;
        } catch {
          // Not a form body (e.g. JSON) — no form field to check.
        }
      }
      const provided = headerValue ?? formValue;

      if (!cookieValue || !provided || provided !== cookieValue) {
        return c.json({ error: 'invalid csrf token' }, 403);
      }
    }

    await next();
  };
}

/** CSRF token for rendering into forms — context first (fresh GETs), cookie otherwise. */
export function csrfTokenFor(c: Context<AppEnv>): string {
  return c.get('csrfToken') ?? getCookie(c, 'csrf') ?? '';
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, 'session', { path: '/' });
}
