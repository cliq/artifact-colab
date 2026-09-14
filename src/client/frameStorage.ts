/**
 * Parent side of the artifact frame's Web Storage: the sandboxed frame has an
 * opaque origin and no storage of its own, so the viewer keeps each document's
 * `localStorage`/`sessionStorage` under a per-document key in its own storage,
 * seeds the frame through the iframe's `name` before it starts loading, and
 * writes back the snapshots the annotator reports.
 */

import { encodeFrameName, frameStorageKey, type StorageArea, type StorageContents } from '../shared/frameStorage.js';

function areaStore(area: StorageArea): Storage | null {
  try {
    return area === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null; // storage blocked in this browser: the frame still works, just without persistence
  }
}

function readContents(slug: string, area: StorageArea): StorageContents {
  try {
    const raw = areaStore(area)?.getItem(frameStorageKey(slug));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StorageContents) : {};
  } catch {
    return {};
  }
}

/**
 * Seed the frame with the document's saved storage and start loading it. The
 * page renders the frame with `data-src` instead of `src` so nothing loads
 * before the name is in place. Browsers only read the `name` attribute when
 * the frame's browsing context is created (Chromium ignores a later change),
 * so the element is briefly detached and re-inserted in the same spot; every
 * reference to it stays valid.
 */
export function loadFrame(iframe: HTMLIFrameElement, slug: string): void {
  const src = iframe.dataset.src;
  if (!src) return;
  const parent = iframe.parentNode;
  const next = iframe.nextSibling;
  iframe.remove();
  iframe.name = encodeFrameName({ local: readContents(slug, 'local'), session: readContents(slug, 'session') });
  iframe.src = src;
  parent?.insertBefore(iframe, next);
}

/** Persist a snapshot the frame reported; an empty area drops the key. */
export function persistFrameStorage(slug: string, area: StorageArea, data: StorageContents): void {
  const store = areaStore(area);
  if (!store) return;
  try {
    if (Object.keys(data).length === 0) store.removeItem(frameStorageKey(slug));
    else store.setItem(frameStorageKey(slug), JSON.stringify(data));
  } catch {
    /* quota exceeded or storage blocked: the frame keeps its in-memory copy */
  }
}
