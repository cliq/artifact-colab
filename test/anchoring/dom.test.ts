import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { parseHTML } from 'linkedom';
import { describe, expect, test } from 'vitest';
import { describeAnchor, locateAnchor } from '../../src/anchoring/anchor.js';
import {
  buildTextIndex,
  domRangeToTextRange,
  domToTextOffset,
  textOffsetToDom,
  textRangeToDomRange,
  type TextIndex,
} from '../../src/anchoring/index.js';
import { normalizeString } from '../../src/anchoring/normalize.js';
import { describeTextAnchor, locateTextAnchor } from '../../src/anchoring/text.js';

const FIXTURES = [
  'dashboard-v1.html',
  'dashboard-v2.html',
  'report-v1.html',
  'report-v2.html',
  'chart-v1.html',
  'chart-v2.html',
  'react-style-v1.html',
  'react-style-v2.html',
] as const;

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'test/fixtures', name), 'utf8');
}

/** Parse with linkedom (server-side path) and index the whole document. */
function indexHtml(html: string): TextIndex {
  const { document } = parseHTML(html);
  return buildTextIndex(document as unknown as Node);
}

/**
 * Parse with happy-dom (browser-side path in tests). A fresh Window is used
 * because Ranges on DOMParser-created documents misbehave in happy-dom.
 */
function browserDoc(html: string): Document {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as Document;
}

function indexHtmlBrowser(html: string): TextIndex {
  return buildTextIndex(browserDoc(html));
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('normalizer regression suite', () => {
  const textOf = (html: string) => indexHtml(`<body>${html}</body>`).text;

  test('inline wrapping does not change text', () => {
    expect(textOf('<p>very <strong>important</strong> note</p>')).toBe(textOf('<p>very important note</p>'));
  });

  test('<br> produces the same separator as a space', () => {
    expect(textOf('<p>a<br>b</p>')).toBe(textOf('<p>a b</p>'));
  });

  test('&nbsp; equals a plain space', () => {
    expect(textOf('<p>a&nbsp;b</p>')).toBe(textOf('<p>a b</p>'));
  });

  test('merged paragraphs yield the same text as one paragraph', () => {
    expect(textOf('<p>one</p><p>two</p>')).toBe(textOf('<p>one two</p>'));
  });

  test('<span> split mid-word does not introduce a space', () => {
    expect(textOf('<p>hyper<span>link</span>ed</p>')).toBe('hyperlinked');
  });

  test('curly apostrophes fold to straight', () => {
    expect(textOf('<p>it’s “fine”</p>')).toBe(`it's "fine"`);
  });

  test('cross-block boundary yields exactly one space', () => {
    expect(textOf('<div><p>end of one.</p><p>Start of two.</p></div>')).toBe('end of one. Start of two.');
  });

  test('table cells are separated', () => {
    expect(textOf('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>')).toBe('a b c');
  });

  test('<pre> whitespace is collapsed too', () => {
    expect(textOf('<pre>a\n   b\n</pre>')).toBe('a b');
  });

  test('script/style/comment/attribute text never matches', () => {
    const ix = indexHtml(
      `<body>
        <script>const x = 'SECRET';</script>
        <style>.a::before { content: 'SECRET'; }</style>
        <!-- SECRET -->
        <p title="SECRET">visible text</p>
        <template><p>SECRET</p></template>
        <noscript>SECRET</noscript>
      </body>`,
    );
    expect(ix.text).toBe('visible text');
  });

  test('[hidden] and aria-hidden subtrees are excluded', () => {
    expect(textOf('<p>shown</p><p hidden>SECRET</p><div aria-hidden="true">SECRET</div>')).toBe('shown');
  });

  test('fragment-style artifacts (no <html> wrapper) are fully indexed', () => {
    // linkedom's documentElement for a fragment is just the FIRST element —
    // regression test for anchors orphaning because only <style> was walked.
    const ix = indexHtml('<style>.a{color:red}</style>\n<main><p>Written for the whole team.</p></main><footer>end note</footer>');
    expect(ix.text).toBe('Written for the whole team. end note');
  });

  test('entities round-trip through parsing and folding', () => {
    // &#8217; is a curly apostrophe → folds to straight; &amp; stays literal.
    expect(textOf('<p>Q&amp;A it&#8217;s</p>')).toBe(`Q&A it's`);
  });

  test('zero-width and soft-hyphen characters are dropped', () => {
    expect(textOf('<p>so­ft ze​ro</p>')).toBe('soft zero');
  });
});

describe('offset mapping identity (the big one)', () => {
  for (const name of FIXTURES) {
    test(`domToTextOffset ∘ textOffsetToDom === id for every offset in ${name}`, () => {
      const ix = indexHtml(fixture(name));
      // react-style fixtures render most content via JS; only static text
      // (one paragraph) is indexable, so the floor is low.
      expect(ix.text.length).toBeGreaterThan(40);
      for (let i = 0; i <= ix.text.length; i++) {
        const pos = textOffsetToDom(ix, i);
        expect(domToTextOffset(ix, pos.node, pos.offset)).toBe(i);
      }
    });
  }
});

describe('index snapshots', () => {
  for (const name of FIXTURES) {
    test(`normalized text of ${name}`, () => {
      expect(indexHtml(fixture(name)).text).toMatchSnapshot();
    });
  }
});

describe('happy-dom cross-check', () => {
  for (const name of ['dashboard-v1.html', 'report-v1.html'] as const) {
    test(`linkedom and happy-dom produce identical normalized text for ${name}`, () => {
      const html = fixture(name);
      expect(indexHtmlBrowser(html).text).toBe(indexHtml(html).text);
    });
  }
});

describe('Range materialization (happy-dom)', () => {
  const HTML = `<body><p>The “quick” brown&nbsp;fox — it’s <strong>really</strong> quite fast, honestly.</p></body>`;

  test('toString of materialized ranges matches the normalized slice', () => {
    const ix = indexHtmlBrowser(HTML);
    const rand = lcg(7);
    for (let i = 0; i < 100; i++) {
      let s = Math.floor(rand() * ix.text.length);
      let e = s + 1 + Math.floor(rand() * (ix.text.length - s - 1 || 1));
      // Snap to content characters (skip gap spaces) for a clean comparison.
      while (s < e && ix.text[s] === ' ') s++;
      while (e > s && ix.text[e - 1] === ' ') e--;
      if (s >= e) continue;
      const range = textRangeToDomRange(ix, s, e);
      expect(range).not.toBeNull();
      expect(normalizeString(range!.toString())).toBe(ix.text.slice(s, e));
    }
  });

  test('dom→text→dom round-trip over fixtures', () => {
    for (const name of ['report-v1.html', 'dashboard-v1.html'] as const) {
      const ix = indexHtmlBrowser(fixture(name));
      const rand = lcg(13);
      for (let i = 0; i < 100; i++) {
        let s = Math.floor(rand() * ix.text.length);
        let e = s + 1 + Math.floor(rand() * Math.min(120, ix.text.length - s - 1 || 1));
        while (s < e && ix.text[s] === ' ') s++;
        while (e > s && ix.text[e - 1] === ' ') e--;
        if (s >= e) continue;
        const range = textRangeToDomRange(ix, s, e);
        expect(range).not.toBeNull();
        const back = domRangeToTextRange(ix, range!);
        expect(back).toEqual({ start: s, end: e });
      }
    }
  });

  test('empty or gap-only ranges yield null', () => {
    const ix = indexHtmlBrowser(HTML);
    expect(textRangeToDomRange(ix, 3, 3)).toBeNull();
    const gap = ix.text.indexOf(' ');
    expect(textRangeToDomRange(ix, gap, gap + 1)).toBeNull();
  });
});

describe('describeAnchor selection normalization (happy-dom)', () => {
  const docOf = browserDoc;

  test('trims selection whitespace into context (double-click trailing space)', () => {
    const doc = docOf('<body><p>pick the word here</p></body>');
    const textNode = doc.querySelector('p')!.firstChild as Text;
    const range = doc.createRange();
    range.setStart(textNode, 5); // 'the w' → starts at 'the'
    range.setEnd(textNode, 9); // includes the trailing space: 'the '
    const anchor = describeAnchor(doc, range);
    expect(anchor).not.toBeNull();
    expect(anchor!.exact).toBe('the');
  });

  test('triple-click style range ending at the next block start', () => {
    const doc = docOf('<body><p>first paragraph text</p><p>second paragraph</p></body>');
    const p1 = doc.querySelectorAll('p')[0]!;
    const p2 = doc.querySelectorAll('p')[1]!;
    const range = doc.createRange();
    range.setStart(p1.firstChild as Text, 0);
    range.setEnd(p2, 0); // element-boundary endpoint, offset 0 of next block
    const anchor = describeAnchor(doc, range);
    expect(anchor).not.toBeNull();
    expect(anchor!.exact).toBe('first paragraph text');
  });

  test('whitespace-only selection yields null', () => {
    const doc = docOf('<body><p>a</p><p>b</p></body>');
    const ix = buildTextIndex(doc);
    const gap = ix.text.indexOf(' ');
    const range = textRangeToDomRange(ix, gap, gap + 1);
    // Range over only the gap is already null; simulate via element boundaries.
    expect(range).toBeNull();
  });

  test('locateAnchor returns a live Range over the located quote', () => {
    const doc = docOf('<body><p>alpha beta gamma delta</p></body>');
    const ix = buildTextIndex(doc);
    const start = ix.text.indexOf('beta gamma');
    const anchor = describeTextAnchor(ix.text, start, start + 'beta gamma'.length);
    const range = locateAnchor(doc, anchor);
    expect(range).not.toBeNull();
    expect(normalizeString(range!.toString())).toBe('beta gamma');
  });
});

describe('element-container offsets', () => {
  test('resolve to first text position at/after the boundary', () => {
    const { document } = parseHTML('<body><ul><li>one</li><li>two</li></ul><p>after</p></body>');
    const doc = document as unknown as Document;
    const ix = buildTextIndex(doc);
    expect(ix.text).toBe('one two after');
    const ul = doc.querySelector('ul')!;
    expect(domToTextOffset(ix, ul, 0)).toBe(0); // before first <li>
    expect(domToTextOffset(ix, ul, 1)).toBe(ix.text.indexOf('two')); // before second <li>
    expect(domToTextOffset(ix, ul, 2)).toBe(ix.text.indexOf('after')); // end of <ul>
    const body = doc.querySelector('body')!;
    expect(domToTextOffset(ix, body, body.childNodes.length)).toBe(ix.text.length);
  });
});

describe('cross-version relocation on fixtures', () => {
  function relocateAcross(v1: string, v2: string, quote: string): ReturnType<typeof locateTextAnchor> {
    const ix1 = indexHtml(fixture(v1));
    const start = ix1.text.indexOf(quote);
    expect(start, `quote must exist in ${v1}: "${quote}"`).toBeGreaterThanOrEqual(0);
    const anchor = describeTextAnchor(ix1.text, start, start + quote.length);
    const ix2 = indexHtml(fixture(v2));
    return locateTextAnchor(ix2.text, anchor);
  }

  test('dashboard: summary sentence survives the revision', () => {
    const quote = 'Enterprise revenue grew 14% year over year, driven by seat expansion.';
    const res = relocateAcross('dashboard-v1.html', 'dashboard-v2.html', quote);
    expect(res).not.toBeNull();
    const ix2 = indexHtml(fixture('dashboard-v2.html'));
    expect(ix2.text.slice(res!.start, res!.end)).toBe(quote);
  });

  test('dashboard: deleted cell orphans', () => {
    expect(relocateAcross('dashboard-v1.html', 'dashboard-v2.html', 'Churn declined to 2.1%')).toBeNull();
  });

  test('report: moved sentence relocates (curly apostrophe normalized)', () => {
    const quote = "The team's velocity improved after the migration.";
    const res = relocateAcross('report-v1.html', 'report-v2.html', quote);
    expect(res).not.toBeNull();
  });

  test('chart: edited caption orphans', () => {
    expect(
      relocateAcross('chart-v1.html', 'chart-v2.html', 'Figure 1: Weekly active users, Jan–Jun.'),
    ).toBeNull();
  });

  test('react-style: static sentence survives', () => {
    const quote = 'All estimates assume a two-week sprint cadence.';
    expect(relocateAcross('react-style-v1.html', 'react-style-v2.html', quote)).not.toBeNull();
  });

  test('prettier-reflowed markup relocates as a no-op', () => {
    const compact = '<body><div><p>Alpha beta gamma.</p><p>Delta <em>epsilon</em> zeta.</p></div></body>';
    const reflowed = `<body>
  <div>
    <p>
      Alpha beta gamma.
    </p>
    <p>
      Delta <em>epsilon</em> zeta.
    </p>
  </div>
</body>`;
    const ix1 = indexHtml(compact);
    const ix2 = indexHtml(reflowed);
    expect(ix2.text).toBe(ix1.text);
    const start = ix1.text.indexOf('Delta epsilon');
    const anchor = describeTextAnchor(ix1.text, start, start + 'Delta epsilon'.length);
    const res = locateTextAnchor(ix2.text, anchor);
    expect(res).toEqual({ start, end: start + 'Delta epsilon'.length, score: 1, ambiguous: false });
  });
});
