/**
 * Mobile reading view: compact top bar, comments bottom sheet, and (below)
 * touch selection that hands a quote to the composer explicitly.
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { callTool, extractDocumentId, getArtifactFrame, selectPhraseInFrame, waitForLoginCode } from './helpers.js';

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const EMAIL = 'owner@mobile-viewer.test';
const HTML =
  '<!doctype html><html><body><h1>Mobile fixture</h1>' +
  '<p id="p1">The quick brown fox jumps over the lazy dog near the riverbank.</p>' +
  '<p id="p2">A second paragraph gives the selection tests more text to adjust.</p>' +
  '<div style="height:2000px"></div></body></html>';

test.describe('mobile reading view', () => {
  let context: BrowserContext;
  let page: Page;
  let pat: string;
  let slug: string;
  const COMMENT = 'Mobile sheet comment body.';

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto('/signin');
    await page.fill('#email-input', EMAIL);
    await page.click('#email-form button[type="submit"]');
    await page.fill('#code-input', await waitForLoginCode(EMAIL));
    await page.click('#code-form button[type="submit"]');
    await page.waitForURL('/');
    await page.fill('#wizard-team-name', 'Mobile viewer tests');
    await page.click('#team-wizard button[type="submit"]');
    await expect(page.locator('#team-wizard')).toHaveCount(0);
    await page.goto('/settings/tokens');
    await page.click('form[action="/settings/tokens"] button[type="submit"]');
    pat = (await page.locator('code.token-plaintext').textContent())!.trim();

    const result = await callTool(page.request, pat, 'publish_artifact', { title: 'Mobile fixture', html: HTML });
    slug = extractDocumentId(result.content[0]!.text);

    // One comment, made through the desktop UI.
    await page.setViewportSize(DESKTOP);
    await page.goto(`/d/${slug}`);
    await page.frameLocator('#artifact-frame').locator('#p1').waitFor();
    expect(await selectPhraseInFrame(await getArtifactFrame(page), 'lazy dog')).toBe(true);
    await page.locator('#ac-composer textarea').fill(COMMENT);
    await page.locator('#ac-composer button', { hasText: 'Save' }).click();
    await expect(page.locator('.thread-card', { hasText: COMMENT })).toBeVisible();
  });

  test.afterAll(async () => {
    await context.close();
  });

  async function openPhone(url = `/d/${slug}`): Promise<void> {
    await page.setViewportSize(PHONE);
    await page.goto(url);
    await page.frameLocator('#artifact-frame').locator('body').waitFor();
  }

  test('reading view gives the artifact the whole screen', async () => {
    await openPhone();
    await expect(page.locator('header.site-header')).toBeHidden();
    await expect(page.locator('.viewer-toolbar')).toBeHidden();
    await expect(page.locator('#expand-sidebar')).toBeHidden();
    await expect(page.locator('#mobile-bar')).toBeVisible();
    await expect(page.locator('#mobile-comments')).toBeVisible();
    await expect(page.locator('#mobile-layout')).toHaveText('Full layout');
    const frame = (await page.locator('#artifact-frame').boundingBox())!;
    expect(frame.y).toBeLessThan(60);
    expect(Math.abs(frame.width - PHONE.width)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
  });

  test('Full layout and Reading view toggle without reloading the artifact', async () => {
    await openPhone();
    const frame = await getArtifactFrame(page);
    await frame.evaluate(() => {
      (window as unknown as { marker: string }).marker = 'kept';
    });
    await page.locator('#mobile-layout').click();
    await expect(page.locator('header.site-header')).toBeVisible();
    await expect(page.locator('.viewer-toolbar')).toBeVisible();
    await expect(page.locator('#mobile-layout')).toHaveText('Reading view');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
    await page.locator('#mobile-layout').click();
    await expect(page.locator('header.site-header')).toBeHidden();
    expect(await (await getArtifactFrame(page)).evaluate(() => (window as unknown as { marker?: string }).marker)).toBe('kept');
  });

  test('comments open in a bottom sheet that closes and keeps drafts', async () => {
    await openPhone();
    const sheet = page.locator('#comments-sidebar');
    await expect(sheet).toBeHidden();
    await page.locator('#mobile-comments').click();
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('role', 'dialog');
    const card = page.locator('.thread-card', { hasText: COMMENT });
    await expect(card).toBeVisible();
    // Normal flow, not desktop absolute alignment.
    await expect(card).toHaveCSS('position', 'static');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

    await card.locator('textarea[data-reply-for]').fill('half-written reply');
    await page.locator('#close-sheet').click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('#mobile-comments')).toBeFocused();
    await page.locator('#mobile-comments').click();
    await expect(page.locator('textarea[data-reply-for]').first()).toHaveValue('half-written reply');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('desktop sidebar preference survives crossing the breakpoint', async () => {
    await openPhone();
    await page.evaluate(() => localStorage.setItem('artifact-colab:comments-collapsed', '1'));
    await page.reload();
    await page.frameLocator('#artifact-frame').locator('body').waitFor();
    await page.locator('#mobile-comments').click();
    await expect(page.locator('.thread-card', { hasText: COMMENT })).toBeVisible();
    await page.locator('#close-sheet').click();

    await page.setViewportSize(DESKTOP);
    await expect(page.locator('#comments-sidebar')).toHaveClass(/collapsed/);
    await expect(page.locator('#expand-sidebar')).toBeVisible();
    await page.locator('#expand-sidebar').click();
    const card = page.locator('.thread-card', { hasText: COMMENT });
    await expect(card).toBeVisible();
    await expect(card).toHaveCSS('position', 'absolute');
    await page.evaluate(() => localStorage.removeItem('artifact-colab:comments-collapsed'));
  });

  test('older versions show their version in the compact bar; comparison offers Changes', async () => {
    const v2 = await callTool(page.request, pat, 'publish_artifact', {
      title: 'Mobile fixture',
      html: HTML.replace('riverbank', 'harbour'),
      document_id: slug,
    });
    expect(v2.isError).toBeFalsy();

    await openPhone(`/d/${slug}?version=1`);
    await expect(page.locator('#mobile-bar .mobile-bar-version')).toContainText('v1');
    await expect(page.locator('#mobile-selection')).toBeHidden();

    await openPhone(`/d/${slug}?version=2&compare=1`);
    await expect(page.locator('#mobile-comments')).toContainText('Changes');
    await page.locator('#mobile-comments').click();
    await expect(page.locator('#comments-sidebar')).toBeVisible();
    await expect(page.locator('#comments-title')).toContainText('Changes');
    await expect(page.locator('#ac-composer')).toHaveCount(0);
  });
});
