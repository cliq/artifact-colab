import { createServer } from 'node:http';

import { expect, test } from '@playwright/test';

import { waitForLoginCode } from './helpers.js';

test('a same-site form cannot sign a browser into the attacker account after cookie injection', async ({ browser }) => {
  const attackerEmail = 'login-csrf-attacker@example.test';
  const attackerContext = await browser.newContext();
  const attackerPage = await attackerContext.newPage();

  await attackerPage.goto('/signin');
  await attackerPage.fill('#email-input', attackerEmail);
  await attackerPage.click('#email-form button[type="submit"]');
  await expect(attackerPage.locator('#code-form')).toBeVisible();
  const attackerCode = await waitForLoginCode(attackerEmail);
  const attackerCsrf = await attackerPage.locator('#signin-csrf').inputValue();

  const attackerServer = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    // Cookies are port-agnostic. This simulates a sibling host planting a
    // known parent-domain cookie that matches the forged form proof.
    response.setHeader('set-cookie', `csrf=${attackerCsrf}; Path=/; SameSite=Lax`);
    response.end(`
      <form method="post" action="http://localhost:3789/auth/verify-code">
        <input name="email" value="${attackerEmail}">
        <input name="code" value="${attackerCode}">
        <input name="_csrf" value="${attackerCsrf}">
        <button type="submit">Continue</button>
      </form>
    `);
  });
  await new Promise<void>((resolve, reject) => {
    attackerServer.once('error', reject);
    attackerServer.listen(0, '127.0.0.1', resolve);
  });
  const address = attackerServer.address();
  if (!address || typeof address === 'string') throw new Error('expected attacker server TCP address');
  const attackerOrigin = `http://localhost:${address.port}`;

  const victimContext = await browser.newContext();
  const victimPage = await victimContext.newPage();
  try {
    await victimPage.goto('/signin');
    await victimPage.goto(attackerOrigin);
    await expect.poll(async () => (await victimContext.cookies('http://localhost:3789'))
      .find((cookie) => cookie.name === 'csrf')?.value).toBe(attackerCsrf);

    const forgedRequestPromise = victimPage.waitForRequest(
      (request) => request.url() === 'http://localhost:3789/auth/verify-code' && request.method() === 'POST',
    );
    await victimPage.click('button');
    const forgedRequest = await forgedRequestPromise;
    const forgedHeaders = await forgedRequest.allHeaders();
    expect(forgedHeaders.cookie).toContain(`csrf=${attackerCsrf}`);
    expect(forgedHeaders.origin).toBe(attackerOrigin);
    expect(forgedRequest.postData()).toContain(`_csrf=${attackerCsrf}`);

    await victimPage.waitForURL('http://localhost:3789/auth/verify-code');
    await expect(victimPage.locator('body')).toContainText('invalid csrf token');
    await victimPage.goto('/');
    await expect(victimPage).toHaveURL(/\/signin\?next=%2F$/);

    // Rejection happens before verification, so the attacker can still use
    // the same one-time code in the browser that initiated their flow.
    await attackerPage.fill('#code-input', attackerCode);
    await attackerPage.click('#code-form button[type="submit"]');
    await attackerPage.waitForURL((url) => url.pathname === '/');
  } finally {
    await victimContext.close();
    await attackerContext.close();
    await new Promise<void>((resolve, reject) => attackerServer.close((error) => error ? reject(error) : resolve()));
  }
});
