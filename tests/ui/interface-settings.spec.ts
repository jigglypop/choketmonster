import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;

test.setTimeout(150_000);

async function bootstrap(page: Page) {
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  await page.goto('/');
  await expect(page.locator('#starter-dialog [data-starter="152"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('#starter-dialog [data-starter="152"]').click();
}

async function importSave(page: Page, save: unknown) {
  const status = page.getByRole('status');
  await expect(status).toBeHidden();
  await page.locator('#import-file').setInputFiles({
    name: 'interface-settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)),
  });
  await expect(status).toBeVisible();
  await expect(status).toContainText('불러왔습니다');
}

test('interface preferences apply immediately, persist in IndexedDB, reset, and fit a 390px viewport', async ({ page }) => {
  await bootstrap(page);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  if (await page.locator('#ow-host').getAttribute('data-paused') !== 'true') await page.locator('#world-pause').click();
  const originalFont = await page.locator('.brand').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
  const originalPanel = await page.locator('.world-battle-hud').boundingBox();
  expect(originalPanel).not.toBeNull();

  await page.locator('#open-interface-settings').click();
  await expect(page.locator('#interface-settings')).toBeVisible();
  await page.locator('#interface-font-size').evaluate((input: HTMLInputElement) => {
    input.value = '150'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#interface-font-value')).toHaveText('150%');
  await expect.poll(() => page.locator('.brand').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(originalFont);
  await page.locator('#interface-density').selectOption('compact');
  await page.locator('#interface-battle-position').selectOption('left');
  await page.locator('#interface-team-layout').selectOption('stack');
  await page.locator('#interface-contrast').selectOption('high');
  await expect(page.locator('html')).toHaveAttribute('data-ui-density', 'compact');
  await expect(page.locator('html')).toHaveAttribute('data-battle-position', 'left');
  await expect(page.locator('html')).toHaveAttribute('data-team-layout', 'stack');
  await expect(page.locator('html')).toHaveAttribute('data-ui-contrast', 'high');
  await expect(page.locator('#interface-save-status')).toHaveText('이 기기에 저장됨');
  await page.locator('.settings-done').click();
  const leftPanel = await page.locator('.world-battle-hud').boundingBox();
  expect(leftPanel!.x).toBeLessThan(originalPanel!.x);

  await page.locator('#open-interface-settings').click();
  await page.locator('#interface-battle-position').selectOption('bottom');
  await expect(page.locator('#interface-save-status')).toHaveText('이 기기에 저장됨');
  await page.locator('.settings-done').click();
  const bottomPanel = await page.locator('.world-battle-hud').boundingBox();
  expect(Math.abs(bottomPanel!.x + bottomPanel!.width / 2 - 720)).toBeLessThan(2);

  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.team-layout')).toHaveCSS('flex-direction', 'column');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ui-density', 'compact');
  await expect(page.locator('html')).toHaveAttribute('data-battle-position', 'bottom');
  await expect(page.locator('html')).toHaveAttribute('data-team-layout', 'stack');
  await expect(page.locator('html')).toHaveAttribute('data-ui-contrast', 'high');
  await expect.poll(() => page.locator('.brand').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(originalFont);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#open-interface-settings').click();
  const fits = await page.locator('#interface-settings').evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= document.documentElement.clientWidth + 1
      && rect.top >= 0 && rect.bottom <= window.innerHeight + 1
      && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
  });
  expect(fits).toBe(true);
  const navBottom = await page.locator('.topbar nav').evaluate(nav => nav.getBoundingClientRect().bottom);
  expect(Math.abs(navBottom - 844)).toBeLessThanOrEqual(1);
  await mkdir('artifacts/interface-refresh/ui-tests', { recursive: true });
  await page.screenshot({ path: 'artifacts/interface-refresh/ui-tests/mobile-high-scale-settings.png' });

  await page.locator('.settings-close').click();
  await page.locator('[data-tab="map"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  // Walking controls sit above the collapsed battle panel on mobile.
  if (await page.locator('.world-battle-hud').evaluate((panel: HTMLDetailsElement) => panel.open)) {
    await page.locator('.world-battle-hud > summary').click();
  }
  const dpad = await page.locator('.world-dpad').boundingBox();
  const hud = await page.locator('.world-battle-hud').boundingBox();
  expect(dpad!.y + dpad!.height).toBeLessThanOrEqual(hud!.y);
  const cameraFits = await page.locator('.ow-camera-controls').evaluate(panel =>
    panel.scrollWidth <= panel.clientWidth + 1 && panel.getBoundingClientRect().right <= innerWidth);
  expect(cameraFits).toBe(true);
  await page.locator('#open-interface-settings').click();
  await page.locator('#interface-reset').click();
  await expect(page.locator('#interface-font-value')).toHaveText('100%');
  await expect(page.locator('html')).toHaveAttribute('data-ui-density', 'comfortable');
  await expect(page.locator('html')).toHaveAttribute('data-battle-position', 'right');
  await expect(page.locator('html')).toHaveAttribute('data-team-layout', 'split');
  await expect(page.locator('html')).toHaveAttribute('data-ui-contrast', 'normal');
  await expect(page.locator('#interface-save-status')).toHaveText('이 기기에 저장됨');
  await page.locator('.settings-done').click();
});

test('the playable dex hides later species and unsupported versions while retaining a legacy boxed monster', async ({ page }) => {
  const game = createGame(1, 'legacy-box-ui');
  const legacy = createMonster(game, 152, 30);
  game.player.box.push(legacy);
  game.dex.seen.push(152); game.dex.caught.push(152);
  game.versionCaught ??= {}; game.versionCaught.gold = [152];
  await bootstrap(page);
  await importSave(page, packSave(game, graph, defaultView()));

  await page.locator('[data-tab="dex"]').click();
  const versions = await page.locator('#dex-version option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  expect(versions).toContain('national');
  expect(versions).toContain('red');
  expect(versions).not.toContain('gold');
  expect(versions).not.toContain('scarlet');
  await expect(page.locator('[data-species="152"]')).toHaveCount(0);
  expect(await page.locator('[data-species]').evaluateAll(cards => cards.every(card => Number((card as HTMLElement).dataset.species) <= 151))).toBe(true);

  await page.locator('[data-tab="team"]').click();
  await expect(page.locator(`.box-monster[data-monster="${legacy.instanceId}"]`)).toBeVisible();
  await expect(page.locator(`.box-monster[data-monster="${legacy.instanceId}"]`)).toContainText('치코리타');
});
