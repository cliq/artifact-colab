import { describe, expect, test } from 'vitest';

import { diffText, wordsAfter, wordsBefore } from '../../src/shared/diff.js';

/** Rebuild the new text from the old one by applying the hunks (whitespace-normalized). */
function apply(oldText: string, newText: string): string {
  let out = '';
  let cursor = 0;
  for (const h of diffText(oldText, newText)) {
    out += oldText.slice(cursor, h.oldStart) + ' ' + newText.slice(h.newStart, h.newEnd) + ' ';
    cursor = h.oldEnd;
  }
  out += oldText.slice(cursor);
  return out.replace(/\s+/g, ' ').trim();
}

describe('diffText', () => {
  test('identical texts produce no hunks', () => {
    expect(diffText('alpha beta gamma', 'alpha beta gamma')).toEqual([]);
  });

  test('a single inserted word is one hunk with an empty old range', () => {
    const oldText = 'Alpha in July, beta in August, GA in September.';
    const newText = 'Alpha in July, beta in late August, GA in September.';
    const hunks = diffText(oldText, newText);
    expect(hunks).toHaveLength(1);
    const h = hunks[0]!;
    expect(h.oldStart).toBe(h.oldEnd);
    expect(oldText.slice(0, h.oldStart)).toBe('Alpha in July, beta in ');
    expect(newText.slice(h.newStart, h.newEnd)).toBe('late');
  });

  test('a removed word is one hunk with an empty new range', () => {
    const oldText = 'keep the legacy exporter alive';
    const newText = 'keep the exporter alive';
    const [h] = diffText(oldText, newText);
    expect(oldText.slice(h!.oldStart, h!.oldEnd)).toBe('legacy');
    expect(h!.newStart).toBe(h!.newEnd);
    expect(newText.slice(0, h!.newStart)).toBe('keep the ');
  });

  test('a replaced passage covers both ranges even when one word survives', () => {
    // "the" is common to both, but two large edits around one word read as one change.
    const oldText = 'Staffing Two engineers rotate off the platform team in August.';
    const newText = 'Open questions Do we keep the legacy exporter alive through Q4?';
    const hunks = diffText(oldText, newText);
    expect(hunks).toHaveLength(1);
    expect(oldText.slice(hunks[0]!.oldStart, hunks[0]!.oldEnd)).toBe(oldText);
    expect(newText.slice(hunks[0]!.newStart, hunks[0]!.newEnd)).toBe(newText);
  });

  test('multiple edits come back in document order with stable ids', () => {
    const oldText = 'one two three four five six seven eight';
    const newText = 'one 2 three four 5 six seven eight nine';
    const hunks = diffText(oldText, newText);
    expect(hunks.map((h) => h.id)).toEqual(['h0', 'h1', 'h2']);
    expect(hunks.map((h) => newText.slice(h.newStart, h.newEnd))).toEqual(['2', '5', 'nine']);
    expect(hunks.map((h) => oldText.slice(h.oldStart, h.oldEnd))).toEqual(['two', 'five', '']);
  });

  test('small edits separated by one word stay separate', () => {
    const hunks = diffText('a b c d e', 'a x c y e');
    expect(hunks).toHaveLength(2);
    for (let i = 1; i < hunks.length; i++) {
      expect(hunks[i]!.oldStart).toBeGreaterThanOrEqual(hunks[i - 1]!.oldEnd);
      expect(hunks[i]!.newStart).toBeGreaterThanOrEqual(hunks[i - 1]!.newEnd);
    }
  });

  test('an appended trailing passage anchors at the end of the old text', () => {
    const oldText = 'rollback at 14:40.';
    const newText = 'rollback at 14:40, all clear at 14:52.';
    const [h] = diffText(oldText, newText);
    expect(oldText.slice(h!.oldStart, h!.oldEnd)).toBe('14:40.');
    expect(newText.slice(h!.newStart, h!.newEnd)).toBe('14:40, all clear at 14:52.');
  });

  test('hunks reconstruct the new text', () => {
    const cases: [string, string][] = [
      ['a b c', 'a c'],
      ['a c', 'a b c'],
      ['', 'brand new text'],
      ['gone entirely', ''],
      ['x y z', 'p q r'],
      ['a b c d e f g', 'g f e d c b a'],
      ['the quick brown fox jumps over the lazy dog', 'the quick red fox leaps over the lazy cat today'],
    ];
    for (const [oldText, newText] of cases) {
      expect(apply(oldText, newText)).toBe(newText);
    }
  });

  test('random token sequences always reconstruct', () => {
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const vocab = ['a', 'b', 'c', 'd', 'e'];
    for (let i = 0; i < 300; i++) {
      const gen = (): string =>
        Array.from({ length: Math.floor(rand() * 30) }, () => vocab[Math.floor(rand() * vocab.length)]!).join(' ');
      const oldText = gen();
      const newText = gen();
      expect(apply(oldText, newText)).toBe(newText.replace(/\s+/g, ' ').trim());
    }
  });

  test('is the minimal script for a shifted sequence', () => {
    const oldText = 'a b c d e f';
    const newText = 'b c d e f a';
    // Moving one token to the end is a delete plus an insert: two hunks, not a rewrite.
    expect(diffText(oldText, newText)).toHaveLength(2);
  });
});

describe('context helpers', () => {
  test('wordsBefore and wordsAfter clip to the requested word count', () => {
    const text = 'Alpha in July, beta in late August, GA in September.';
    const at = text.indexOf('late');
    expect(wordsBefore(text, at, 3)).toBe('July, beta in');
    expect(wordsAfter(text, at + 'late'.length, 2)).toBe('August, GA');
    expect(wordsBefore(text, 0, 3)).toBe('');
    expect(wordsAfter(text, text.length, 3)).toBe('');
  });
});
