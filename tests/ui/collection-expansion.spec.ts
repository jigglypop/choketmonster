import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import type { Graph } from '../../src/core/brain';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
});

test('version collection, later-generation images, duplicate XP and release survive a reload', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.locator('[data-starter="1"]').click();
  await expect(page.locator('#world-version')).toHaveValue('red');
  await page.locator('[data-tab="dex"]').click();
  await expect(page.locator('.dex-card')).toHaveCount(60);
  await page.locator('#dex-version').selectOption('scarlet');
  await page.locator('#dex-search').fill('906');
  await expect(page.locator('.dex-card')).toHaveCount(1);
  await page.locator('.dex-card').click();
  await expect(page.locator('.species-preview')).toHaveAttribute('src', '/pokemon/906.png');
  await expect.poll(() => page.locator('.species-preview').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.locator('.model-dialog button').click();
  await page.locator('#collect-version').click();
  await expect(page.locator('#world-version')).toHaveValue('scarlet');
  await page.locator('#world-pause').click();
  await page.locator('#save-now').click(); await page.reload();
  await expect(page.locator('#world-version')).toHaveValue('scarlet');

  const game = createGame(1, 'collection-ui'); game.player.box.push(createMonster(game, 1, 20), createMonster(game, 25, 8));
  game.dex.seen.push(25); game.dex.caught.push(25);
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  await page.locator('#import-file').setInputFiles({ name: 'collection.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packSave(game, graph, defaultView()))) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await page.locator('[data-tab="team"]').click();
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#merge-duplicate').click();
  await expect(page.locator('#toast')).toContainText('경험치를 합쳤습니다');
  await expect(page.locator('.detail-title p')).not.toContainText('Lv.5');
  await page.locator('[data-monster="mon-3"]').click();
  await page.locator('#release-monster').click();
  await expect(page.locator('#toast')).toContainText('놓아주었습니다');
  await expect(page.locator('[data-monster="mon-3"]')).toHaveCount(0);
  await expect(page.locator('#release-monster')).toBeDisabled();
  await page.reload(); await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.count-chip')).toContainText('박스 0');
  await expect(page.locator('.detail-title p')).not.toContainText('Lv.5');
  expect(errors).toEqual([]);
});

test('touch navigation and collection fit narrow screens and share metadata is in the initial HTML', async ({ page, request }) => {
  test.setTimeout(90000);
  const html = await (await request.get('/')).text();
  expect(html).toContain('property="og:image" content="https://');
  expect(html).toContain('/chocketmon.png?v='); expect(html).not.toContain('__PUBLIC_SITE_URL__');
  expect((await request.get('/chocketmon.png')).headers()['content-type']).toContain('image/png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); await page.locator('[data-starter="1"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await page.locator('#world-pause').click();
  await page.screenshot({ path: 'artifacts/ui-expanded-mobile-map.png', fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('[data-tab="dex"]').click();
    await expect(page.locator('#dex-version')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const button of await page.locator('.topbar nav button').all()) {
      const bounds = await button.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
  }
  await page.screenshot({ path: 'artifacts/ui-expanded-mobile-dex.png', fullPage: true });
  await page.locator('[data-open-auth]').click();
  await expect(page.locator('.account-dialog')).toBeVisible();
  await page.locator('.account-close').click(); await expect(page.locator('.account-dialog')).not.toBeVisible();
});

test('a committed login with an IndexedDB error cannot overwrite the account with the guest game', async ({ page }) => {
  test.setTimeout(45000);
  await page.route('**/api/auth/login', async route => {
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      let failOnce = true;
      IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
        if (failOnce && this.name === 'choketmon-151') { failOnce = false; throw new Error('simulated IndexedDB failure after login'); }
        return original.apply(this, args);
      };
    });
    await route.fulfill({ json: { user: { id: 'new-account-id', username: 'newtrainer' } } });
  });
  await page.route('**/api/saves/current', route => route.fulfill({ status: 404, json: {} }));
  await page.goto('/'); await page.locator('[data-starter="1"]').click();
  await page.locator('[data-open-auth]').click();
  await page.locator('.account-dialog input[name="username"]').fill('newtrainer');
  await page.locator('.account-dialog input[name="password"]').fill('test-password-123');
  await page.locator('.account-dialog button[value="login"]').click();
  await expect(page.locator('#retry-account')).toHaveCount(1);
  await expect(page.locator('#starter-dialog')).not.toBeVisible();
  await expect(page.locator('#world-version')).toHaveCount(0);
  const stored = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open('choketmon-151', 2);
    request.onsuccess = () => { const db = request.result, tx = db.transaction('saves', 'readonly'), read = tx.objectStore('saves').get('account:new-account-id:current'); tx.oncomplete = () => { resolve(read.result); db.close(); }; tx.onerror = () => reject(tx.error); };
    request.onerror = () => reject(request.error);
  }));
  expect(stored).toBeUndefined();
});
