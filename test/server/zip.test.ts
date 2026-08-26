import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { buildZip, crc32 } from '../../src/server/services/zip.js';

describe('buildZip', () => {
  test('crc32 matches the reference value for "123456789"', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  test('produces an archive the system unzip can extract, with intact contents', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
    const zip = buildZip(
      [
        { name: 'index.html', data: '<h1>Hello</h1>'.repeat(50) },
        { name: 'assets/pic.png', data: png },
        { name: 'comments.md', data: '# Comments\n\n- ünïcödé' },
      ],
      new Date('2026-08-26T10:20:30Z'),
    );
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
    try {
      writeFileSync(join(dir, 'a.zip'), zip);
      execFileSync('unzip', ['-q', 'a.zip', '-d', 'out'], { cwd: dir });
      expect(readFileSync(join(dir, 'out/index.html'), 'utf8')).toBe('<h1>Hello</h1>'.repeat(50));
      expect(readFileSync(join(dir, 'out/assets/pic.png'))).toEqual(png);
      expect(readFileSync(join(dir, 'out/comments.md'), 'utf8')).toBe('# Comments\n\n- ünïcödé');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
