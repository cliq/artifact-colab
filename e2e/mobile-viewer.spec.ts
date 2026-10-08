/**
 * Mobile reading view: compact top bar, comments bottom sheet, and (below)
 * touch selection that hands a quote to the composer explicitly.
 */

import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';

import { callTool, extractDocumentId, getArtifactFrame, selectPhraseInFrame, waitForLoginCode } from './helpers.js';

/** Native selection only, as a touch drag would leave it: no mouseup is dispatched. */
async function selectNative(frame: Frame, phrase: string): Promise<void> {
  await frame.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const idx = (node.textContent ?? '').indexOf(needle);
      if (idx === -1) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + needle.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    throw new Error(`phrase not found: ${needle}`);
  }, phrase);
}

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

  test('Tab wraps inside the open sheet', async () => {
    await openPhone();
    await page.locator('#mobile-comments').click();
    await expect(page.locator('#close-sheet')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    const inSheet = await page.evaluate(() => document.getElementById('comments-sidebar')!.contains(document.activeElement));
    expect(inSheet).toBe(true);
    await page.keyboard.press('Escape');
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

  test.describe('touch selection', () => {
    test('a selection offers Comment on selection without opening the sheet', async () => {
      await openPhone();
      const frame = await getArtifactFrame(page);
      await selectNative(frame, 'quick brown');
      await expect(page.locator('#mobile-selection')).toBeVisible();
      await expect(page.locator('#mobile-comments')).toBeHidden();
      await selectNative(frame, 'quick brown fox');
      await expect(page.locator('#mobile-selection')).toBeVisible();
      await expect(page.locator('#comments-sidebar')).toBeHidden();
      await frame.evaluate(() => window.getSelection()?.removeAllRanges());
      await expect(page.locator('#mobile-comments')).toBeVisible();
      await expect(page.locator('#mobile-selection')).toBeHidden();
    });

    test('the action keeps the quote after the frame selection clears, and saves it', async () => {
      await openPhone();
      const frame = await getArtifactFrame(page);
      await selectNative(frame, 'second paragraph');
      await selectNative(frame, 'brown fox jumps');
      await expect(page.locator('#mobile-selection')).toBeVisible();
      await page.locator('#mobile-selection').click();
      await frame.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.waitForTimeout(400);
      const composer = page.locator('#ac-composer');
      await expect(composer).toBeVisible();
      await expect(composer.locator('.thread-quote')).toHaveText('brown fox jumps');
      await expect(composer.locator('textarea')).toBeFocused();
      await composer.locator('textarea').fill('Touch comment.');
      await composer.locator('button', { hasText: 'Save' }).click();
      const card = page.locator('.thread-card', { hasText: 'Touch comment.' });
      await expect(card).toBeVisible();
      await expect(card.locator('.thread-quote')).toHaveText('brown fox jumps');

      await page.reload();
      await page.frameLocator('#artifact-frame').locator('body').waitFor();
      await page.locator('#mobile-comments').click();
      await expect(page.locator('.thread-card', { hasText: 'Touch comment.' })).toBeVisible();
      await expect(page.locator('.thread-card:not(.stub)', { hasText: 'Touch comment.' }).locator('.badge-orphaned')).toHaveCount(0);
    });

    test('a draft survives closing the sheet and Cancel discards it', async () => {
      await openPhone();
      const frame = await getArtifactFrame(page);
      await selectNative(frame, 'second paragraph');
      await page.locator('#mobile-selection').click();
      await page.locator('#ac-composer textarea').fill('unsent draft');
      await frame.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.locator('#close-sheet').click();
      await expect(page.locator('#comments-sidebar')).toBeHidden();
      await page.locator('#mobile-comments').click();
      await expect(page.locator('#ac-composer .thread-quote')).toHaveText('second paragraph');
      await expect(page.locator('#ac-composer textarea')).toHaveValue('unsent draft');
      await page.locator('#ac-composer button', { hasText: 'Cancel' }).click();
      await expect(page.locator('#ac-composer')).toBeHidden();
    });

    test('a selection cleared on desktop width is not offered after returning to the phone', async () => {
      await openPhone();
      const frame = await getArtifactFrame(page);
      await selectNative(frame, 'quick brown');
      await expect(page.locator('#mobile-selection')).toBeVisible();
      await page.setViewportSize(DESKTOP);
      await frame.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.waitForTimeout(400);
      await page.setViewportSize(PHONE);
      await expect(page.locator('#mobile-selection')).toBeHidden();
      await expect(page.locator('#mobile-comments')).toBeVisible();
    });

    test('old versions offer no comment action', async () => {
      await openPhone(`/d/${slug}?version=1`);
      await selectNative(await getArtifactFrame(page), 'quick brown');
      await page.waitForTimeout(500);
      await expect(page.locator('#mobile-selection')).toBeHidden();
    });

    test('desktop mouse selection still opens the composer', async () => {
      await page.setViewportSize(DESKTOP);
      await page.goto(`/d/${slug}`);
      await page.frameLocator('#artifact-frame').locator('#p1').waitFor();
      expect(await selectPhraseInFrame(await getArtifactFrame(page), 'fox jumps')).toBe(true);
      await expect(page.locator('#ac-composer .thread-quote')).toHaveText('fox jumps');
    });
  });
});
