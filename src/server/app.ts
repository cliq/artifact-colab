/**
 * App factory: wires up dependency injection (db/config), CSRF protection,
 * and all routes. The MCP endpoint is mounted separately (see mcp.ts) because
 * it is Bearer-authed and skips CSRF.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { Config } from './config.js';
import type { AppEnv } from './context.js';
import type { DB } from './db/index.js';
import { mcpRoutes } from './mcp.js';
import { csrfProtect, sessionAuth } from './middleware.js';
import { adminRoutes } from './routes/admin.js';
import { apiRoutes } from './routes/api.js';
import { authRoutes } from './routes/auth.js';
import { documentRoutes } from './routes/document.js';
import { frameRoutes } from './routes/frame.js';
import { pageRoutes } from './routes/pages.js';
import { publishRoutes } from './routes/publish.js';
import { tokensRoutes } from './routes/tokens.js';

// Publishing legitimately carries multi-megabyte bodies (5 MB html + 20 MB of
// assets, base64-inflated over MCP); every other endpoint takes small forms
// or JSON. Enforced before anything reads a body — csrfProtect buffers form
// bodies before any auth runs, so without a cap an anonymous POST could hold
// an arbitrarily large body in memory.
const PUBLISH_MAX_BODY_BYTES = 40 * 1024 * 1024;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const PUBLISH_BODY_PATHS = new Set(['/api/publish', '/mcp']);

export function createApp(deps: { db: DB; config: Config }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('db', deps.db);
    c.set('config', deps.config);
    await next();
  });

  const publishBodyLimit = bodyLimit({ maxSize: PUBLISH_MAX_BODY_BYTES });
  const defaultBodyLimit = bodyLimit({ maxSize: DEFAULT_MAX_BODY_BYTES });
  app.use('*', (c, next) => {
    const path = new URL(c.req.url).pathname;
    return (PUBLISH_BODY_PATHS.has(path) ? publishBodyLimit : defaultBodyLimit)(c, next);
  });

  app.use('*', csrfProtect());

  app.get('/healthz', (c) => c.json({ ok: true }));

  // MCP endpoint (Bearer PAT auth; csrfProtect skips /mcp)
  app.route('/', mcpRoutes(deps));

  // Multipart publish endpoint (Bearer PAT auth; csrfProtect skips it, and it
  // must be mounted before the session-authed /api/* middleware below)
  app.route('/', publishRoutes);

  app.route('/', authRoutes);

  // JSON token API (session-authed, 401 on failure)
  app.use('/tokens/*', sessionAuth({ redirect: false }));
  app.use('/tokens', sessionAuth({ redirect: false }));
  app.route('/', tokensRoutes);

  // REST API for the viewer sidebar
  app.use('/api/*', sessionAuth({ redirect: false }));
  app.route('/', apiRoutes);

  // Viewer page + sandboxed artifact frame (HTML routes redirect to sign-in)
  app.use('/d/*', sessionAuth({ redirect: true }));
  app.route('/', frameRoutes);
  app.route('/', documentRoutes);

  // Admin area (/admin) + team settings (/teams/:id/settings) — session-authed
  // inside, 404s for anyone not authorized to see them.
  app.route('/', adminRoutes);

  // Server-rendered pages (sign-in, document list, token settings) — these
  // apply sessionAuth per-route themselves.
  app.route('/', pageRoutes);

  return app;
}
