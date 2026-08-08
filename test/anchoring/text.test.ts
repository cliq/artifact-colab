import { describe, expect, test } from 'vitest';
import { normalizeString } from '../../src/anchoring/normalize.js';
import { describeTextAnchor, locateTextAnchor } from '../../src/anchoring/text.js';

/**
 * Marker DSL: fixtures are strings with the quote marked as [[...]].
 * `before` describes where the anchor is created; `after` marks where it is
 * expected to relocate. An `after` without markers asserts an orphan.
 */
function parseMarked(s: string): { text: string; start: number; end: number } {
  const start = s.indexOf('[[');
  const close = s.indexOf(']]');
  if (start === -1 || close === -1 || close < start) {
    throw new Error(`fixture has no [[...]] markers: ${s}`);
  }
  return { text: s.replace('[[', '').replace(']]', ''), start, end: close - 2 };
}

function relocate(before: string, after: string) {
  const b = parseMarked(before);
  const anchor = describeTextAnchor(b.text, b.start, b.end);
  if (!after.includes('[[')) {
    expect(locateTextAnchor(after, anchor)).toBeNull();
    return null;
  }
  const a = parseMarked(after);
  const res = locateTextAnchor(a.text, anchor);
  expect(res, `anchor "${anchor.exact}" should relocate`).not.toBeNull();
  expect(res!.start).toBe(a.start);
  expect(res!.end).toBe(a.end);
  return res!;
}

// Deterministic PRNG so the random-slice suite is reproducible.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const SAMPLE_DOC = normalizeString(`
  Quarterly Report: Revenue grew 14% year over year, driven primarily by the
  enterprise segment. Churn declined to 2.1%, the lowest since 2023. The board
  approved a new hiring plan covering engineering, design, and support roles.
  Risks include currency exposure in LATAM markets and a pending vendor
  migration. Next steps: finalize the Q3 budget, ship the onboarding redesign,
  and complete the SOC 2 audit by the end of September.
`);

describe('describeTextAnchor', () => {
  test('captures exact, context, and position', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const start = text.indexOf('brown fox');
    const a = describeTextAnchor(text, start, start + 'brown fox'.length);
    expect(a.exact).toBe('brown fox');
    expect(a.prefix).toBe('The quick ');
    expect(a.suffix).toBe(' jumps over the lazy dog.');
    expect(a.start).toBe(start);
    expect(a.docLength).toBe(text.length);
    expect(a.v).toBe(1);
  });

  test('grows context beyond 32 chars until unique', () => {
    // Two occurrences whose surrounding 32 chars are identical; only farther
    // context (section names ~60 chars away) differentiates them.
    const pad = 'x'.repeat(40);
    const text = `SECTION ALPHA ${pad} the result was [[positive]] overall ${pad} SECTION BETA ${pad} the result was positive overall ${pad} end.`;
    const { text: t, start, end } = parseMarked(text);
    const a = describeTextAnchor(t, start, end);
    expect(a.prefix.length).toBeGreaterThan(32);
    expect(t.indexOf(a.prefix + a.exact + a.suffix)).toBe(t.lastIndexOf(a.prefix + a.exact + a.suffix));
  });

  test('clamps context at document boundaries', () => {
    const text = 'short doc here';
    const a = describeTextAnchor(text, 0, 5);
    expect(a.prefix).toBe('');
    expect(a.suffix).toBe(' doc here');
  });

  test('rejects invalid ranges', () => {
    expect(() => describeTextAnchor('abc', 2, 2)).toThrow(RangeError);
    expect(() => describeTextAnchor('abc', -1, 2)).toThrow(RangeError);
    expect(() => describeTextAnchor('abc', 0, 4)).toThrow(RangeError);
  });
});

describe('locateTextAnchor round-trip identity', () => {
  test('random slices relocate to themselves via the fast path', () => {
    const rand = lcg(42);
    for (let i = 0; i < 200; i++) {
      const start = Math.floor(rand() * (SAMPLE_DOC.length - 2));
      const len = 1 + Math.floor(rand() * Math.min(80, SAMPLE_DOC.length - start - 1));
      const end = start + len;
      const anchor = describeTextAnchor(SAMPLE_DOC, start, end);
      const res = locateTextAnchor(SAMPLE_DOC, anchor);
      expect(res).not.toBeNull();
      expect(res!.start).toBe(start);
      expect(res!.end).toBe(end);
      expect(res!.score).toBe(1);
      expect(res!.ambiguous).toBe(false);
    }
  });
});

describe('locateTextAnchor across edits', () => {
  test('survives an edit before the quote', () => {
    const res = relocate(
      'Alpha bravo charlie. The [[quick brown fox]] jumps over the lazy dog.',
      'Brand new opening sentence. Alpha bravo charlie. The [[quick brown fox]] jumps over the lazy dog.',
    );
    expect(res!.ambiguous).toBe(false);
  });

  test('survives an edit after the quote', () => {
    relocate(
      'The [[quick brown fox]] jumps over the lazy dog. Closing remarks here.',
      'The [[quick brown fox]] jumps over the lazy dog. Entirely different ending, much longer than before it was.',
    );
  });

  test('survives edits on both sides', () => {
    relocate(
      'Intro paragraph with context. The [[key finding]] stands in the middle. Outro text follows.',
      'Rewritten intro, new words. The [[key finding]] stands in the middle. Also a rewritten outro.',
    );
  });

  test('quote deleted → orphan (null)', () => {
    relocate(
      'Keep this part. Remove [[the doomed sentence]] from the document. Keep this too.',
      'Keep this part. Keep this too.',
    );
  });

  test('orphan is stateless: quote restored in a later version relocates again', () => {
    const b = parseMarked('Alpha. The [[special note]] applies. Omega.');
    const anchor = describeTextAnchor(b.text, b.start, b.end);
    expect(locateTextAnchor('Alpha. Omega.', anchor)).toBeNull();
    const v3 = 'Alpha. The special note applies. Omega.';
    const res = locateTextAnchor(v3, anchor);
    expect(res).not.toBeNull();
    expect(v3.slice(res!.start, res!.end)).toBe('special note');
  });
});

describe('locateTextAnchor with duplicates', () => {
  test('picks the original when a copy appears earlier (original now second)', () => {
    const res = relocate(
      'Alpha section intro. In conclusion, the [[final measurement]] was recorded at noon.',
      'Summary: the final measurement is pending review. Alpha section intro. In conclusion, the [[final measurement]] was recorded at noon.',
    );
    expect(res!.ambiguous).toBe(false);
  });

  test('anchor created on occurrence #2 relocates to occurrence #2', () => {
    relocate(
      'First mention of the target phrase in the alpha section. Later, the [[target phrase]] appears again in the beta section.',
      'A completely new introduction. First mention of the target phrase in the alpha section. Later, the [[target phrase]] appears again in the beta section.',
    );
  });

  test('identical-context duplicate → first occurrence, flagged ambiguous', () => {
    const res = relocate(
      'Header one. The [[magic phrase]] appears here in context.',
      'Intro. Header one. The [[magic phrase]] appears here in context. Header one. The magic phrase appears here in context.',
    );
    expect(res!.ambiguous).toBe(true);
  });

  test('short quote among many identical ones resolves by context', () => {
    relocate(
      'Row alpha: Yes. Row bravo: No. Row charlie: [[Yes]]. Row delta: Yes. Row echo: No.',
      'Row alpha: Yes. Row alpha-two: No. Row bravo: No. Row charlie: [[Yes]]. Row delta: Yes. Row echo: No.',
    );
  });
});

describe('locateTextAnchor robustness', () => {
  test('stale start far beyond text.length does not crash (doc shrank 10x)', () => {
    const before = `${'Filler sentence with padding words. '.repeat(40)}The [[rare conclusion]] ends the report.`;
    const b = parseMarked(before);
    const anchor = describeTextAnchor(b.text, b.start, b.end);
    expect(anchor.start).toBeGreaterThan(1000);

    const shrunk = 'Tiny doc. The rare conclusion ends the report.';
    const res = locateTextAnchor(shrunk, anchor);
    expect(res).not.toBeNull();
    expect(shrunk.slice(res!.start, res!.end)).toBe('rare conclusion');

    expect(locateTextAnchor('Tiny doc without the quote.', anchor)).toBeNull();
  });

  test('empty exact never matches', () => {
    const anchor = { v: 1 as const, exact: '', prefix: 'a', suffix: 'b', start: 0, docLength: 10 };
    expect(locateTextAnchor('anything', anchor)).toBeNull();
  });

  test('doc-start quote (empty prefix) relocates', () => {
    relocate(
      '[[Opening words]] then the rest of the document follows here.',
      '[[Opening words]] then the rest of the document follows here, now with an appended tail.',
    );
  });

  test('doc-end quote (empty suffix) relocates', () => {
    relocate(
      'The document begins here and ends with the [[final words]]',
      'A fresh start. The document begins here and ends with the [[final words]]',
    );
  });
});

describe('normalizeString', () => {
  test('collapses whitespace runs and trims ends', () => {
    expect(normalizeString('  a \t\n b   c  ')).toBe('a b c');
  });

  test('folds NBSP and narrow NBSP to plain space', () => {
    expect(normalizeString('a b c')).toBe('a b c');
  });

  test('drops zero-width and soft-hyphen characters', () => {
    expect(normalizeString('so\u00ADft ze\u200Bro bo\uFEFFm')).toBe('soft zero bom');
  });

  test('folds curly quotes and apostrophes to straight', () => {
    expect(normalizeString('‘a’ “b” it’s')).toBe(`'a' "b" it's`);
  });

  test('does not fold ellipsis or apply NFC (1:1 invariant)', () => {
    expect(normalizeString('a…b')).toBe('a…b');
    expect(normalizeString('café')).toBe('café');
  });
});
