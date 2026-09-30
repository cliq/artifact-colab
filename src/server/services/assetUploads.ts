/**
 * Staged asset uploads, for files too large to pass as base64 in a tool call.
 *
 * prepare_asset_upload hands the agent one upload URL per file; the agent
 * PUTs the raw bytes there (e.g. `curl -T`), then passes the upload ids to
 * publish_artifact, which claims them as assets of the new version. The URL
 * carries a random id that is its only credential, so the agent never has to
 * handle its bearer token. Each id takes one upload, expires after
 * `UPLOAD_TTL_MS`, and can only be claimed through the token that prepared it.
 */

import { randomBytes } from 'node:crypto';

import { and, count, eq, gt, inArray, isNull, lte } from 'drizzle-orm';

import { sha256hex } from '../auth.js';
import type { DBOrTx } from '../db/index.js';
import { assetUploads, teamMembers, tokens } from '../db/schema.js';
import { isValidAssetName, MAX_ASSET_BYTES, type IncomingAsset } from './assets.js';

export const UPLOAD_TTL_MS = 60 * 60 * 1000;
/** Files one prepare_asset_upload call can stage. */
export const MAX_UPLOADS_PER_PREPARE = 25;
/** Unclaimed, unexpired uploads a token may hold at once — bounds what an abandoned session leaves in the database. */
export const MAX_PENDING_UPLOADS_PER_TOKEN = 50;

export function assetUploadUrl(baseUrl: string, uploadId: string): string {
  return `${baseUrl}/api/uploads/${uploadId}`;
}

export type PreparedUpload = { uploadId: string; name: string; mime: string; expiresAt: Date };

export function prepareUploads(
  db: DBOrTx,
  tokenId: string,
  files: { name: string; mime: string }[],
  now: Date,
): { ok: true; uploads: PreparedUpload[] } | { ok: false; error: string } {
  if (files.length === 0) return { ok: false, error: 'list at least one file' };
  if (files.length > MAX_UPLOADS_PER_PREPARE) return { ok: false, error: `at most ${MAX_UPLOADS_PER_PREPARE} files per call` };
  for (const file of files) {
    if (!isValidAssetName(file.name)) {
      return { ok: false, error: `invalid asset name: ${file.name} (letters, digits, ./_- only, no "..")` };
    }
  }
  const names = new Set(files.map((f) => f.name));
  if (names.size !== files.length) return { ok: false, error: 'each file name may appear only once' };

  sweepExpiredUploads(db, now);
  const pending = db.select({ n: count() }).from(assetUploads).where(eq(assetUploads.tokenId, tokenId)).get()?.n ?? 0;
  if (pending + files.length > MAX_PENDING_UPLOADS_PER_TOKEN) {
    return {
      ok: false,
      error: `this token already has ${pending} unclaimed uploads (max ${MAX_PENDING_UPLOADS_PER_TOKEN}); publish them or wait for them to expire`,
    };
  }

  const expiresAt = new Date(now.getTime() + UPLOAD_TTL_MS);
  const uploads = files.map((file) => {
    const uploadId = randomBytes(24).toString('base64url');
    db.insert(assetUploads)
      .values({ idHash: sha256hex(uploadId), tokenId, name: file.name, mime: file.mime, data: null, createdAt: now, expiresAt })
      .run();
    return { uploadId, name: file.name, mime: file.mime, expiresAt };
  });
  return { ok: true, uploads };
}

function tokenIsLive(db: DBOrTx, tokenId: string): boolean {
  const token = db.select().from(tokens).where(eq(tokens.id, tokenId)).get();
  if (!token) return false;
  return !!db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, token.teamId), eq(teamMembers.userId, token.userId)))
    .get();
}

export type ReceiveOutcome =
  | { ok: true; name: string; size: number }
  | { ok: false; status: 400 | 404 | 409 | 413; error: string };

/** Store the bytes PUT to an upload URL. Unknown, expired and orphaned (token gone) ids all look the same. */
export function receiveUpload(db: DBOrTx, uploadId: string, data: Buffer, now: Date): ReceiveOutcome {
  const row = db.select().from(assetUploads).where(eq(assetUploads.idHash, sha256hex(uploadId))).get();
  if (!row || row.expiresAt <= now || !tokenIsLive(db, row.tokenId)) {
    return { ok: false, status: 404, error: 'unknown or expired upload URL; call prepare_asset_upload again' };
  }
  if (data.length === 0) return { ok: false, status: 400, error: 'empty body; PUT the file contents' };
  if (data.length > MAX_ASSET_BYTES) return { ok: false, status: 413, error: 'file exceeds the 4 MB per-asset cap' };
  // Conditional on data still being null, so two racing PUTs cannot both win.
  const updated = db
    .update(assetUploads)
    .set({ data })
    .where(and(eq(assetUploads.idHash, row.idHash), isNull(assetUploads.data)))
    .run();
  if (updated.changes === 0) return { ok: false, status: 409, error: 'this upload URL was already used; each URL takes one file' };
  return { ok: true, name: row.name, size: data.length };
}

/**
 * Resolve upload ids to assets for a publish through `tokenId`, without
 * consuming them — the caller deletes them with `claimUploads` once the
 * version is written, so a publish that fails validation leaves them usable.
 */
export function readUploads(
  db: DBOrTx,
  tokenId: string,
  uploadIds: string[],
  now: Date,
): { ok: true; assets: IncomingAsset[]; idHashes: string[] } | { ok: false; error: string } {
  if (new Set(uploadIds).size !== uploadIds.length) return { ok: false, error: 'each upload id may appear only once' };
  const out: IncomingAsset[] = [];
  const idHashes: string[] = [];
  for (const uploadId of uploadIds) {
    const idHash = sha256hex(uploadId);
    const row = db
      .select()
      .from(assetUploads)
      .where(and(eq(assetUploads.idHash, idHash), eq(assetUploads.tokenId, tokenId), gt(assetUploads.expiresAt, now)))
      .get();
    if (!row) return { ok: false, error: `unknown or expired upload id: ${uploadId}` };
    if (row.data === null) {
      return { ok: false, error: `upload ${uploadId} (${row.name}) has no file yet; PUT it to its upload URL first` };
    }
    out.push({ name: row.name, mime: row.mime, data: row.data });
    idHashes.push(idHash);
  }
  return { ok: true, assets: out, idHashes };
}

export function claimUploads(db: DBOrTx, idHashes: string[]): void {
  if (idHashes.length > 0) db.delete(assetUploads).where(inArray(assetUploads.idHash, idHashes)).run();
}

export function sweepExpiredUploads(db: DBOrTx, now: Date): number {
  return db.delete(assetUploads).where(lte(assetUploads.expiresAt, now)).run().changes;
}
