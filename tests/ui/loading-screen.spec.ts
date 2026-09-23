import { mockAuthenticatedSession } from './helpers/authenticated-session';
import { test, expect, type Page } from '@playwright/test';
import { clickAccountMenu } from './helpers/account-menu';

async function authenticated(page: Page) {
  await mockAuthenticatedSession(page);
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
}

test('illustrated loading shell is visible before the game module, including mobile', async ({ page }) => {
  await authenticated(page);
  await page.setViewportSize({ width: 390, height: 844 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/(?:src\/main\.ts|assets\/main-[^/]+\.js)(?:\?|$)/, async route => { await held; await route.continue(); });
  await page.goto('/', { waitUntil: 'commit' });
  const loading = page.locator('#startup-loading');
  await expect(loading).toBeVisible();
  await expect(loading.locator('img')).toHaveJSProperty('naturalWidth', 1024);
  await loading.locator('img').evaluate((image: HTMLImageElement) => image.decode());
  await expect(loading.getByRole('progressbar', { name: '회로 준비' })).toHaveAttribute('value', '0');
  await expect(loading.getByRole('progressbar', { name: '3D 월드 준비' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/loading-mobile.png' });
  release();
  await expect(page.locator('#starter-dialog')).toBeVisible({ timeout: 30_000 });
  await expect(loading).toHaveCount(0);
});

test('startup requests run together and query the server connectome only once', async ({ page }) => {
  await authenticated(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route('**/api/connectome', async route => { requests++; await held; await route.fulfill({ json: { available: false } }); });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#startup-loading [data-loading-percent="connectome"]')).toHaveText('80%');
  expect(requests).toBe(1);
  await page.screenshot({ path: 'artifacts/loading-desktop.png' });
  release();
  await expect(page.locator('#starter-dialog')).toBeVisible();
  expect(requests).toBe(1);
});

test('failed circuit load offers a working retry', async ({ page }) => {
  await authenticated(page);
  await page.route('**/data/connectome.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.goto('/');
  await expect(page.locator('#startup-loading')).toHaveAttribute('data-failed', 'true');
  await expect(page.locator('#startup-loading [data-loading-status]')).toContainText('503');
  await page.unroute('**/data/connectome.json');
  await page.locator('#startup-loading [data-loading-retry]').click();
  await expect(page.locator('#starter-dialog')).toBeVisible();
  await expect(page.locator('#startup-loading')).toHaveCount(0);
});

test('3D loading stays until the real partner model draws and also covers save restoration', async ({ page }) => {
  test.setTimeout(120_000);
  await authenticated(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let failModel = true, modelRequests = 0;
  await page.route(/\/models\/(?:pokemon|opt\/regular)\/152\.glb(?:\?|$)/, async route => {
    modelRequests++;
    if (failModel) { await route.fulfill({ status: 503, body: 'unavailable' }); return; }
    await held; await route.continue();
  });
  await page.goto('/');
  await page.locator('[data-starter="152"]').click();
  const loading = page.locator('.adventure-loading--world');
  await expect(loading).toBeVisible();
  await expect(loading.locator('[data-loading-percent="connectome"]')).toHaveText('100%');
  await expect(loading).toHaveAttribute('data-failed', 'true', { timeout: 45_000 });
  expect(modelRequests).toBeGreaterThan(0);
  failModel = false;
  await loading.locator('[data-loading-retry]').click();
  await expect.poll(() => modelRequests).toBeGreaterThan(1);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-renderer-ready', 'true', { timeout: 45_000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'false');
  expect(await loading.getByRole('progressbar', { name: '3D 월드 준비' }).evaluate((el: HTMLProgressElement) => el.value)).toBeLessThan(100);
  await page.screenshot({ path: 'artifacts/loading-world.png' });
  release();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(loading).toHaveCount(0);
  await clickAccountMenu(page, '#save-now');
  await expect(page.locator('#save-state')).toHaveAttribute('data-state', /local|saved|synced/);
  await page.reload();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(page.locator('.adventure-loading')).toHaveCount(0);
  expect(errors).toEqual([]);
});
