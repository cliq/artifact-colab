import { describe, expect, test } from 'vitest';

import { renderCommentBody } from '../src/client/commentMarkdown.js';

const BOB = { email: 'bob@example.com', name: 'Bob' };

function html(body: string, mentions = [BOB]): string {
  const root = document.createElement('div');
  root.append(...renderCommentBody(body, mentions));
  return root.innerHTML;
}

describe('comment markdown', () => {
  test('renders emphasis, code, lists and keeps single line breaks', () => {
    expect(html('**Done** with `commit 666a` and _tests_\nnext line')).toBe(
      '<p><strong>Done</strong> with <code>commit 666a</code> and <em>tests</em><br>next line</p>',
    );
    expect(html('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(html('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    expect(html('```\nx < y\n```')).toBe('<pre><code>x &lt; y</code></pre>');
  });

  test('raw HTML stays literal text', () => {
    const out = html('<img src=x onerror=alert(1)> hi <b>bold</b>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('links must be http(s) or mailto and open in a new tab; images become links', () => {
    expect(html('[site](https://example.com)')).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">site</a></p>',
    );
    expect(html('[bad](javascript:alert(1))')).toBe('<p>bad</p>');
    expect(html('![shot](https://example.com/a.png)')).toBe(
      '<p><a href="https://example.com/a.png" target="_blank" rel="noopener noreferrer nofollow">shot</a></p>',
    );
  });

  test('resolved mentions become chips; strangers and code stay text', () => {
    expect(html('ping @bob@example.com please')).toBe(
      '<p>ping <span class="mention" title="bob@example.com">@Bob</span> please</p>',
    );
    expect(html('ping @eve@example.com')).not.toContain('class="mention"');
    expect(html('`@bob@example.com`')).toBe('<p><code>@bob@example.com</code></p>');
    expect(html('- **@bob@example.com** check')).toContain('<strong><span class="mention"');
  });

  test('task lists render disabled checkboxes', () => {
    const out = html('- [x] done\n- [ ] todo');
    expect(out).toContain('<input type="checkbox" checked="" disabled=""> done');
    expect(out).toContain('<input type="checkbox" disabled=""> todo');
    expect(out).toContain('done');
  });
});
