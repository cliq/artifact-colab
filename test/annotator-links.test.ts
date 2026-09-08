import { describe, expect, test } from 'vitest';
import { installExternalLinks } from '../src/annotator/links.js';

installExternalLinks(document);

function activate(href: string, event = 'click'): HTMLAnchorElement {
  document.body.innerHTML = '<a target="_self" rel="nofollow"><span>Link</span></a>';
  const link = document.querySelector('a')!;
  link.setAttribute('href', href);
  link.firstElementChild!.dispatchEvent(new MouseEvent(event, { bubbles: true }));
  return link;
}

describe('artifact links', () => {
  test.each(['click', 'auxclick', 'contextmenu'])('prepares dynamic external links on %s', (event) => {
    const link = activate('https://example.com/page', event);
    expect(link.target).toBe('_blank');
    expect(link.rel.split(' ')).toEqual(expect.arrayContaining(['nofollow', 'noopener', 'noreferrer']));
  });

  test.each(['#section', 'mailto:hello@example.com', 'tel:+123456789'])('preserves %s links', (href) => {
    expect(activate(href).target).toBe('_self');
  });
});
