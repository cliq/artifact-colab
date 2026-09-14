import { describe, expect, test } from 'vitest';

import { decodeFrameName, encodeFrameName, frameStorageKey, sanitizeContents } from '../../src/shared/frameStorage.js';

describe('frame storage wire format', () => {
  test('round-trips both areas through the frame name', () => {
    const name = encodeFrameName({ local: { theme: 'dark', 'a:b': '{"x":1}' }, session: { tab: '2' } });
    expect(decodeFrameName(name)).toEqual({ local: { theme: 'dark', 'a:b': '{"x":1}' }, session: { tab: '2' } });
  });

  test('a name the artifact set for itself, or garbage after the prefix, is not a snapshot', () => {
    expect(decodeFrameName('')).toBeNull();
    expect(decodeFrameName('my-frame')).toBeNull();
    expect(decodeFrameName('{"local":{}}')).toBeNull();
    expect(decodeFrameName('artifact-storage:not json')).toBeNull();
    expect(decodeFrameName('artifact-storage:null')).toBeNull();
    expect(decodeFrameName('artifact-storage:[]')).toEqual({ local: {}, session: {} });
  });

  test('only string values survive; a missing area is empty', () => {
    expect(sanitizeContents({ ok: 'yes', n: 1, o: {}, nil: null })).toEqual({ ok: 'yes' });
    expect(sanitizeContents(['a'])).toEqual({});
    expect(decodeFrameName('artifact-storage:{"local":{"k":"v","bad":3}}')).toEqual({ local: { k: 'v' }, session: {} });
  });

  test('the viewer keys storage per document', () => {
    expect(frameStorageKey('abc123')).toBe('artifact-storage:abc123');
    expect(frameStorageKey('abc123')).not.toBe(frameStorageKey('abc124'));
  });
});
