/**
 * Self sign-up end to end (the server runs with SELF_SIGNUP=true, see
 * start-server.sh): a fresh company-domain user signs up with the emailed
 * code, creates a team through the first-run wizard claiming their domain for
 * auto-join, and a second user on the same domain then signs up and lands
 * directly in that team with no wizard.
 */

import { expect, test, type Page } from '@playwright/test';

import { waitForLoginCode } from './helpers.js';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/signin');
  await page.fill('#email-input', email);
  await page.click('#email-form button[type="submit"]');
  await expect(page.locator('#code-form')).toBeVisible();
  const code = await waitForLoginCode(email);
  await page.fill('#code-input', code);
  await page.click('#code-form button[type="submit"]');
  await page.waitForURL((url) => url.pathname === '/');
}

test.describe('self sign-up', () => {
  test('the sign-in page offers account creation', async ({ page }) => {
    await page.goto('/signin');
    await expect(page.locator('h1')).toHaveText('Sign in or create an account');
  });

  test('founder signs up, claims the domain; a colleague auto-joins with no wizard', async ({ browser }) => {
    const FOUNDER = 'founder@example-co.com';
    const COLLEAGUE = 'colleague@example-co.com';

    const founderContext = await browser.newContext();
    const founderPage = await founderContext.newPage();
    await signIn(founderPage, FOUNDER);

    // Zero teams → the wizard, with the domain-claim choice for example-co.com.
    const wizard = founderPage.locator('#team-wizard');
    await expect(wizard).toBeVisible();
    await wizard.locator('#wizard-team-name').fill('Example Co');
    await wizard.locator('input[name="claimDomain"][value="true"]').check();
    await wizard.locator('button[type="submit"]').click();

    // The creator lands on their documents as team admin.
    await founderPage.waitForURL((url) => url.pathname === '/');
    await expect(founderPage.locator('a', { hasText: 'Team settings' })).toBeVisible();
    await expect(founderPage.locator('#team-wizard')).toHaveCount(0);
    await founderContext.close();

    // A colleague on the claimed domain signs up and is auto-joined silently.
    const colleagueContext = await browser.newContext();
    const colleaguePage = await colleagueContext.newPage();
    await signIn(colleaguePage, COLLEAGUE);
    await expect(colleaguePage.locator('#team-wizard')).toHaveCount(0);
    await expect(colleaguePage.locator('h1')).toHaveText('Documents');
    // Members (not admins) get no Team settings link; they're inside Example Co.
    await expect(colleaguePage.locator('main')).toContainText('Nothing published yet.');
    await colleagueContext.close();
  });
});
