/**
 * Document assets (screenshots etc.) uploaded alongside publish_artifact.
 *
 * Assets are stored per document and inlined into the artifact HTML as data:
 * URIs when the frame is served. The sandboxed frame has an opaque origin and
 * sends no cookies, so a session-authed asset URL could never work from
 * inside it — serve-time inlining keeps the stored HTML small and sidesteps
 * auth entirely (the frame CSP already allows img-src data:).
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

import type { DB } from '../db/index.js';
import { assets, type Asset } from '../db/schema.js';

/** Per-asset decoded size cap. */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024;
/** Total decoded size cap per publish call. */
export const MAX_ASSETS_TOTAL_BYTES = 20 * 1024 * 1024;

/** Asset names appear verbatim inside src="..." — keep them quote- and traversal-free. */
const NAME_RE = /^[\w][\w.\/-]{0,199}$/;

export function isValidAssetName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes('..');
}

export interface IncomingAsset {
  name: string;
  mime: string;
  data: Buffer;
}

/** Insert or replace (by name) the document's assets. */
export function upsertAssets(db: DB, documentId: string, incoming: IncomingAsset[], now: Date): void {
  for (const asset of incoming) {
    db
      .insert(assets)
      .values({
        id: randomBytes(8).toString('hex'),
        documentId,
        name: asset.name,
        mime: asset.mime,
        data: asset.data,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [assets.documentId, assets.name],
        set: { mime: asset.mime, data: asset.data, createdAt: now },
      })
      .run();
  }
}

export function assetsForDocument(db: DB, documentId: string): Asset[] {
  return db.select().from(assets).where(eq(assets.documentId, documentId)).all();
}

/**
 * Replace src references to known asset names with data: URIs. Handles
 * src="name", src='name', and url(name)/url("name") in inline CSS.
 */
export function inlineAssets(html: string, docAssets: Asset[]): string {
  let out = html;
  for (const asset of docAssets) {
    const dataUri = `data:${asset.mime};base64,${asset.data.toString('base64')}`;
    out = out
      .replaceAll(`src="${asset.name}"`, `src="${dataUri}"`)
      .replaceAll(`src='${asset.name}'`, `src='${dataUri}'`)
      .replaceAll(`url("${asset.name}")`, `url("${dataUri}")`)
      .replaceAll(`url('${asset.name}')`, `url('${dataUri}')`)
      .replaceAll(`url(${asset.name})`, `url(${dataUri})`);
  }
  return out;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Point references to uploaded assets at files under `assets/` instead of
 * inlining them — used by the zip export, where the images ship next to
 * `index.html` / `source.md`. Covers src="name", src='name', CSS url(name)
 * in any quoting, and Markdown `](name)` links.
 *
 * All names are matched in one pass so a rewrite never feeds a later one:
 * with both `logo.png` and `assets/logo.png` uploaded, `logo.png` must not
 * end up as `assets/assets/logo.png`.
 */
export function relinkAssets(source: string, docAssets: Asset[]): string {
  if (docAssets.length === 0) return source;
  const names = [...new Set(docAssets.map((a) => a.name))].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const pattern = new RegExp(`(src=|url\\(|\\]\\()(["']?)(${names})(\\2)(?=[)>/\\s]|$)`, 'g');
  return source.replace(pattern, (_m, prefix: string, quote: string, name: string) => `${prefix}${quote}assets/${name}${quote}`);
}

/**
 * Drop `<base href>` so the relative `assets/...` links in an exported
 * `index.html` resolve next to the file instead of against a remote origin.
 */
export function stripBaseHref(html: string): string {
  return html.replace(/<base\b[^>]*>/gi, '');
}
