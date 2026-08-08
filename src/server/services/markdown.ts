/**
 * Server-side Markdown rendering for publishing: agents may hand over
 * Markdown instead of HTML, and the render happens once, at publish time.
 * The result is a self-contained HTML document like any other artifact, so
 * everything downstream — the sandboxed frame, text anchoring, comments,
 * exports — needs no notion of Markdown. The original source is kept on the
 * version (`versions.source_markdown`) for the agent's revise loop.
 */

import { marked } from 'marked';

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

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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
