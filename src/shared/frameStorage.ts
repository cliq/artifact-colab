/**
 * Wire format for the artifact frame's Web Storage, shared by the viewer page
 * and the annotator. The sandboxed frame has an opaque origin, so browsers
 * refuse it `localStorage`/`sessionStorage`; the viewer keeps each document's
 * storage in its own origin's storage instead and hands the frame a snapshot
 * through the iframe's `name` attribute — the only channel a frame can read
 * synchronously, before the artifact's own scripts run. Writes come back over
 * postMessage as full snapshots (see `FrameMessage` `storage`).
 */

export type StorageArea = 'local' | 'session';

/** One storage area's contents: every value is a string, like real Web Storage. */
export type StorageContents = Record<string, string>;

export interface FrameStorageSnapshot {
  local: StorageContents;
  session: StorageContents;
}

/** Marks a frame name as carrying a snapshot (artifacts may set names of their own). */
const NAME_PREFIX = 'artifact-storage:';

/** Where the viewer keeps a document's frame storage in its own Web Storage. */
export function frameStorageKey(slug: string): string {
  return `artifact-storage:${slug}`;
}

/** Drop anything that isn't a plain string→string record (the frame is untrusted). */
export function sanitizeContents(value: unknown): StorageContents {
  const out: StorageContents = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

export function encodeFrameName(snapshot: FrameStorageSnapshot): string {
  return NAME_PREFIX + JSON.stringify({ local: snapshot.local, session: snapshot.session });
}

/** null when the name carries no snapshot or an unreadable one. */
export function decodeFrameName(name: string): FrameStorageSnapshot | null {
  if (typeof name !== 'string' || !name.startsWith(NAME_PREFIX)) return null;
  try {
    const parsed = JSON.parse(name.slice(NAME_PREFIX.length)) as { local?: unknown; session?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return null;
    return { local: sanitizeContents(parsed.local), session: sanitizeContents(parsed.session) };
  } catch {
    return null;
  }
}
