import { describe, expect, test } from 'vitest';

import { relinkAssets, stripBaseHref } from '../../src/server/services/assets.js';
import type { Asset } from '../../src/server/db/schema.js';

const asset = (name: string): Asset => ({ id: name, documentId: 'doc', name, mime: 'image/png', data: Buffer.alloc(0), createdAt: new Date() });

describe('relinkAssets', () => {
  test('rewrites src, CSS url() and Markdown image references to assets/', () => {
    const html = `<img src="a.png"/><img src='b.png' alt=x><div style="background:url(c.png);border-image:url('a.png')"></div>`;
    expect(relinkAssets(html, [asset('a.png'), asset('b.png'), asset('c.png')])).toBe(
      `<img src="assets/a.png"/><img src='assets/b.png' alt=x><div style="background:url(assets/c.png);border-image:url('assets/a.png')"></div>`,
    );
    expect(relinkAssets('![chart](shots/chart.png) and [dl](shots/chart.png "t")', [asset('shots/chart.png')])).toBe(
      '![chart](assets/shots/chart.png) and [dl](assets/shots/chart.png "t")',
    );
  });

  test('does not cascade when one asset name is a prefixed form of another', () => {
    const docAssets = [asset('logo.png'), asset('assets/logo.png')];
    const html = `<img src="logo.png"><img src="assets/logo.png">`;
    const expected = `<img src="assets/logo.png"><img src="assets/assets/logo.png">`;
    expect(relinkAssets(html, docAssets)).toBe(expected);
    expect(relinkAssets(html, [...docAssets].reverse())).toBe(expected);
  });

  test('leaves unrelated and partially matching references alone', () => {
    const html = `<img src="other.png"><img src="a.png.bak"><a href="a.png">x</a>`;
    expect(relinkAssets(html, [asset('a.png')])).toBe(html);
  });
});

describe('stripBaseHref', () => {
  test('removes base elements so relative asset links resolve beside index.html', () => {
    expect(stripBaseHref(`<head><BASE href="https://cdn.example/" target="_blank"><title>t</title></head>`)).toBe('<head><title>t</title></head>');
  });
});
