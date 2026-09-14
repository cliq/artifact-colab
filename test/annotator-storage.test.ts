import { describe, expect, test, vi } from 'vitest';

import { installStorageShim } from '../src/annotator/storage.js';
import { decodeFrameName, encodeFrameName } from '../src/shared/frameStorage.js';

/** A window whose storage is off limits, as in the sandboxed artifact frame. */
function opaqueWindow(name = ''): Window {
  const win = { name } as unknown as Window;
  for (const prop of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(win, prop, {
      configurable: true,
      enumerable: true,
      get() {
        throw new DOMException("The document is sandboxed and lacks the 'allow-same-origin' flag.", 'SecurityError');
      },
    });
  }
  return win;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('storage shim', () => {
  test('leaves a window whose storage works alone', () => {
    const win = { name: '', localStorage: {}, sessionStorage: {} } as unknown as Window;
    const before = win.localStorage;
    expect(installStorageShim(win)).toBeNull();
    expect(win.localStorage).toBe(before);
  });

  test('replaces unusable storage with one primed from the frame name', () => {
    const win = opaqueWindow(encodeFrameName({ local: { theme: 'dark' }, session: { step: '3' } }));
    expect(installStorageShim(win)).not.toBeNull();
    expect(win.localStorage.getItem('theme')).toBe('dark');
    expect(win.sessionStorage.getItem('step')).toBe('3');
    expect(win.localStorage.getItem('step')).toBeNull();
    expect(win.localStorage.length).toBe(1);
    expect(win.localStorage.key(0)).toBe('theme');
    expect(win.localStorage.key(1)).toBeNull();
  });

  test('starts empty without a snapshot and behaves like Web Storage', () => {
    const win = opaqueWindow('some-artifact-name');
    installStorageShim(win);
    const ls = win.localStorage;
    expect(ls.getItem('missing')).toBeNull();
    ls.setItem('n', 1 as unknown as string);
    expect(ls.getItem('n')).toBe('1'); // values are stringified
    ls.setItem('obj', JSON.stringify({ a: 1 }));
    expect(JSON.parse(ls.getItem('obj')!)).toEqual({ a: 1 });
    ls.removeItem('n');
    expect(ls.getItem('n')).toBeNull();
    expect(ls.length).toBe(1);
    ls.clear();
    expect(ls.length).toBe(0);
  });

  test('supports named property access like the real interface', () => {
    const win = opaqueWindow();
    installStorageShim(win);
    const ls = win.localStorage as Storage & Record<string, unknown>;
    ls['theme'] = 'light';
    expect(ls.getItem('theme')).toBe('light');
    expect(ls['theme']).toBe('light');
    expect('theme' in ls).toBe(true);
    expect(Object.keys(ls)).toContain('theme');
    delete ls['theme'];
    expect(ls.getItem('theme')).toBeNull();
    // Interface members are never mistaken for stored keys.
    expect(typeof ls.getItem).toBe('function');
    expect(ls.getItem('getItem')).toBeNull();
  });

  test('reports each changed area once per burst, and only once a sender is attached', async () => {
    const win = opaqueWindow(encodeFrameName({ local: { keep: 'me' }, session: {} }));
    const shim = installStorageShim(win)!;
    win.localStorage.setItem('a', '1');
    win.localStorage.setItem('b', '2');
    win.sessionStorage.setItem('s', 'x');
    await flush();

    const send = vi.fn();
    shim.attach(send);
    // Changes made before attach are delivered right away.
    expect(send.mock.calls).toEqual([
      ['local', { keep: 'me', a: '1', b: '2' }],
      ['session', { s: 'x' }],
    ]);

    send.mockClear();
    win.localStorage.removeItem('a');
    win.localStorage.setItem('c', '3');
    expect(send).not.toHaveBeenCalled(); // coalesced until the microtask
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('local', { keep: 'me', b: '2', c: '3' });

    send.mockClear();
    win.sessionStorage.removeItem('nope'); // no-op removals do not report
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  test('keeps the frame name current so an in-frame reload starts from the latest state', async () => {
    const win = opaqueWindow(encodeFrameName({ local: { v: '1' }, session: {} }));
    installStorageShim(win);
    win.localStorage.setItem('v', '2');
    await flush();
    expect(decodeFrameName(win.name)).toEqual({ local: { v: '2' }, session: {} });
  });
});
