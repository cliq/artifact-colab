/**
 * Screenshots the alignment baseline (see alignment-baseline.ts) in a few
 * states so before/after layout changes can be compared side by side.
 *
 * Usage: npx tsx scripts/alignment-shots.ts <baseUrl> <docPath> <sessionCookie> <outDir>
 */

import { mkdirSync } from 'node:fs';

import { chromium } from '@playwright/test';

const [baseUrl, docPath, sessionCookie, outDir] = process.argv.slice(2);
if (!baseUrl || !docPath || !sessionCookie || !outDir) {
  console.error('usage: alignment-shots <baseUrl> <docPath> <sessionCookie> <outDir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.context().addCookies([{ name: 'session', value: sessionCookie, url: baseUrl }]);
await page.goto(`${baseUrl}${docPath}`);
await page.waitForSelector('.thread-card.aligned');
const frame = page.frameLocator('#artifact-frame');
await frame.locator('h1').waitFor();
await page.waitForTimeout(600);

async function shot(name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`wrote ${outDir}/${name}.png`);
}

await shot('1-initial');

// Scroll the artifact so the middle sections are in view.
await frame.locator('#s4').evaluate((h) => h.scrollIntoView({ block: 'start' }));
await shot('2-scrolled-mid');

// Focus the long thread by clicking its card.
await frame.locator('h1').evaluate((h) => h.scrollIntoView({ block: 'start' }));
await page.locator('.thread-card', { hasText: 'A long discussion thread lives here.' }).click();
await shot('3-focused-long-thread');

// Focus the second of the same-line pair (deselect first: while the long
// thread is focused, its neighbours are folded away).
await page.locator('main h1').click();
await page.waitForTimeout(300);
await page.locator('.thread-card', { hasText: 'Second comment on the same line' }).click();
await shot('4-focused-tie');

// Bottom of the document.
await frame.locator('body').evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await shot('5-scrolled-bottom');

// Sidebar scroll extent: how tall did the aligned zone get?
const zoneHeight = await page.locator('.aligned-zone').evaluate((z) => (z as HTMLElement).offsetHeight);
const sidebarScroll = await page.locator('#sidebar').evaluate((s) => s.scrollHeight);
console.log(JSON.stringify({ zoneHeight, sidebarScrollHeight: sidebarScroll }));

await browser.close();
