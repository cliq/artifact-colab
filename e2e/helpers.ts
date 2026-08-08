/**
 * Shared helpers for the e2e suite: MCP JSON-RPC calls (mirroring
 * test/server/mcp.test.ts's `rpc`/`rpcResult`), reading the dev login-code
 * file, and driving text selection inside the sandboxed artifact frame.
 */

import { readFileSync } from 'node:fs';

import { expect, type APIRequestContext, type Frame, type Page } from '@playwright/test';

export const CODES_FILE = 'test-results/e2e-tmp/codes.log';

/** Read the most recent login code appended for `email` in the dev codes file. */
export function readLoginCode(email: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(CODES_FILE, 'utf8');
  } catch {
    return undefined;
  }
  const lines = contents.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const [lineEmail, code] = lines[i]!.split(' ');
    if (lineEmail === email) return code;
  }
  return undefined;
}

/** Poll the codes file until a code for `email` shows up, then return it. */
export async function waitForLoginCode(email: string): Promise<string> {
  await expect.poll(() => readLoginCode(email), { message: `waiting for login code for ${email}` }).toBeDefined();
  return readLoginCode(email)!;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: unknown;
}

/** Parse an MCP response body, whether it's plain JSON or an SSE stream. */
function parseRpcBody(contentType: string, text: string): JsonRpcResponse {
  if (contentType.includes('text/event-stream')) {
    const dataLines = text.split('\n').filter((l) => l.startsWith('data:'));
    return JSON.parse(dataLines[dataLines.length - 1]!.slice(5)) as JsonRpcResponse;
  }
  return JSON.parse(text) as JsonRpcResponse;
}

let rpcId = 0;

/** Call an MCP tool over POST /mcp with a bearer PAT, returning its CallToolResult. */
export async function callTool(
  request: APIRequestContext,
  pat: string,
  name: string,
  args: unknown,
): Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  const res = await request.post('/mcp', {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${pat}`,
    },
    data: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.ok()).toBeTruthy();
  const contentType = res.headers()['content-type'] ?? '';
  const payload = parseRpcBody(contentType, await res.text());
  expect(payload.error, JSON.stringify(payload.error)).toBeUndefined();
  return payload.result as { isError?: boolean; content: { type: string; text: string }[] };
}

/** Extract the `document_id: <slug>` line publish_artifact's result text always contains. */
export function extractDocumentId(resultText: string): string {
  const match = resultText.match(/document_id: (\S+)/);
  if (!match) throw new Error(`could not find document_id in: ${resultText}`);
  return match[1]!;
}

/** The sandboxed #artifact-frame as a Playwright Frame (supports .evaluate). */
export async function getArtifactFrame(page: Page): Promise<Frame> {
  const handle = await page.locator('#artifact-frame').elementHandle();
  if (!handle) throw new Error('#artifact-frame not found');
  const frame = await handle.contentFrame();
  if (!frame) throw new Error('#artifact-frame has no content frame');
  return frame;
}

/**
 * Select `phrase` (assumed to live entirely inside one text node) inside the
 * frame's document and fire the mouseup the annotator listens for, mirroring
 * a real drag-selection.
 */
export async function selectPhraseInFrame(frame: Frame, phrase: string): Promise<boolean> {
  return frame.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? '';
      const idx = text.indexOf(needle);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needle.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, phrase);
}

/**
 * Bounding rect (frame-viewport-relative) of `phrase`'s first occurrence, or
 * null if the phrase isn't found (e.g. split across nodes/elements).
 */
export async function phraseRectInFrame(
  frame: Frame,
  phrase: string,
): Promise<{ top: number; left: number; width: number; height: number } | null> {
  return frame.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? '';
      const idx = text.indexOf(needle);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needle.length);
        const rect = range.getBoundingClientRect();
        return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      }
    }
    return null;
  }, phrase);
}
