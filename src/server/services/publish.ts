/**
 * Shared publish flow behind both the MCP publish_artifact tool and the REST
 * POST /api/publish endpoint: validates sizes and asset names, renders
 * Markdown submissions to HTML (keeping the source on the version), creates
 * the document (or appends a version to an existing one), upserts assets, and
 * recomputes comment anchors.
 */

import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import { documents, versions, type User } from '../db/schema.js';
import { findDocumentInTeam } from '../routes/api.js';
import { recomputeForVersion } from './anchorStates.js';
import { renderMarkdownArtifact } from './markdown.js';
import { autoWatch } from './watches.js';
import {
  isValidAssetName,
  MAX_ASSET_BYTES,
  MAX_ASSETS_TOTAL_BYTES,
  upsertAssets,
  type IncomingAsset,
} from './assets.js';

export const MAX_HTML_BYTES = 5 * 1024 * 1024;

/** Base58 (no 0/O/I/l) — short, unambiguous, URL-safe document slugs. */
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function slug(length = 10): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += BASE58[bytes[i]! % BASE58.length];
  return out;
}

function id(): string {
  return randomBytes(8).toString('hex');
}

export interface PublishInput {
  title: string;
  /** Complete HTML for the artifact. Exactly one of `html` / `markdown` must be given. */
  html?: string;
  /** Markdown source; the server renders it to HTML at publish time and keeps the source on the version. */
  markdown?: string;
  documentId?: string;
  assets?: IncomingAsset[];
}

export type PublishOutcome =
  | { ok: true; documentId: string; versionNumber: number; url: string; orphaned: number }
  | { ok: false; status: 400 | 404; error: string };

/** `teamId` comes from the publishing token, not the user — republishing via a token from a different team 404s. */
export function publishArtifact(db: DB, config: Config, user: User, teamId: string, input: PublishInput): PublishOutcome {
  const { title, markdown, documentId: existingId } = input;

  if ((input.html === undefined) === (markdown === undefined)) {
    return { ok: false, status: 400, error: 'provide exactly one of html or markdown' };
  }
  const source = input.html ?? markdown!;
  if (Buffer.byteLength(source, 'utf8') > MAX_HTML_BYTES) {
    return { ok: false, status: 400, error: `${input.html !== undefined ? 'html' : 'markdown'} exceeds the 5 MB cap` };
  }
  const html = input.html ?? renderMarkdownArtifact(markdown!, title);

  const incoming = input.assets ?? [];
  let total = 0;
  for (const asset of incoming) {
    if (!isValidAssetName(asset.name)) {
      return { ok: false, status: 400, error: `invalid asset name: ${asset.name} (letters, digits, ./_- only, no "..")` };
    }
    if (asset.data.length === 0) return { ok: false, status: 400, error: `asset ${asset.name} is empty` };
    if (asset.data.length > MAX_ASSET_BYTES) {
      return { ok: false, status: 400, error: `asset ${asset.name} exceeds the 4 MB per-file cap` };
    }
    total += asset.data.length;
    if (total > MAX_ASSETS_TOTAL_BYTES) return { ok: false, status: 400, error: 'assets exceed the 20 MB total cap' };
  }

  const now = new Date();
  let docId: string;
  let versionNumber: number;
  if (existingId !== undefined) {
    const doc = findDocumentInTeam(db, existingId, teamId);
    if (!doc) return { ok: false, status: 404, error: `unknown document_id: ${existingId}` };
    docId = doc.id;
    const latest = db
      .select({ number: versions.number })
      .from(versions)
      .where(eq(versions.documentId, docId))
      .all()
      .reduce((max, v) => Math.max(max, v.number), 0);
    versionNumber = latest + 1;
    db.update(documents).set({ title }).where(eq(documents.id, docId)).run();
  } else {
    docId = slug();
    versionNumber = 1;
    db.insert(documents)
      .values({ id: docId, title, teamId, createdBy: user.id, currentVersionId: null, createdAt: now })
      .run();
  }

  const versionId = id();
  db.insert(versions)
    .values({ id: versionId, documentId: docId, number: versionNumber, html, sourceMarkdown: markdown ?? null, publishedAt: now })
    .run();
  db.update(documents).set({ currentVersionId: versionId }).where(eq(documents.id, docId)).run();
  if (incoming.length > 0) upsertAssets(db, docId, incoming, now);
  autoWatch(db, docId, user.id, now);
  const { orphaned } = recomputeForVersion(db, docId, versionId);

  return { ok: true, documentId: docId, versionNumber, url: `${config.baseUrl}/d/${docId}`, orphaned };
}
