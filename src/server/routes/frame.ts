/**
 * Serves artifact HTML inside the sandboxed iframe, with the annotator
 * runtime inlined. The frame has an opaque origin (sandbox="allow-scripts"),
 * so the script cannot be loaded by URL — it must be inline. Isolation comes
 * from the sandbox — declared both by the parent's iframe attribute and by
 * this response's own CSP `sandbox` directive, so a direct visit to the frame
 * URL is just as isolated as the framed view; the rest of the CSP limits
 * network egress to a small CDN allowlist so typical Claude artifacts keep
 * working.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { versions } from '../db/schema.js';
import { assetsForDocument, inlineAssets } from '../services/assets.js';
import { findDocumentForUser } from './api.js';

let annotatorJsCache: string | null = null;

/** Read the bundled annotator once; missing bundle degrades to no annotator. */
function getAnnotatorJs(): string {
  if (annotatorJsCache !== null) return annotatorJsCache;
  try {
    const raw = readFileSync(join(process.cwd(), 'dist', 'annotator.js'), 'utf8');
    // A literal "</script" inside the inlined source would close our tag early.
    annotatorJsCache = raw.replaceAll('</script', '<\\/script');
  } catch {
    console.warn('dist/annotator.js not found — serving frames without the annotator');
    annotatorJsCache = '';
  }
  return annotatorJsCache;
}

/** Test hook: force a re-read of the annotator bundle. */
export function resetAnnotatorCache(): void {
  annotatorJsCache = null;
}

function frameCsp(cdnAllowlist: string[]): string {
  const hosts = cdnAllowlist.map((h) => `https://${h}`).join(' ');
  return [
    // Opaque origin even when the frame URL is opened top-level: without
    // this, the sandbox exists only as the viewer page's iframe attribute,
    // and a shared direct link would run publisher HTML on the app origin
    // (able to read the CSRF cookie and call the session-authed API).
    `sandbox allow-scripts`,
    `default-src 'none'`,
    `script-src 'unsafe-inline' 'unsafe-eval'${hosts ? ` ${hosts}` : ''}`,
    `style-src 'unsafe-inline'${hosts ? ` ${hosts}` : ''}`,
    `font-src data:${hosts ? ` ${hosts}` : ''}`,
    `img-src data: https:`,
    `connect-src 'none'`,
    `frame-ancestors 'self'`,
  ].join('; ');
}

export const frameRoutes = new Hono<AppEnv>();

frameRoutes.get('/d/:slug/frame', (c) => {
  const user = c.get('user');
  const db = c.get('db');
  const config = c.get('config');
  const slug = c.req.param('slug');

  const doc = findDocumentForUser(db, slug, user.id);
  if (!doc) return c.notFound();

  const versionParam = c.req.query('version');
  let version;
  if (versionParam !== undefined) {
    const number = Number.parseInt(versionParam, 10);
    if (!Number.isFinite(number)) return c.notFound();
    version = db
      .select()
      .from(versions)
      .where(and(eq(versions.documentId, doc.id), eq(versions.number, number)))
      .get();
  } else if (doc.currentVersionId) {
    version = db.select().from(versions).where(eq(versions.id, doc.currentVersionId)).get();
  }
  if (!version) return c.notFound();

  // Uploaded assets are substituted as data: URIs — the opaque-origin frame
  // sends no cookies, so it could never fetch them from an authed URL.
  const docAssets = assetsForDocument(db, doc.id);
  const html = docAssets.length > 0 ? inlineAssets(version.html, docAssets) : version.html;

  // Prepended, not head-injected: many artifacts have no <head>, and the
  // parser hoists a leading <script> into head on its own.
  const annotator = getAnnotatorJs();
  const body = annotator ? `<script>${annotator}</script>${html}` : html;

  return c.body(body, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': frameCsp(config.frameCdnAllowlist),
    'Cache-Control': 'private, no-store',
  });
});
