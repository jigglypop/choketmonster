import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
test('mobile shows the guide, expansion habitats and bulk candy controls', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/'); await page.locator('[data-starter="1"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await expect(page.locator('#world-next-guide')).toBeVisible();
  await expect(page.locator('#world-next-guide')).toContainText('도라지시티');
  const bounds = await page.locator('#world-next-guide').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.locator('#world-next-guide').evaluate(node => {
    const box = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  mkdirSync('artifacts/expansion-mobile', { recursive: true });
  await page.screenshot({ path: 'artifacts/expansion-mobile/guide.png' });

  await page.locator('[data-tab="dex"]').click();
  await page.locator('#dex-search').fill('493');
  await expect(page.locator('.dex-card[data-species="493"]')).toContainText('신오');
  await expect(page.locator('.dex-card[data-species="493"]')).toContainText('추가');

  const game = createGame(152, 'mobile-candy'); game.inventory['rare-candy'] = 5;
  await page.locator('#import-file').setInputFiles({ name: 'mobile.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packSave(game, graph, { ...defaultView(), openWorldPaused: true }))) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await page.locator('[data-tab="team"]').click();
  await page.locator('#candy-quantity').fill('3');
  await expect(page.locator('#candy-preview')).toHaveText('Lv.5 → Lv.8');
  await page.locator('#use-candy').click();
  await expect(page.locator('.detail-title > p')).toContainText('Lv.8');
  await expect(page.locator('#use-candy')).toContainText('최대 2개');
  await page.locator('#candy-quantity').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/expansion-mobile/candy.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});
