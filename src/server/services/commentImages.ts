/**
 * Images attached to comments and replies, from the web composer (multipart
 * uploads) or add_comment over MCP (base64). They are fixed at creation —
 * editing a comment changes only its body.
 *
 * The type is sniffed from the bytes rather than trusted from the upload, and
 * only PNG, JPEG, GIF and WebP pass: the images are served from the app
 * origin, so anything scriptable (SVG, HTML) must never get in.
 */

import { randomBytes } from 'node:crypto';

import { asc, inArray, sql } from 'drizzle-orm';

import type { DBOrTx } from '../db/index.js';
import { commentImages } from '../db/schema.js';

export const MAX_COMMENT_IMAGES = 4;
/** Per-image size cap (decoded bytes). */
export const MAX_COMMENT_IMAGE_BYTES = 5 * 1024 * 1024;

/** What a comment DTO carries per image; the bytes load from `url`. */
export interface CommentImageDTO {
  id: string;
  mime: string;
  size: number;
  url: string;
}

export function commentImageUrl(id: string): string {
  return `/api/comment-images/${id}`;
}

/** The image type a buffer's magic bytes announce, or null when it is not an accepted format. */
export function sniffImageMime(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && (data.subarray(0, 6).toString('latin1') === 'GIF87a' || data.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return 'image/gif';
  }
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export interface ValidImage {
  mime: string;
  data: Buffer;
}

/**
 * Check a set of incoming images against the count, size and format rules.
 * `label` names each one in the error (a file name, or "image 2").
 */
export function validateCommentImages(
  incoming: { label: string; data: Buffer }[],
): { ok: true; images: ValidImage[] } | { ok: false; error: string } {
  if (incoming.length > MAX_COMMENT_IMAGES) {
    return { ok: false, error: `a comment can have at most ${MAX_COMMENT_IMAGES} images` };
  }
  const images: ValidImage[] = [];
  for (const { label, data } of incoming) {
    if (data.length === 0) return { ok: false, error: `${label} is empty` };
    if (data.length > MAX_COMMENT_IMAGE_BYTES) {
      return { ok: false, error: `${label} is larger than ${MAX_COMMENT_IMAGE_BYTES / (1024 * 1024)} MB` };
    }
    const mime = sniffImageMime(data);
    if (!mime) return { ok: false, error: `${label} is not a PNG, JPEG, GIF or WebP image` };
    images.push({ mime, data });
  }
  return { ok: true, images };
}

export function insertCommentImages(db: DBOrTx, commentId: string, images: ValidImage[], now: Date): void {
  images.forEach((image, position) => {
    db.insert(commentImages)
      .values({ id: randomBytes(8).toString('hex'), commentId, position, mime: image.mime, data: image.data, createdAt: now })
      .run();
  });
}

/** Image metadata (no bytes) for a set of comments, grouped per comment in attach order. */
export function imagesForComments(db: DBOrTx, commentIds: string[]): Map<string, CommentImageDTO[]> {
  const grouped = new Map<string, CommentImageDTO[]>();
  if (commentIds.length === 0) return grouped;
  const rows = db
    .select({
      id: commentImages.id,
      commentId: commentImages.commentId,
      mime: commentImages.mime,
      size: sql<number>`length(${commentImages.data})`,
    })
    .from(commentImages)
    .where(inArray(commentImages.commentId, commentIds))
    .orderBy(asc(commentImages.position))
    .all();
  for (const row of rows) {
    const list = grouped.get(row.commentId) ?? [];
    list.push({ id: row.id, mime: row.mime, size: row.size, url: commentImageUrl(row.id) });
    grouped.set(row.commentId, list);
  }
  return grouped;
}
