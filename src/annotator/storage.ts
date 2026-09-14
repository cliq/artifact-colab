/**
 * Web Storage inside the sandboxed artifact frame. Its opaque origin makes
 * `window.localStorage` throw a SecurityError, so artifacts that remember
 * settings silently lose them on every load. When that is the case, this
 * installs in-memory `localStorage`/`sessionStorage` replacements primed from
 * the snapshot the viewer put in the frame's name, and reports every change
 * back so the viewer can persist it in its own storage.
 *
 * Must run before any artifact script — the annotator is prepended to the
 * artifact HTML for exactly this reason.
 */

import { decodeFrameName, encodeFrameName, type StorageArea, type StorageContents } from '../shared/frameStorage.js';

export type StorageSender = (area: StorageArea, data: StorageContents) => void;

export interface StorageShim {
  /** Start delivering snapshots; changes made before this flush at once. */
  attach(send: StorageSender): void;
}

/** True when the frame can use its own storage, in which case nothing is replaced. */
function nativeStorageAvailable(win: Window): boolean {
  try {
    return typeof win.localStorage === 'object' && win.localStorage !== null;
  } catch {
    return false;
  }
}

/**
 * A `Storage` look-alike over a Map. The Proxy covers named access
 * (`localStorage.theme = 'dark'`, `delete localStorage.theme`, `'theme' in
 * localStorage`), which the real interface supports too.
 */
function createStorage(initial: StorageContents, changed: () => void): { storage: Storage; contents: () => StorageContents } {
  const map = new Map<string, string>(Object.entries(initial));
  const api = {
    get length(): number {
      return map.size;
    },
    key(index: number): string | null {
      const n = Number(index);
      const keys = [...map.keys()];
      return Number.isInteger(n) && n >= 0 && n < keys.length ? keys[n]! : null;
    },
    getItem(key: string): string | null {
      const k = String(key);
      return map.has(k) ? map.get(k)! : null;
    },
    setItem(key: string, value: string): void {
      map.set(String(key), String(value));
      changed();
    },
    removeItem(key: string): void {
      if (map.delete(String(key))) changed();
    },
    clear(): void {
      if (map.size === 0) return;
      map.clear();
      changed();
    },
  };
  const isNamed = (p: string | symbol): p is string => typeof p === 'string' && !(p in api);
  const storage = new Proxy(api, {
    get(target, p, receiver) {
      if (isNamed(p)) return map.get(p);
      return Reflect.get(target, p, receiver);
    },
    set(target, p, value, receiver) {
      if (!isNamed(p)) return Reflect.set(target, p, value, receiver);
      target.setItem(p, value as string);
      return true;
    },
    has(target, p) {
      return (isNamed(p) && map.has(p)) || Reflect.has(target, p);
    },
    deleteProperty(target, p) {
      if (!isNamed(p)) return Reflect.deleteProperty(target, p);
      target.removeItem(p);
      return true;
    },
    ownKeys(target) {
      return [...Reflect.ownKeys(target), ...[...map.keys()].filter((k) => !(k in target))];
    },
    getOwnPropertyDescriptor(target, p) {
      if (isNamed(p) && map.has(p)) {
        return { value: map.get(p), writable: true, enumerable: true, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, p);
    },
  }) as unknown as Storage;
  return { storage, contents: () => Object.fromEntries(map) };
}

/**
 * Replace the frame's unusable Web Storage. Returns null (and changes nothing)
 * when native storage works or the window won't let its storage be redefined.
 */
export function installStorageShim(win: Window): StorageShim | null {
  if (nativeStorageAvailable(win)) return null;

  let name = '';
  try {
    name = win.name;
  } catch {
    /* no name, start empty */
  }
  const snapshot = decodeFrameName(name) ?? { local: {}, session: {} };

  let send: StorageSender | null = null;
  const dirty = new Set<StorageArea>();
  let flushScheduled = false;
  const areas = {} as Record<StorageArea, ReturnType<typeof createStorage>>;

  const flush = (): void => {
    flushScheduled = false;
    // Keep the name current too, so an in-frame reload starts from the latest state.
    try {
      win.name = encodeFrameName({ local: areas.local.contents(), session: areas.session.contents() });
    } catch {
      /* the name is a convenience; the parent copy is what persists */
    }
    if (!send) return;
    for (const area of dirty) send(area, areas[area].contents());
    dirty.clear();
  };
  const markDirty = (area: StorageArea): void => {
    dirty.add(area);
    if (flushScheduled) return;
    flushScheduled = true;
    // Coalesce bursts of writes (a settings save touching several keys) into one message.
    Promise.resolve().then(flush);
  };

  areas.local = createStorage(snapshot.local, () => markDirty('local'));
  areas.session = createStorage(snapshot.session, () => markDirty('session'));

  const define = (prop: 'localStorage' | 'sessionStorage', value: Storage): boolean => {
    try {
      Object.defineProperty(win, prop, { value, configurable: true, enumerable: true, writable: false });
      return win[prop] === value;
    } catch {
      return false;
    }
  };
  if (!define('localStorage', areas.local.storage) || !define('sessionStorage', areas.session.storage)) return null;

  return {
    attach(sender) {
      send = sender;
      if (dirty.size > 0) flush();
    },
  };
}
