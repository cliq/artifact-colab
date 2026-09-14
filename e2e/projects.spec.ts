import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { callTool, extractDocumentId, waitForLoginCode } from './helpers.js';

async function signIn(page: Page, email: string) {
  await page.goto('/signin');
  await page.fill('#email-input', email);
  await page.click('#email-form button[type="submit"]');
  await page.fill('#code-input', await waitForLoginCode(email));
  await page.click('#code-form button[type="submit"]');
  await page.waitForURL((url) => url.pathname !== '/signin');
}

test.describe('Projects', () => {
  test.describe.configure({ mode: 'serial' });
  let ownerContext: BrowserContext;
  let memberContext: BrowserContext;
  let owner: Page;
  let member: Page;
  let pat: string;
  let artifactId: string;
  let launchId: string;
  let brandId: string;
  let memberProjectId: string;

  test.beforeAll(async ({ browser }) => {
    ownerContext = await browser.newContext();
    memberContext = await browser.newContext();
    owner = await ownerContext.newPage();
    member = await memberContext.newPage();
    await signIn(owner, 'owner@projects-e2e.test');
    await owner.fill('#wizard-team-name', 'Projects test team');
    await owner.locator('input[name="claimDomain"][value="true"]').check();
    await owner.click('#team-wizard button[type="submit"]');
    await owner.waitForURL('/');
    await owner.goto('/settings/tokens');
    await owner.click('form[action="/settings/tokens"] button[type="submit"]');
    pat = (await owner.locator('code.token-plaintext').textContent())!.trim();
    const result = await callTool(owner.request, pat, 'publish_artifact', { title: 'Launch brief', html: '<p>A launch brief for the team.</p>', project: 'Website launch' });
    expect(result.isError).toBeFalsy();
    artifactId = extractDocumentId(result.content[0]!.text);
    const metadata = await (await owner.request.get(`/api/docs/${artifactId}`)).json();
    launchId = metadata.document.project.id;
    for (const [title, project] of [['Private launch budget', 'Website launch'], ['Secret acquisition', 'Confidential work']]) {
      const published = await callTool(owner.request, pat, 'publish_artifact', { title, html: '<p>Private source.</p>', visibility: 'private', project });
      expect(published.isError).toBeFalsy();
    }
    await signIn(member, 'member@projects-e2e.test');
  });

  test.afterAll(async () => { await ownerContext.close(); await memberContext.close(); });

  test('Folder view hides inaccessible Projects and counts only readable artifacts', async () => {
    await member.goto('/?view=folders');
    await expect(member.getByRole('link', { name: 'Website launch', exact: true })).toBeVisible();
    await expect(member.getByRole('link', { name: 'Confidential work', exact: true })).toHaveCount(0);
    const row = member.locator('.project-row', { hasText: 'Website launch' });
    await expect(row.locator('td').nth(1)).toHaveText('1');
    await member.getByRole('link', { name: 'Website launch', exact: true }).click();
    await expect(member.getByRole('link', { name: 'Launch brief', exact: true })).toBeVisible();
    await expect(member.getByRole('link', { name: 'Private launch budget', exact: true })).toHaveCount(0);
    await owner.goto('/?view=folders');
    await expect(owner.getByRole('link', { name: 'Confidential work', exact: true })).toBeVisible();
    await owner.screenshot({ path: 'test-results/projects-folders.png', fullPage: true });
  });

  test('Tag view keeps a flat list, links to Projects, and survives reload', async () => {
    await owner.getByRole('link', { name: 'Tags', exact: true }).click();
    await expect(owner.getByRole('link', { name: 'Launch brief', exact: true })).toBeVisible();
    await expect(owner.locator('.project-row')).toHaveCount(0);
    await expect(owner.locator('.project-tag', { hasText: 'Website launch' })).toHaveCount(2);
    await owner.goto('/');
    await expect(owner.getByRole('link', { name: 'Tags', exact: true })).toHaveAttribute('aria-current', 'page');
    await owner.screenshot({ path: 'test-results/projects-tags.png', fullPage: true });
    await owner.locator('.project-tag', { hasText: 'Website launch' }).first().click();
    await expect(owner.locator('main h1')).toHaveText('Website launch');
    await owner.getByRole('link', { name: 'Documents', exact: true }).click();
    await expect(owner.getByRole('link', { name: 'Tags', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  test('create and rename an empty Project using keyboard controls', async () => {
    await owner.getByRole('button', { name: 'New project', exact: true }).focus();
    await owner.keyboard.press('Enter');
    const dialog = owner.locator('dialog[open]');
    await expect(dialog.getByLabel('Project name')).toBeFocused();
    await dialog.getByLabel('Project name').fill('New project');
    await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
    await owner.waitForURL((url) => url.pathname.startsWith('/p/'));
    brandId = new URL(owner.url()).pathname.split('/').pop()!;
    await expect(owner.getByText('This project is empty.', { exact: true })).toBeVisible();
    await owner.locator('.project-menu summary').click();
    await owner.getByRole('button', { name: 'Rename project', exact: true }).click();
    await owner.locator('dialog[open]').getByLabel('Project name').fill('Brand refresh');
    await owner.locator('dialog[open]').getByRole('button', { name: 'Rename project', exact: true }).click();
    await expect(owner.locator('main h1')).toHaveText('Brand refresh');
    expect(new URL(owner.url()).pathname).toBe(`/p/${brandId}`);
    await expect(owner.locator('#project-feedback')).toHaveText('Project renamed.');
  });

  test('move from the artifact viewer without changing content or version', async () => {
    await owner.goto(`/d/${artifactId}`);
    await owner.locator('summary').filter({ hasText: /^More$/ }).click();
    await owner.getByRole('button', { name: 'Move to project', exact: true }).click();
    const dialog = owner.locator('dialog[open]');
    await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue('Website launch');
    await dialog.getByLabel('Project', { exact: true }).selectOption({ label: 'Brand refresh' });
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(owner.locator('#project-feedback')).toHaveText('Artifact moved.');
    expect(new URL(owner.url()).pathname).toBe(`/d/${artifactId}`);
    const metadata = await (await owner.request.get(`/api/docs/${artifactId}`)).json();
    expect(metadata.document.project.name).toBe('Brand refresh');
    expect(metadata.versions).toHaveLength(1);
    await owner.goto('/?view=tags');
    const row = owner.locator('tr', { has: owner.getByRole('link', { name: 'Launch brief', exact: true }) });
    await expect(row.locator('.project-tag')).toHaveText('Brand refresh');
    expect((await member.request.get(`/p/${launchId}`)).status()).toBe(404);
  });

  test('create-and-move from a Project returns safely when its last readable artifact leaves', async () => {
    expect((await callTool(owner.request, pat, 'move_artifact', { document_id: artifactId, project: 'Website launch' })).isError).toBeFalsy();
    await member.goto(`/p/${launchId}?view=tags`);
    await member.locator(`[data-move-to-project][data-document-id="${artifactId}"]`).click();
    const dialog = member.locator('dialog[open]');
    await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue('Website launch');
    await dialog.getByRole('button', { name: 'New project', exact: true }).click();
    await dialog.getByLabel('Project name').fill('Member destination');
    await dialog.getByRole('button', { name: 'Create and move', exact: true }).click();
    await member.waitForURL('/?view=tags');
    await expect(member.locator('#project-feedback')).toHaveText('Project created and artifact moved.');
    const metadata = await (await member.request.get(`/api/docs/${artifactId}`)).json();
    memberProjectId = metadata.document.project.id;
    await expect(member.locator('.project-tag', { hasText: 'Member destination' })).toBeVisible();
    expect((await member.request.get(`/p/${launchId}`)).status()).toBe(404);
  });

  test('delete confirmation preserves the artifact and unfiles it in Tag view', async () => {
    await member.goto(`/p/${memberProjectId}`);
    await member.locator('.project-menu summary').click();
    member.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Artifacts and their sharing settings will be kept.');
      await dialog.accept();
    });
    await member.getByRole('button', { name: 'Delete project', exact: true }).click();
    await member.waitForURL('/?view=tags');
    const row = member.locator('tr', { has: member.getByRole('link', { name: 'Launch brief', exact: true }) });
    await expect(row.getByLabel('Unfiled')).toBeVisible();
    const metadata = await (await member.request.get(`/api/docs/${artifactId}`)).json();
    expect(metadata.document.project).toBeNull();
    expect(metadata.versions).toHaveLength(1);
    expect((await member.request.get(`/p/${memberProjectId}`)).status()).toBe(404);
  });

  test('a destination renamed while the picker is open fails without clearing or moving', async () => {
    await member.locator(`[data-move-to-project][data-document-id="${artifactId}"]`).click();
    const dialog = member.locator('dialog[open]');
    await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue('');
    await dialog.getByLabel('Project', { exact: true }).selectOption({ label: 'Brand refresh' });
    const csrf = (await ownerContext.cookies()).find((cookie) => cookie.name === 'csrf')!.value;
    const renamed = await owner.request.patch(`/api/projects/${brandId}`, { headers: { 'x-csrf-token': csrf }, data: { name: 'Brand refreshed' } });
    expect(renamed.ok()).toBe(true);
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog.locator('.project-dialog-feedback')).toContainText('not found');
    expect((await (await member.request.get(`/api/docs/${artifactId}`)).json()).document.project).toBeNull();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  test('mobile touch controls remain usable when optional browser storage is unavailable', async ({ browser }) => {
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, storageState: await ownerContext.storageState() });
    await mobileContext.addInitScript(() => {
      const blocked = () => { throw new DOMException('Storage unavailable', 'SecurityError'); };
      Object.defineProperty(Storage.prototype, 'getItem', { value: blocked });
      Object.defineProperty(Storage.prototype, 'setItem', { value: blocked });
    });
    const mobile = await mobileContext.newPage();
    await mobile.goto('/?view=folders');
    await expect(mobile.getByRole('link', { name: 'Website launch', exact: true })).toBeVisible();
    await mobile.getByRole('link', { name: 'Tags', exact: true }).tap();
    await mobile.locator(`[data-move-to-project][data-document-id="${artifactId}"]`).tap();
    const dialog = mobile.locator('dialog[open]');
    await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue('');
    await dialog.getByLabel('Project', { exact: true }).selectOption({ label: 'Brand refreshed' });
    await dialog.getByRole('button', { name: 'Move', exact: true }).tap();
    await expect(mobile.locator('tr', { has: mobile.getByRole('link', { name: 'Launch brief', exact: true }) }).locator('.project-tag')).toHaveText('Brand refreshed');
    await mobile.getByRole('button', { name: 'New project', exact: true }).tap();
    await expect(mobile.locator('dialog[open]').getByLabel('Project name')).toBeVisible();
    await mobile.locator('dialog[open]').getByRole('button', { name: 'Cancel', exact: true }).tap();
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await mobile.screenshot({ path: 'test-results/projects-mobile.png', fullPage: true });
    await mobileContext.close();
  });
});
