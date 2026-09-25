/**
 * Comment bodies as Markdown (GFM, single newlines kept as line breaks), so
 * agents can post lists, code and emphasis and people can too. The body is
 * lexed with marked and the DOM is built from the tokens directly — never via
 * innerHTML — so only a small allowlist of elements can appear: raw HTML in a
 * body stays literal text, links must be http(s)/mailto, and images show as
 * links instead of loading. `@email` mentions are an inline token of their
 * own, painted as chips when the email belongs to a resolved mention.
 */

import { Marked, type Token, type Tokens, type TokenizerAndRendererExtension } from 'marked';

import { mentionLexer, type MentionToken } from '../shared/mentions.js';
import type { MentionDTO } from './mentions.js';

// Only the lexer is used; the DOM builder below renders mention tokens.
const mentionExtension: TokenizerAndRendererExtension = { ...mentionLexer, renderer: () => false };

const markdown = new Marked({ gfm: true, breaks: true, extensions: [mentionExtension] });

const SAFE_HREF = /^(https?:|mailto:)/i;

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return SAFE_HREF.test(trimmed) ? trimmed : null;
}

type Mentions = ReadonlyMap<string, MentionDTO>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.append(...children);
  return node;
}

function link(href: string, children: (Node | string)[], title?: string | null): Node | (Node | string)[] {
  const safe = safeHref(href);
  if (!safe) return children;
  const a = h('a', children);
  a.href = safe;
  a.target = '_blank';
  a.rel = 'noopener noreferrer nofollow';
  if (title) a.title = title;
  return a;
}

function inline(tokens: Token[] | undefined, mentions: Mentions): (Node | string)[] {
  const out: (Node | string)[] = [];
  for (const token of tokens ?? []) {
    const rendered = inlineToken(token, mentions);
    if (Array.isArray(rendered)) out.push(...rendered);
    else out.push(rendered);
  }
  return out;
}

function inlineToken(token: Token, mentions: Mentions): Node | string | (Node | string)[] {
  switch (token.type) {
    case 'mention': {
      const { email, raw } = token as unknown as MentionToken;
      const mention = mentions.get(email.toLowerCase());
      if (!mention) return raw;
      const chip = h('span', [`@${mention.name ?? mention.email}`]);
      chip.className = 'mention';
      chip.title = mention.email;
      return chip;
    }
    case 'strong':
      return h('strong', inline((token as Tokens.Strong).tokens, mentions));
    case 'em':
      return h('em', inline((token as Tokens.Em).tokens, mentions));
    case 'del':
      return h('del', inline((token as Tokens.Del).tokens, mentions));
    case 'codespan':
      return h('code', [(token as Tokens.Codespan).text]);
    case 'br':
      return h('br');
    case 'link': {
      const t = token as Tokens.Link;
      return link(t.href, inline(t.tokens, mentions), t.title);
    }
    case 'image': {
      // No remote loads from comments: show the alt text as a link to the image.
      const t = token as Tokens.Image;
      return link(t.href, [t.text || t.href], t.title);
    }
    case 'text': {
      const t = token as Tokens.Text;
      return t.tokens ? inline(t.tokens, mentions) : t.text;
    }
    case 'escape':
      return (token as Tokens.Escape).text;
    default:
      // Raw HTML and anything unrecognized stay literal text.
      return token.raw;
  }
}

function blocks(tokens: Token[], mentions: Mentions): Node[] {
  const out: Node[] = [];
  for (const token of tokens) {
    const node = blockToken(token, mentions);
    if (node) out.push(node);
  }
  return out;
}

function blockToken(token: Token, mentions: Mentions): Node | null {
  switch (token.type) {
    case 'space':
    case 'def':
      return null;
    case 'paragraph':
      return h('p', inline((token as Tokens.Paragraph).tokens, mentions));
    case 'heading': {
      // Sidebar-sized: every level renders as a bold paragraph-sized heading.
      const t = token as Tokens.Heading;
      const heading = h('p', inline(t.tokens, mentions));
      heading.className = 'md-heading';
      return heading;
    }
    case 'code': {
      const code = h('code', [(token as Tokens.Code).text]);
      return h('pre', [code]);
    }
    case 'blockquote':
      return h('blockquote', blocks((token as Tokens.Blockquote).tokens, mentions));
    case 'hr':
      return h('hr');
    case 'list': {
      const t = token as Tokens.List;
      const list = t.ordered ? h('ol') : h('ul');
      if (t.ordered && typeof t.start === 'number' && t.start !== 1) (list as HTMLOListElement).start = t.start;
      for (const item of t.items) list.appendChild(listItem(item, t.loose, mentions));
      return list;
    }
    case 'table': {
      const t = token as Tokens.Table;
      const cell = (c: Tokens.TableCell, tag: 'th' | 'td'): HTMLElement => {
        const node = h(tag, inline(c.tokens, mentions));
        if (c.align) node.style.textAlign = c.align;
        return node;
      };
      const table = h('table', [
        h('thead', [h('tr', t.header.map((c) => cell(c, 'th')))]),
        h('tbody', t.rows.map((row) => h('tr', row.map((c) => cell(c, 'td'))))),
      ]);
      const wrap = h('div', [table]);
      wrap.className = 'md-table';
      return wrap;
    }
    case 'text': {
      // Tight list items hold block-level text tokens with inline children.
      const t = token as Tokens.Text;
      const span = h('span', t.tokens ? inline(t.tokens, mentions) : [t.text]);
      return span;
    }
    default:
      return h('p', [token.raw]);
  }
}

function listItem(item: Tokens.ListItem, loose: boolean, mentions: Mentions): HTMLLIElement {
  const li = h('li');
  if (item.task) {
    const box = h('input');
    box.type = 'checkbox';
    box.defaultChecked = !!item.checked;
    box.disabled = true;
    li.append(box, ' ');
    li.className = 'md-task';
  }
  // marked emits a checkbox token ahead of a task item's content; the box is drawn above.
  const content = item.tokens.filter((t) => t.type !== 'checkbox');
  for (const token of content) {
    if (!loose && token.type === 'text') {
      const t = token as Tokens.Text;
      li.append(...(t.tokens ? inline(t.tokens, mentions) : [t.text]));
    } else {
      const node = blockToken(token, mentions);
      if (node) li.appendChild(node);
    }
  }
  return li;
}

/** The comment body rendered from Markdown, with resolved `@email` mentions as chips. */
export function renderCommentBody(body: string, mentions: MentionDTO[]): Node[] {
  const byEmail = new Map(mentions.map((m) => [m.email.toLowerCase(), m]));
  return blocks(markdown.lexer(body), byEmail);
}

export const COMMENT_MARKDOWN_CSS = `
.md-body > :first-child { margin-top: 0; }
.md-body > :last-child { margin-bottom: 0; }
.md-body p, .md-body ul, .md-body ol, .md-body pre, .md-body blockquote, .md-body .md-table { margin: 0 0 6px; }
.md-body ul, .md-body ol { padding-left: 18px; }
.md-body li > p { margin: 0; }
.md-body li.md-task { list-style: none; margin-left: -18px; }
.md-body .md-heading { font-weight: 600; }
.md-body code { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 0.92em; background: var(--color-paper-2); border-radius: 3px; padding: 0 3px; }
.md-body pre { background: var(--color-paper-2); border-radius: var(--radius-sm); padding: 6px 8px; overflow-x: auto; white-space: pre; }
.md-body pre code { background: none; padding: 0; }
.md-body blockquote { padding-left: 8px; border-left: 2px solid var(--color-border); color: var(--color-muted); }
.md-body a { color: var(--color-accent); }
.md-body hr { border: none; border-top: 1px solid var(--color-border); margin: 8px 0; }
.md-body .md-table { overflow-x: auto; }
.md-body table { border-collapse: collapse; font-size: 0.95em; }
.md-body th, .md-body td { border: 1px solid var(--color-border); padding: 2px 6px; text-align: left; }
`;
