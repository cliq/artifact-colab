import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { callTool, extractDocumentId, waitForLoginCode } from './helpers.js';

test.describe('fit-to-width frame scaling', () => {
  let context: BrowserContext;
  let page: Page;
  let pat: string;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto('/signin');
    await page.fill('#email-input', 'owner@frame-scale.test');
    await page.click('#email-form button[type="submit"]');
    await page.fill('#code-input', await waitForLoginCode('owner@frame-scale.test'));
    await page.click('#code-form button[type="submit"]');
    await page.waitForURL('/');
    await page.fill('#wizard-team-name', 'Frame scale tests');
    await page.click('#team-wizard button[type="submit"]');
    await expect(page.locator('#team-wizard')).toHaveCount(0);
    await page.goto('/settings/tokens');
    await page.click('form[action="/settings/tokens"] button[type="submit"]');
    pat = (await page.locator('code.token-plaintext').textContent())!.trim();
  });

  test.afterAll(async () => { await context.close(); });

  async function publish(html: string): Promise<string> {
    const result = await callTool(page.request, pat, 'publish_artifact', { title: 'Frame scale', html });
    expect(result.isError).toBeFalsy();
    return extractDocumentId(result.content[0]!.text);
  }

  test('a responsive page reflows instead of scaling after the window shrinks', async () => {
    const id = await publish('<main style="max-width:980px;margin:0 auto"><p>Responsive content.</p></main>');
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.goto(`/d/${id}`);
    const frame = page.locator('#artifact-frame');
    await expect(frame).toBeVisible();
    await page.frameLocator('#artifact-frame').locator('main').waitFor();

    await page.setViewportSize({ width: 900, height: 900 });
    // Give the annotator's resize handling time to report a layout.
    await page.waitForTimeout(500);
    await expect(frame).toHaveCSS('transform', 'none');
    const frameBox = (await frame.boundingBox())!;
    const wrapBox = (await page.locator('#frame-wrap').boundingBox())!;
    expect(Math.abs(frameBox.width - wrapBox.width)).toBeLessThan(2);
  });

  test('a page wider than the frame is scaled to fit', async () => {
    const id = await publish('<div style="width:2400px">Fixed-width content.</div>');
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(`/d/${id}`);
    const frame = page.locator('#artifact-frame');
    await expect(frame).not.toHaveCSS('transform', 'none');
    const wrapBox = (await page.locator('#frame-wrap').boundingBox())!;
    const frameBox = (await frame.boundingBox())!;
    expect(Math.abs(frameBox.width - wrapBox.width)).toBeLessThan(2);
  });
});
