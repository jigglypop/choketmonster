import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import type { Graph } from '../../src/core/brain';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
});

test('bounded duplicate levels and release use cancellable app modals, with readable team actions and reload persistence', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [], browserDialogs: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { browserDialogs.push(dialog.type()); await dialog.dismiss(); });
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  const game = createGame(1, 'collection-ui');
  const donor = createMonster(game, 1, 20);
  game.player.box.push(donor, createMonster(game, 25, 8));
  game.dex.seen.push(25); game.dex.caught.push(25);
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  await page.goto('/');
  await expect(page.locator('[data-starter="152"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'collection.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packSave(game, graph, { ...defaultView(), openWorldPaused: true }))) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await page.locator('[data-tab="team"]').click();

  await page.locator('[data-withdraw-id="mon-3"]').click();
  await page.locator('[data-lead="1"]').click();
  await expect(page.locator('.team-monster').first()).toHaveAttribute('data-monster', 'mon-3');
  const output = process.env.CHOKETMON_COLLECTION_ARTIFACTS ?? 'artifacts/collection-modals/local';
  mkdirSync(output, { recursive: true });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const fits = await page.locator('.team-slots .card-action').evaluateAll(buttons => buttons.every(button => {
      const box = button.getBoundingClientRect(), card = button.closest('.monster-card')!.getBoundingClientRect();
      return parseFloat(getComputedStyle(button).fontSize) >= 16 && box.height >= 44
        && box.left >= card.left && box.right <= card.right && box.right <= innerWidth;
    }));
    expect(fits).toBe(true);
    if (width === 390) await page.locator('.team-rack').screenshot({ path: `${output}/team-actions-mobile.png` });
  }
  await page.locator('[data-deposit="0"]').click();
  await expect(page.locator('.team-monster').first()).toHaveAttribute('data-monster', 'mon-1');
  await page.locator('#open-interface-settings').click();
  await page.locator('#interface-font-size').evaluate((input: HTMLInputElement) => { input.value = '150'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('.settings-close').click();

  await page.locator('#merge-duplicate').click();
  const modal = page.getByRole('dialog', { name: '레벨을 합칠까요?' });
  await expect(modal).toBeVisible();
  await expect(modal.locator('.confirmation-cancel')).toBeFocused();
  await expect(modal).toContainText('mon-2');
  await expect(modal).toContainText('mon-1');
  await expect(modal).toContainText('기준선 Lv.20');
  await expect(modal).toContainText('5% 보너스 1레벨');
  await expect(modal).toContainText('현재보다 +16');
  const fits = await modal.evaluate(dialog => { const r = dialog.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth + 1; });
  expect(fits).toBe(true);
  await modal.screenshot({ path: `${output}/merge-modal-mobile-150.png` });
  await modal.locator('.confirmation-cancel').click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('#merge-duplicate')).toBeFocused();
  await expect(page.locator('[data-monster="mon-2"]')).toHaveCount(1);
  await expect(page.locator('.detail-title > p')).toContainText('Lv.5');
  await page.locator('#merge-duplicate').click();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(page.locator('[data-monster="mon-2"]')).toHaveCount(1);
  await page.locator('#merge-duplicate').click();
  await modal.getByRole('button', { name: '레벨 합치기', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('레벨을 합쳤습니다');
  await expect(page.locator('[data-monster="mon-2"]')).toHaveCount(0);
  await expect(page.locator('.detail-title > p')).not.toContainText('Lv.5');
  await page.locator('[data-monster="mon-3"]').click();
  await page.locator('#release-monster').click();
  const release = page.getByRole('dialog', { name: '포켓몬을 놓아줄까요?' });
  await expect(release).toContainText('피카츄');
  await release.getByRole('button', { name: '확인 창 닫기' }).click();
  await expect(page.locator('[data-monster="mon-3"]')).toHaveCount(1);
  await page.locator('#release-monster').click();
  await release.getByRole('button', { name: '놓아주기', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('놓아주었습니다');
  await expect(page.locator('[data-monster="mon-3"]')).toHaveCount(0);
  await expect(page.locator('#release-monster')).toBeDisabled();
  await page.reload(); await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.count-chip')).toContainText('박스 0', { timeout: 30_000 });
  await expect(page.locator('.detail-title > p')).not.toContainText('Lv.5');
  expect(browserDialogs).toEqual([]);
  expect(errors).toEqual([]);
});

test('touch navigation and collection fit narrow screens and share metadata is in the initial HTML', async ({ page, request }) => {
  test.setTimeout(90000);
  const html = await (await request.get('/')).text();
  expect(html).toContain('property="og:image" content="https://');
  expect(html).toContain('/chocketmon.png?v='); expect(html).not.toContain('__PUBLIC_SITE_URL__');
  expect((await request.get('/chocketmon.png')).headers()['content-type']).toContain('image/png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await page.locator('#world-pause').evaluate((button: HTMLButtonElement) => button.click());
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
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await page.locator('[data-open-auth]').click();
  await page.locator('.account-dialog input[name="username"]').fill('newtrainer');
  await page.locator('.account-dialog input[name="password"]').fill('test-password-123');
  await page.locator('.account-submit').click();
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
