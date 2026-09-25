/**
 * Server-side Markdown rendering for publishing: agents may hand over
 * Markdown instead of HTML, and the render happens once, at publish time.
 * The result is a self-contained HTML document like any other artifact, so
 * everything downstream — the sandboxed frame, text anchoring, comments,
 * exports — needs no notion of Markdown. The original source is kept on the
 * version (`versions.source_markdown`) for the agent's revise loop.
 */

import { Marked, marked, type RendererObject, type TokenizerAndRendererExtension } from 'marked';

import { mentionLexer, type MentionToken } from '../../shared/mentions.js';

/**
 * Readable defaults in the spirit of the app's own styling (warm paper/ink
 * palette, burnt-orange links); the artifact frame is sandboxed either way.
 * The frame CSP only allows data:/allowlisted fonts, so this sticks to the
 * system font stack rather than the app's webfont.
 */
const ARTICLE_CSS = `
  body {
    margin: 0 auto;
    max-width: 720px;
    padding: 2.5rem 1.5rem;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.6;
    color: oklch(21% 0.008 55);
    background: #ffffff;
  }
  h1, h2, h3, h4 { line-height: 1.25; letter-spacing: -0.02em; margin: 1.75em 0 0.5em; }
  h1:first-child { margin-top: 0; }
  a { color: oklch(50% 0.160 45); }
  pre {
    background: oklch(98.4% 0.004 80);
    border: 1px solid oklch(90% 0.007 75);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    overflow-x: auto;
  }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
  :not(pre) > code { background: oklch(96.2% 0.006 80); border-radius: 4px; padding: 0.1em 0.35em; }
  blockquote { margin: 1em 0; padding: 0.25em 1em; border-left: 3px solid oklch(58% 0.190 45); color: oklch(46% 0.014 58); }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid oklch(90% 0.007 75); padding: 0.4rem 0.75rem; text-align: left; }
  th { background: oklch(98.4% 0.004 80); }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid oklch(90% 0.007 75); margin: 2rem 0; }
`;

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** Renders Markdown (GFM) into a complete, self-contained HTML artifact. */
export function renderMarkdownArtifact(markdown: string, title: string): string {
  const body = marked.parse(markdown, { gfm: true, async: false });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${ARTICLE_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * Inline styles for the tags a comment body can produce: email clients drop
 * or ignore `<style>` blocks unevenly, so every element carries its own. Keys
 * are matched against marked's output only — user-typed HTML is escaped
 * before this runs, so it can never pick up (or smuggle in) a style.
 */
const EMAIL_STYLES: Record<string, string> = {
  p: 'margin:0 0 8px;',
  ul: 'margin:0 0 8px;padding-left:20px;',
  ol: 'margin:0 0 8px;padding-left:20px;',
  li: 'margin:0 0 2px;',
  blockquote: 'margin:0 0 8px;padding:0 0 0 10px;border-left:3px solid #e2dbd1;color:#6f665f;',
  pre: 'margin:0 0 8px;padding:8px 10px;background:#f5f2ed;border-radius:6px;overflow-x:auto;white-space:pre;font-size:13px;',
  code: 'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.92em;background:#f5f2ed;border-radius:3px;padding:1px 4px;',
  table: 'border-collapse:collapse;margin:0 0 8px;font-size:13px;',
  th: 'border:1px solid #e2dbd1;padding:3px 8px;text-align:left;background:#faf8f5;',
  td: 'border:1px solid #e2dbd1;padding:3px 8px;text-align:left;',
  h: 'margin:0 0 8px;font-size:1em;font-weight:600;',
  hr: 'border:none;border-top:1px solid #e2dbd1;margin:10px 0;',
  a: 'color:#c2410c;',
};

const SAFE_HREF = /^(https?:|mailto:)/i;

function emailLink(href: string, inner: string, title?: string | null): string {
  const trimmed = href.trim();
  if (!SAFE_HREF.test(trimmed)) return inner;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(trimmed)}"${titleAttr} style="${EMAIL_STYLES.a}">${inner}</a>`;
}

function styleTags(html: string): string {
  return html
    .replace(/<pre><code(?: class="[^"]*")?>/g, `<pre style="${EMAIL_STYLES.pre}"><code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">`)
    .replace(/<h[1-6]>/g, `<p style="${EMAIL_STYLES.h}">`)
    .replace(/<\/h[1-6]>/g, '</p>')
    .replace(/<(p|ul|ol|li|blockquote|code|table|hr)>/g, (_, tag: string) => `<${tag} style="${EMAIL_STYLES[tag]}">`)
    .replace(/<(th|td)(?: align="(left|center|right)")?>/g, (_, tag: string, align?: string) => {
      const style = align ? EMAIL_STYLES[tag]!.replace('text-align:left;', `text-align:${align};`) : EMAIL_STYLES[tag];
      return `<${tag} style="${style}">`;
    });
}

/**
 * A comment body rendered for a digest email: the same Markdown the sidebar
 * shows (GFM, single newlines kept), with the same limits — raw HTML stays
 * literal text, links must be http(s)/mailto, images become links — and
 * resolved `@email` mentions (keys: lowercased email, values: display name)
 * in bold. Returns an HTML fragment with inline styles.
 */
export function renderCommentEmailHtml(body: string, mentions: ReadonlyMap<string, string>): string {
  const mention: TokenizerAndRendererExtension = {
    ...mentionLexer,
    renderer(token) {
      const { email, raw } = token as unknown as MentionToken;
      const name = mentions.get(email.toLowerCase());
      return name ? `<strong style="color:#c2410c;">@${escapeHtml(name)}</strong>` : escapeHtml(raw);
    },
  };
  const renderer: RendererObject = {
    html({ text, block }) {
      return block ? `<p style="${EMAIL_STYLES.p}white-space:pre-wrap;">${escapeHtml(text.trimEnd())}</p>` : escapeHtml(text);
    },
    link({ href, title, tokens }) {
      return emailLink(href, this.parser.parseInline(tokens), title);
    },
    image({ href, title, text }) {
      return emailLink(href, escapeHtml(text || href), title);
    },
    checkbox({ checked }) {
      return checked ? '&#9745; ' : '&#9744; ';
    },
  };
  const html = new Marked({ gfm: true, breaks: true, extensions: [mention], renderer }).parse(body, { async: false });
  return styleTags(html);
}
