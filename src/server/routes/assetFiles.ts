/**
 * Uploaded assets at their own URL, `/d/:slug/<asset name>` — where a
 * relative link inside the artifact (e.g. `<a href="shots/x.jpg">` around a
 * thumbnail) lands when opened in a new tab, since the frame is served from
 * `/d/:slug/frame`. The frame itself keeps inlining assets as data: URIs: it
 * has an opaque origin and sends no cookies, but a top-level tab does.
 *
 * Assets are publisher-supplied files of any type (SVG, HTML…) served on the
 * app origin, so the response gets the same treatment as a direct frame
 * visit: a CSP `sandbox` (opaque origin, no scripts) plus `nosniff`.
 * Mounted after every other `/d/:slug/...` route so those keep precedence.
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { assets } from '../db/schema.js';
import { isValidAssetName } from '../services/assets.js';
import { findDocumentForViewer } from './api.js';

const ASSET_CSP = [`sandbox`, `default-src 'none'`, `img-src data:`, `style-src 'unsafe-inline'`].join('; ');

export const assetFileRoutes = new Hono<AppEnv>();

assetFileRoutes.get('/d/:slug/:name{.+}', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const name = c.req.param('name');
  if (!isValidAssetName(name)) return c.notFound();

  const doc = findDocumentForViewer(db, c.req.param('slug'), user.id)?.document;
  if (!doc) return c.notFound();

  const asset = db.select().from(assets).where(and(eq(assets.documentId, doc.id), eq(assets.name, name))).get();
  if (!asset) return c.notFound();

  const filename = name.split('/').pop() ?? name;
  return c.body(new Uint8Array(asset.data), 200, {
    'Content-Type': asset.mime,
    'Content-Disposition': `inline; filename="${filename}"`,
    'Content-Security-Policy': ASSET_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'private, no-store',
  });
});
