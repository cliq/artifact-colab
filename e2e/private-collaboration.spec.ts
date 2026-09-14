/** Browser coverage for the private artifact collaboration lifecycle. */
import { readFileSync } from 'node:fs';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { callTool, extractDocumentId, getArtifactFrame, selectPhraseInFrame, waitForLoginCode } from './helpers.js';

const OWNER = 'private-owner@example.com';
const VIEWER = 'private-viewer@example.com';
const EMAILS_FILE = 'test-results/e2e-tmp/emails.log';
const SOURCE = '<!doctype html><html><body><h1>Private draft</h1><p>A sentence only invited people should see.</p></body></html>';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/signin');
  await page.fill('#email-input', email);
  await page.click('#email-form button[type="submit"]');
  const code = await waitForLoginCode(email);
  await page.fill('#code-input', code);
  await page.click('#code-form button[type="submit"]');
  await page.waitForURL((url) => url.pathname !== '/signin');
}

function latestInvitationLink(email: string): string | undefined {
  let contents = '';
  try {
    contents = readFileSync(EMAILS_FILE, 'utf8');
  } catch {
    return undefined;
  }
  const messages = contents.trim().split('\n').filter(Boolean).reverse();
  for (const line of messages) {
    const message = JSON.parse(line) as { to: string; text: string };
    if (message.to !== email) continue;
    const match = message.text.match(/http:\/\/localhost:3789(\/invitations\/[^\s]+)/);
    if (match) return match[1];
  }
  return undefined;
}

test.describe.configure({ mode: 'serial' });

test.describe('private collaboration', () => {
  let ownerContext: BrowserContext;
  let viewerContext: BrowserContext;
  let ownerPage: Page;
  let viewerPage: Page;
  let slug = '';

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    ownerContext = await browser.newContext();
    viewerContext = await browser.newContext();
    ownerPage = await ownerContext.newPage();
    viewerPage = await viewerContext.newPage();

    await signIn(ownerPage, OWNER);
    await ownerPage.fill('#wizard-team-name', 'Private collaboration team');
    await ownerPage.click('#team-wizard button[type="submit"]');
    await ownerPage.waitForURL('/');

    await ownerPage.goto('/settings/tokens');
    await ownerPage.click('form[action="/settings/tokens"] button[type="submit"]');
    const pat = (await ownerPage.locator('code.token-plaintext').textContent())!.trim();
    const published = await callTool(ownerPage.request, pat, 'publish_artifact', { title: 'Private collaboration fixture', html: SOURCE });
    slug = extractDocumentId(published.content[0]!.text);
  });

  test.afterAll(async () => {
    await ownerContext.close();
    await viewerContext.close();
  });

  test('owner makes the artifact private and sends a Viewer invitation', async () => {
    await ownerPage.goto(`/d/${slug}?share=1`);
    const share = ownerPage.locator('details.share-menu');
    await expect(share).toHaveAttribute('open', '');
    await share.locator('.share-option', { hasText: 'Private' }).click();
    await expect(share.locator('summary')).toHaveText('Private');

    await ownerPage.fill('#invite-email-entry', `@${VIEWER}`);
    await ownerPage.click('#add-invite-email');
    await expect(ownerPage.locator('.invite-chip')).toContainText(VIEWER);
    await expect(ownerPage.locator('.invite-chip select')).toHaveValue('viewer');
    await ownerPage.click('#send-invitations');
    await expect(ownerPage.locator('#invite-feedback')).toHaveText('Invitations sent.');
    await expect(ownerPage.locator('#access-list')).toContainText('pending · viewer · sent');
    await expect.poll(() => latestInvitationLink(VIEWER)).toBeDefined();
  });

  test('invitee signs up, explicitly accepts, and gets a read-only viewer', async () => {
    const invitation = latestInvitationLink(VIEWER)!;
    await viewerPage.goto(invitation);
    await viewerPage.getByRole('link', { name: 'Sign in to continue' }).click();
    await viewerPage.fill('#email-input', VIEWER);
    await viewerPage.click('#email-form button[type="submit"]');
    const code = await waitForLoginCode(VIEWER);
    await viewerPage.fill('#code-input', code);
    await viewerPage.click('#code-form button[type="submit"]');
    await expect(viewerPage.getByRole('heading', { name: 'Accept artifact invitation' })).toBeVisible();
    await viewerPage.getByRole('button', { name: 'Accept invitation' }).click();
    await viewerPage.waitForURL((url) => url.pathname === `/d/${slug}`);

    await expect(viewerPage.locator('main h1')).toHaveText('Private collaboration fixture');
    await viewerPage.goto('/');
    await expect(viewerPage.getByRole('heading', { name: 'Shared with you' })).toBeVisible();
    await expect(viewerPage.locator(`a[href="/d/${slug}"]`)).toHaveText('Private collaboration fixture');
    await viewerPage.goto(`/d/${slug}`);
    await viewerPage.locator('details.share-menu summary').click();
    await expect(viewerPage.locator('.role-note')).toContainText('viewer');
    await expect(viewerPage.locator('#request-edit-permission')).toBeVisible();
    await expect(viewerPage.locator('.upload-menu')).toHaveCount(0);

    const frame = await getArtifactFrame(viewerPage);
    await selectPhraseInFrame(frame, 'A sentence only invited people should see.');
    await expect(viewerPage.locator('#ac-composer')).toHaveCount(0);
    await expect(viewerPage.locator('.reply-form, .thread-actions, .reaction-add')).toHaveCount(0);
  });

  test('viewer requests edit access and owner upgrades them', async () => {
    await viewerPage.click('#request-edit-permission');
    await expect(viewerPage.locator('#request-edit-feedback')).toHaveText('The owner has been emailed.');
    await expect.poll(() => {
      try {
        return readFileSync(EMAILS_FILE, 'utf8').includes(`${VIEWER} requested Editor access`);
      } catch {
        return false;
      }
    }).toBe(true);

    await ownerPage.goto(`/d/${slug}?share=1`);
    const role = ownerPage.locator(`select[aria-label="Role for ${VIEWER}"]`);
    await expect(role).toHaveValue('viewer');
    await role.selectOption('editor');
    await expect(ownerPage.locator('#invite-feedback')).toContainText('now an Editor');
  });

  test('editor uploads a new version, then loses write access after downgrade', async () => {
    await viewerPage.goto(`/d/${slug}`);
    const upload = viewerPage.locator('details.upload-menu');
    await expect(upload).toBeVisible();
    await upload.locator('summary').click();
    await viewerPage.locator('#version-content').setInputFiles({
      name: 'revision.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Revised privately\n\nUploaded by the invited editor.'),
    });
    await Promise.all([
      viewerPage.waitForNavigation(),
      viewerPage.locator('#version-upload-form button[type="submit"]').click(),
    ]);
    await expect(viewerPage.locator('#version-picker')).toHaveText('v2');

    await ownerPage.goto(`/d/${slug}?share=1`);
    await ownerPage.locator(`select[aria-label="Role for ${VIEWER}"]`).selectOption('viewer');
    await expect(ownerPage.locator('#invite-feedback')).toContainText('now a Viewer');
    await viewerPage.reload();
    await expect(viewerPage.locator('.upload-menu')).toHaveCount(0);
    await viewerPage.locator('details.share-menu summary').click();
    await expect(viewerPage.locator('#request-edit-permission')).toBeVisible();
  });

  test('owner revokes access and the private artifact disappears for the former viewer', async () => {
    await ownerPage.goto(`/d/${slug}?share=1`);
    const row = ownerPage.locator('.access-row', { hasText: VIEWER });
    await row.getByRole('button', { name: 'Revoke' }).click();
    await expect(ownerPage.locator('#invite-feedback')).toContainText('Access revoked');
    const response = await viewerPage.goto(`/d/${slug}`);
    expect(response?.status()).toBe(404);
  });
});
