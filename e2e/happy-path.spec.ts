/**
 * End-to-end happy path: sign in, mint a PAT, publish an artifact via MCP,
 * comment on it through the viewer, resolve/reopen, watch a highlight
 * survive an in-place re-render, click a highlight to focus its thread,
 * export, and confirm the no-CSS.highlights fallback. Tests run serially and
 * share one signed-in browser context/document, mirroring a single user's
 * session end to end.
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { callTool, extractDocumentId, getArtifactFrame, phraseRectInFrame, selectPhraseInFrame, waitForLoginCode } from './helpers.js';

const ALICE = 'alice@example.com';

const LIVE_SENTENCE = 'The live region initial sentence stays here.';
const REWRITTEN_SENTENCE = 'Rewritten intro sentence.';
const DBLCLICK_WORD = 'glockenspiel';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: -apple-system, sans-serif; padding: 24px; color: #111827; }
  h1 { color: #4f46e5; }
  p { line-height: 1.6; }
</style>
</head>
<body>
<h1>Fixture Artifact</h1>
<p>This introductory paragraph exists purely to give the annotator something stable to index before anything moves.</p>
<div id="live"><p>${LIVE_SENTENCE}</p></div>
<p>A distinctive <span id="dbltarget">${DBLCLICK_WORD}</span> sits alone in this closing paragraph for double-click testing.</p>
<script>
  setTimeout(function () {
    document.getElementById('live').innerHTML =
      '<p>${REWRITTEN_SENTENCE}</p><p>${LIVE_SENTENCE}</p>';
  }, 1500);
</script>
</body>
</html>`;

test.describe.configure({ mode: 'serial' });

test.describe('happy path', () => {
  // Playwright gives every test a fresh context/page by default; these tests
  // depend on one signed-in session, so a single context is created once in
  // beforeAll and reused (rather than destructuring `page` per test).
  let context: BrowserContext;
  let page: Page;
  let pat: string;
  let slug: string;
  const commentBody = 'Please double-check this claim before we ship.';
  const replyBody = 'Confirmed, looks right.';

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('sign in with an emailed one-time code', async () => {
    await page.goto('/signin');
    await page.fill('#email-input', ALICE);
    await page.click('#email-form button[type="submit"]');

    await expect(page.locator('#code-form')).toBeVisible();
    const code = await waitForLoginCode(ALICE);
    await page.fill('#code-input', code);
    await page.click('#code-form button[type="submit"]');

    await page.waitForURL((url) => url.pathname === '/');
    // Zero teams + SELF_SIGNUP=true on the e2e server → the first-run wizard.
    await expect(page.locator('h1')).toHaveText('Welcome');
  });

  test('bootstrap: the instance admin creates a team and joins it as team admin', async () => {
    // Fresh database — alice (INSTANCE_ADMIN_EMAILS) starts with zero teams.
    // The e2e server runs with SELF_SIGNUP=true, so she sees the first-run
    // wizard, but bootstraps her team through the admin area instead.
    await expect(page.locator('#team-wizard')).toBeVisible();

    await page.goto('/admin');
    await page.fill('#new-team-name', 'E2E Team');
    await page.click('form[action="/admin/teams"] button[type="submit"]');
    await page.waitForURL((url) => /^\/admin\/teams\//.test(url.pathname));

    await page.fill('#invite-email', ALICE);
    await page.selectOption('#invite-role', 'admin');
    await page.click('#invite-email >> xpath=ancestor::form//button[@type="submit"]');
    await expect(page.locator('main')).toContainText(`${ALICE} was added to the team.`);

    await page.goto('/');
    await expect(page.locator('a', { hasText: 'Team settings' })).toBeVisible();
  });

  test('create a personal access token via the UI', async () => {
    await page.goto('/settings/tokens');
    await page.click('form[action="/settings/tokens"] button[type="submit"]');

    const plaintext = await page.locator('code.token-plaintext').textContent();
    expect(plaintext).toMatch(/^acp_/);
    pat = plaintext!.trim();
  });

  test('publish an artifact via MCP', async () => {
    const result = await callTool(page.request, pat, 'publish_artifact', { title: 'E2E Fixture', html: FIXTURE_HTML });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    slug = extractDocumentId(text);
    expect(slug).toBeTruthy();
  });

  test('select text in the frame and save a comment', async () => {
    await page.goto(`/d/${slug}`);
    const frame = await getArtifactFrame(page);
    await expect(frame.locator('#live')).toBeVisible();

    const selected = await selectPhraseInFrame(frame, LIVE_SENTENCE);
    expect(selected).toBe(true);

    const composer = page.locator('#ac-composer');
    await expect(composer).toBeVisible();
    await expect(composer.locator('.thread-quote')).toHaveText(LIVE_SENTENCE);

    await composer.locator('textarea').fill(commentBody);
    await composer.locator('button:has-text("Save")').click();
    await expect(composer).toBeHidden();

    const card = page.locator('.thread-card', { hasText: commentBody });
    await expect(card).toBeVisible();

    await expect.poll(() => frame.evaluate(() => Boolean(CSS.highlights))).toBe(true);
    await expect.poll(() => frame.evaluate(() => CSS.highlights.has('ac-open'))).toBe(true);
  });

  test('reply, resolve, and reopen the comment', async () => {
    const card = page.locator('.thread-card', { hasText: commentBody });

    await card.locator('.reply-form textarea').fill(replyBody);
    await card.locator('.reply-form button:has-text("Reply")').click();
    await expect(card.locator('.reply', { hasText: replyBody })).toBeVisible();

    await card.locator('button:has-text("Resolve")').click();

    const resolvedDetails = page.locator('details.resolved-section');
    await expect(resolvedDetails).toContainText(commentBody);
    await resolvedDetails.locator('summary').click();

    const resolvedCard = resolvedDetails.locator('.thread-card', { hasText: commentBody });
    await resolvedCard.locator('button:has-text("Reopen")').click();

    const openCard = page.locator('.thread-card', { hasText: commentBody });
    await expect(openCard).toBeVisible();
    await expect(openCard.locator('button:has-text("Resolve")')).toBeVisible();
  });

  test('Enter sends a reply, Shift+Enter makes a line break', async () => {
    const card = page.locator('.thread-card', { hasText: commentBody });
    const textarea = card.locator('.reply-form textarea');

    await textarea.click();
    await page.keyboard.type('first line');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second line');
    await expect(textarea).toHaveValue('first line\nsecond line');

    await page.keyboard.press('Enter');
    const reply = card.locator('.reply', { hasText: 'first line' });
    await expect(reply).toBeVisible();
    // The break must survive storage and render as an actual line break.
    await expect(reply.locator('.reply-body')).toHaveText('first line\nsecond line');
    await expect(textarea).toHaveValue('');

    // Deselect the thread for the later highlight-color assertions.
    await page.locator('main h1').click();
  });

  test('clicking the reply textarea keeps focus and preserves the draft', async () => {
    const card = page.locator('.thread-card', { hasText: commentBody });
    const textarea = card.locator('.reply-form textarea');

    // Clicking the textarea bubbles to the card's focus handler; the sidebar
    // must not rebuild the node out from under the caret.
    await textarea.click();
    await page.waitForTimeout(300);
    await expect(textarea).toBeFocused();

    await page.keyboard.type('draft in progress');
    await page.waitForTimeout(300);
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue('draft in progress');

    // Clear the draft and deselect the thread (a focused comment paints as
    // ac-focused instead of ac-open, which later tests assert on).
    await textarea.fill('');
    await page.locator('main h1').click();
    await expect(card).not.toHaveClass(/focused/);
  });

  test('sidebar scroll reaches the end instead of growing forever', async () => {
    // Shrink the window so the sidebar overflows and actually scrolls.
    await page.setViewportSize({ width: 1280, height: 300 });
    const sidebar = page.locator('#sidebar');

    // Scroll to the bottom until the height stops changing. With the old
    // scroll-compensating alignment every scroll grew the scrollable height
    // by the scrolled distance, so this never converged. (One legitimate
    // shift is expected: the shrunken frame rewraps text and the anchor —
    // and its aligned card — move down once.)
    const readings: number[] = [];
    await expect
      .poll(
        async () => {
          await sidebar.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          const h = await sidebar.evaluate((el) => el.scrollHeight);
          readings.push(h);
          const n = readings.length;
          return n >= 3 && readings[n - 1] === readings[n - 2] && readings[n - 2] === readings[n - 3];
        },
        { intervals: [150], timeout: 4000 },
      )
      .toBe(true);

    const atEnd = await sidebar.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
    expect(atEnd, `scrollHeight per scroll: ${readings.join(', ')}`).toBe(true);

    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('clicking a reply textarea scrolls its highlight into view', async () => {
    // Shrink the window so the artifact frame is scrollable and the quoted
    // text sits below its fold.
    await page.setViewportSize({ width: 1280, height: 220 });
    const frame = await getArtifactFrame(page);
    await frame.evaluate(() => window.scrollTo(0, 0));

    const viewportH = await frame.evaluate(() => window.innerHeight);
    const before = await phraseRectInFrame(frame, LIVE_SENTENCE);
    expect(before).not.toBeNull();
    expect(before!.top + before!.height, 'quoted text should start off-screen').toBeGreaterThan(viewportH);

    // Let the post-resize relocate/reflow finish first: a smooth scroll
    // started while the frame is still settling gets canceled by the browser.
    await page.waitForTimeout(750);
    const card = page.locator('.thread-card', { hasText: commentBody });
    await card.locator('.reply-form textarea').click();

    await expect
      .poll(async () => {
        const rect = await phraseRectInFrame(frame, LIVE_SENTENCE);
        return rect !== null && rect.top >= 0 && rect.top + rect.height <= viewportH;
      })
      .toBe(true);

    // Deselect so later tests see the unfocused highlight color.
    await page.locator('main h1').click();
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('highlight survives an in-place re-render', async () => {
    const frame = await getArtifactFrame(page);

    // The artifact swaps #live's contents 1.5s after load; give it time plus
    // the annotator's 200ms MutationObserver debounce.
    await expect(frame.getByText(REWRITTEN_SENTENCE)).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);

    await expect.poll(() => frame.evaluate(() => CSS.highlights.has('ac-open'))).toBe(true);
  });

  test('clicking the highlighted text focuses its thread card', async () => {
    const frame = await getArtifactFrame(page);
    const rect = await phraseRectInFrame(frame, LIVE_SENTENCE);
    expect(rect).not.toBeNull();

    const frameBox = await page.locator('#artifact-frame').boundingBox();
    expect(frameBox).not.toBeNull();

    const x = frameBox!.x + rect!.left + rect!.width / 2;
    const y = frameBox!.y + rect!.top + rect!.height / 2;
    await page.mouse.click(x, y);

    const card = page.locator('.thread-card', { hasText: commentBody });
    await expect(card).toHaveClass(/focused/);
  });

  test('watch toggle and export menu in the toolbar', async () => {
    // Alice commented on this doc, so she auto-watches it.
    const watchBtn = page.locator('.viewer-toolbar .watch-btn');
    await expect(watchBtn).toHaveText('Watching ✓');

    await watchBtn.click(); // form post + redirect back
    await expect(page.locator('.viewer-toolbar .watch-btn')).toHaveText('Watch');

    await page.locator('.viewer-toolbar .watch-btn').click();
    await expect(page.locator('.viewer-toolbar .watch-btn')).toHaveText('Watching ✓');

    // Alice authored this document, so the menu also offers deletion.
    const exportMenu = page.locator('.viewer-toolbar details.export-menu');
    await exportMenu.locator('summary').click();
    await expect(exportMenu.locator('.settings-menu-items a')).toHaveText(['Markdown', 'JSON', 'Delete artifact…']);
    await page.locator('main h1').click(); // close the menu again
  });

  test('picking a share option applies it while the panel stays open', async () => {
    const shareMenu = page.locator('.viewer-toolbar details.share-menu');
    await shareMenu.locator('summary').click();

    // Alice created this doc, so all three options show, with the default checked.
    const options = shareMenu.locator('.share-option');
    await expect(options).toHaveCount(3);
    await expect(options.nth(1)).toHaveAttribute('aria-checked', 'true');

    await options.nth(2).click(); // Anyone with the link
    // Applied in place: the panel is still open for copying the link, the
    // caption and menu label reflect the new visibility, no page reload.
    await expect(options.nth(2)).toHaveAttribute('aria-checked', 'true');
    await expect(options.nth(1)).toHaveAttribute('aria-checked', 'false');
    await expect(shareMenu.locator('.share-link-note')).toHaveText('Anyone signed in can open this link.');
    await expect(shareMenu.locator('summary')).toHaveText('Public');
    await expect(shareMenu).toHaveAttribute('open', '');

    // The change really persisted server-side.
    const res = await page.request.get(`/api/docs/${slug}`);
    expect(((await res.json()) as { document: { visibility: string } }).document.visibility).toBe('public');

    await options.nth(1).click(); // back to Team only, leaving the suite's state untouched
    await expect(options.nth(1)).toHaveAttribute('aria-checked', 'true');
    await expect(shareMenu.locator('summary')).toHaveText('Share');
    await page.locator('main h1').click(); // close the menu again
  });

  test('export.json includes the comment and its reply', async () => {
    const res = await page.request.get(`/api/docs/${slug}/export.json`);
    expect(res.ok()).toBeTruthy();
    const payload = (await res.json()) as { comments: { body: string; replies: { body: string }[] }[] };
    const thread = payload.comments.find((c) => c.body === commentBody);
    expect(thread).toBeDefined();
    expect(thread!.replies.some((r) => r.body === replyBody)).toBe(true);
  });

  test('double-clicking a word quotes exactly that word', async () => {
    const frame = page.frameLocator('#artifact-frame');
    await frame.locator('#dbltarget').dblclick();

    const composer = page.locator('#ac-composer');
    await expect(composer).toBeVisible();
    await expect(composer.locator('.thread-quote')).toHaveText(DBLCLICK_WORD);

    await composer.locator('button:has-text("Cancel")').click();
    await expect(composer).toBeHidden();
  });

  test('a gmail contractor is invited, signs in with the emailed code, sees the document, and comments', async ({
    browser,
  }) => {
    const GUEST = 'contractor@gmail.com';

    // Team admin invites the guest from team settings.
    await page.goto('/');
    await page.locator('a', { hasText: 'Team settings' }).click();
    await page.fill('#invite-email', GUEST);
    await page.click('#invite-email >> xpath=ancestor::form//button[@type="submit"]');
    await expect(page.locator('main')).toContainText(`Invited ${GUEST}`);

    // The guest signs in with the normal code flow — that redeems the invite.
    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    await guestPage.goto('/signin');
    await guestPage.fill('#email-input', GUEST);
    await guestPage.click('#email-form button[type="submit"]');
    await expect(guestPage.locator('#code-form')).toBeVisible();
    const code = await waitForLoginCode(GUEST);
    await guestPage.fill('#code-input', code);
    await guestPage.click('#code-form button[type="submit"]');
    await guestPage.waitForURL((url) => url.pathname === '/');

    // They see the team's document and can comment on it.
    await guestPage.locator('a', { hasText: 'E2E Fixture' }).click();
    const frame = await getArtifactFrame(guestPage);
    await expect(frame.locator('h1')).toBeVisible();

    const selected = await selectPhraseInFrame(frame, 'something stable to index');
    expect(selected).toBe(true);
    const composer = guestPage.locator('#ac-composer');
    await expect(composer).toBeVisible();
    await composer.locator('textarea').fill('Guest here — this looks good.');
    await composer.locator('button:has-text("Save")').click();
    await expect(guestPage.locator('.thread-card', { hasText: 'Guest here — this looks good.' })).toBeVisible();

    await guestContext.close();
  });
});

test.describe('CSS.highlights unsupported fallback', () => {
  test('renders the no-highlights banner without throwing', async ({ page, request }) => {
    // A fresh document + token so this test doesn't depend on the serial
    // suite's shared state (only the ability to sign in and publish exists).
    await page.goto('/signin');
    await page.fill('#email-input', ALICE);
    await page.click('#email-form button[type="submit"]');
    await expect(page.locator('#code-form')).toBeVisible();
    const code = await waitForLoginCode(ALICE);
    await page.fill('#code-input', code);
    await page.click('#code-form button[type="submit"]');
    await page.waitForURL((url) => url.pathname === '/');

    await page.goto('/settings/tokens');
    await page.click('form[action="/settings/tokens"] button[type="submit"]');
    const plaintext = (await page.locator('code.token-plaintext').textContent())!.trim();

    const result = await callTool(request, plaintext, 'publish_artifact', {
      title: 'No Highlights Fixture',
      html: '<!DOCTYPE html><html><body><p>Plain content for the fallback test.</p></body></html>',
    });
    const noHighlightsSlug = extractDocumentId(result.content[0]!.text);

    // Remove CSS.highlights before any page script runs, in every frame
    // (addInitScript applies to the iframe's document too).
    await page.addInitScript(() => {
      try {
        delete (CSS as { highlights?: unknown }).highlights;
      } catch {
        // Fall through; the assertion below will catch an unsupported override.
      }
    });

    await page.goto(`/d/${noHighlightsSlug}`);

    await expect(page.locator('#no-highlights-banner')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('.section-header').first()).toHaveText('Open');
  });
});
