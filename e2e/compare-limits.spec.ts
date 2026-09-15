import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { MAX_DIFF_TEXT_LENGTH, MAX_DIFF_TOKENS } from '../src/shared/diff.js';
import { callTool, extractDocumentId, getArtifactFrame, waitForLoginCode } from './helpers.js';

test.describe('comparison limits', () => {
  let context: BrowserContext;
  let page: Page;
  let pat: string;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto('/signin');
    await page.fill('#email-input', 'owner@compare-limits.test');
    await page.click('#email-form button[type="submit"]');
    await page.fill('#code-input', await waitForLoginCode('owner@compare-limits.test'));
    await page.click('#code-form button[type="submit"]');
    await page.waitForURL('/');
    await page.fill('#wizard-team-name', 'Comparison tests');
    await page.click('#team-wizard button[type="submit"]');
    await expect(page.locator('#team-wizard')).toHaveCount(0);
    await page.goto('/settings/tokens');
    await page.click('form[action="/settings/tokens"] button[type="submit"]');
    pat = (await page.locator('code.token-plaintext').textContent())!.trim();
  });

  test.afterAll(async () => { await context.close(); });

  async function publish(html: string, documentId?: string): Promise<string> {
    const result = await callTool(page.request, pat, 'publish_artifact', { title: 'Comparison limits', html, document_id: documentId });
    expect(result.isError).toBeFalsy();
    return extractDocumentId(result.content[0]!.text);
  }

  async function expectUnavailable(): Promise<void> {
    await expect(page.locator('#compare-unavailable')).toContainText('too large or have too many changes');
    await expect(page.locator('#comments-title')).toHaveText('Comparison unavailable');
    await expect(page.locator('#prev-comment')).toBeDisabled();
    await expect(page.locator('#next-comment')).toBeDisabled();
    await expect(page.locator('.change-card')).toHaveCount(0);
    await expect(page.locator('#compare-pane-old')).toBeHidden();
    await expect(page.locator('#artifact-frame')).toBeVisible();
    await expect(page.locator('#no-highlights-banner')).toBeHidden();
  }

  test('script-generated text disables comparison, clears old highlights and recovers after shrinking', async () => {
    const html = (word: string) => `<p id="content">A ${word} sentence.</p>
      <button id="expand">Expand</button><button id="shrink">Shrink</button>
      <script>
        document.getElementById('expand').onclick = () => {
          document.getElementById('content').textContent = 'word '.repeat(${MAX_DIFF_TOKENS + 1});
        };
        document.getElementById('shrink').onclick = () => {
          document.getElementById('content').textContent = 'A ${word} sentence.';
        };
      </script>`;
    const id = await publish(html('short'));
    await publish(html('changed'), id);
    await page.goto(`/d/${id}?compare=1`);
    await expect(page.locator('.change-card')).toHaveCount(1);
    await page.locator('.change-card').click();
    const newFrame = await getArtifactFrame(page);
    const oldFrame = await (await page.locator('#compare-frame').elementHandle())!.contentFrame();
    await newFrame.locator('#expand').click();
    await expectUnavailable();
    for (const [frame, highlight] of [[newFrame, 'ac-added'], [oldFrame!, 'ac-removed']] as const) {
      await expect.poll(() => frame.evaluate((name) => CSS.highlights.get(name)?.size ?? 0, highlight)).toBe(0);
      await expect.poll(() => frame.evaluate(() => CSS.highlights.get('ac-diff-focused')?.size ?? 0)).toBe(0);
    }
    await page.screenshot({ path: 'test-results/comparison-unavailable.png' });
    await newFrame.locator('#shrink').click();
    await expect(page.locator('#compare-unavailable')).toHaveCount(0);
    await expect(page.locator('#compare-pane-old')).toBeVisible();
    await expect(page.locator('.change-card')).toHaveCount(1);
    await expect(page.locator('#next-comment')).toBeEnabled();
    await expect.poll(() => newFrame.evaluate(() => CSS.highlights.get('ac-added')?.size ?? 0)).toBe(1);

    await newFrame.locator('#expand').click();
    await expectUnavailable();
    await page.getByRole('link', { name: 'View v2 without comparison' }).click();
    await page.waitForURL((url) => url.pathname === `/d/${id}` && url.searchParams.get('version') === '2' && !url.searchParams.has('compare'));
    await expect(page.locator('#compare-frame')).toHaveCount(0);
    await expect(page.frameLocator('#artifact-frame').locator('#content')).toHaveText('A changed sentence.');
  });

  test('an oversized older version is refused; switching to a supported pair restores comparison', async () => {
    const id = await publish(`<p>${'a'.repeat(MAX_DIFF_TEXT_LENGTH + 1)}</p>`);
    await publish('<p>A short version.</p>', id);
    await publish('<p>A revised version.</p>', id);
    await page.goto(`/d/${id}?version=2&compare=1`);
    await expectUnavailable();
    await expect(page.frameLocator('#artifact-frame').locator('p')).toHaveText('A short version.');
    await page.goto(`/d/${id}?compare=2`);
    await expect(page.locator('.change-card')).toHaveCount(1);
    await expect(page.locator('#compare-pane-old')).toBeVisible();
    await expect(page.locator('#compare-unavailable')).toHaveCount(0);
  });

  test('large rewrites are refused even when character and word counts are supported', async () => {
    const words = (prefix: string) => Array.from({ length: 2000 }, (_, i) => `${prefix}${i}`).join(' ');
    const id = await publish(`<p>${words('before')}</p>`);
    await publish(`<p>${words('after')}</p>`, id);
    await page.goto(`/d/${id}?compare=1`);
    await expectUnavailable();
  });
});
