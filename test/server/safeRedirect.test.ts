/**
 * Unit coverage for the `next`-redirect validator, with an emphasis on the
 * open-redirect payloads a naive string check would let through.
 */

import { describe, expect, test } from 'vitest';

import { safeLocalPath } from '../../src/server/safeRedirect.js';

describe('safeLocalPath', () => {
  test('accepts genuine same-app paths', () => {
    expect(safeLocalPath('/')).toBe('/');
    expect(safeLocalPath('/d/abc123')).toBe('/d/abc123');
    expect(safeLocalPath('/d/abc123?version=2')).toBe('/d/abc123?version=2');
    expect(safeLocalPath('/settings/tokens#section')).toBe('/settings/tokens#section');
  });

  test('rejects absolute and scheme-relative URLs', () => {
    expect(safeLocalPath('https://evil.com')).toBeUndefined();
    expect(safeLocalPath('http://evil.com/path')).toBeUndefined();
    expect(safeLocalPath('//evil.com')).toBeUndefined();
    expect(safeLocalPath('javascript:alert(1)')).toBeUndefined();
  });

  test('rejects backslash and control-character authority tricks', () => {
    // Browsers/WHATWG URL normalize "\" to "/" and strip tab/newline, so each
    // of these resolves to an external origin despite starting with "/".
    expect(safeLocalPath('/\\evil.com')).toBeUndefined();
    expect(safeLocalPath('/\t/evil.com')).toBeUndefined();
    expect(safeLocalPath('/\n/evil.com')).toBeUndefined();
    expect(safeLocalPath('/\\/evil.com')).toBeUndefined();
  });

  test('rejects empty, missing, and non-path input', () => {
    expect(safeLocalPath(undefined)).toBeUndefined();
    expect(safeLocalPath('')).toBeUndefined();
    expect(safeLocalPath('relative/path')).toBeUndefined();
  });
});
