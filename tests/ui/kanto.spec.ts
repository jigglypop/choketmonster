import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation, sampleWorld } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { openExplorePanel } from './helpers/explore-panel';
const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
const targetUrl = process.env.KANTO_URL ?? '/';
// Multiple world rebuilds, screenshots and device-save restores run against
// the real API. Keep individual assertions bounded while allowing the whole
// integration flow to finish on headless software WebGL.
test.setTimeout(180000);
// This suite covers controls and save flows against the real local API.
// Heavy model loading is verified separately by world-regions.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
});
async function start(page: Page) {
  await page.goto(targetUrl);
  const starter = page.locator('[data-starter="152"]');
  await expect(starter).toBeVisible({ timeout: 25000 });
  await starter.click();
  // This suite validates the preserved Kanto map. Start through the current
  // Johto picker, then explicitly load a Kanto checkpoint instead of relying
  // on the removed Bulbasaur starter to choose the region implicitly.
  const game = createGame(1, 'kanto-ui-start');
  const world = new OpenWorldSimulation(graph, game, 34401, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: false });
  await page.locator('#import-file').setInputFiles({ name: 'kanto-start.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.getByRole('status')).toContainText('불러왔습니다');
  await openExplorePanel(page);
  await page.locator('#world-mode-manual').click();
  await page.locator('#world-auto-hunt').uncheck();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 25000 });
}
async function exported(page: Page) {
  await page.locator('[data-tab="lab"]').click();
  const exportButton = page.locator('#export-save');
  await expect(exportButton).toBeVisible({ timeout: 25000 });
  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  return JSON.parse(await readFile((await download.path())!, 'utf8'));
}
async function storedDeviceSave(page: Page) {
  return page.evaluate(() => new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open('choketmon-151', 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('saves', 'readonly');
      const current = transaction.objectStore('saves').get('current');
      transaction.oncomplete = () => { resolve(current.result); db.close(); };
      transaction.onerror = () => { reject(transaction.error); db.close(); };
      transaction.onabort = () => { reject(transaction.error); db.close(); };
    };
  }));
}

test('Kanto controls, fixed early encounters, shop, region map and mobile layout', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page);
  await page.locator('#world-mode-manual').click();
  await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#world-map-open').click();
  await page.locator('[data-world-travel="pallet"]').click();
  const position = await page.locator('#world-position').innerText();
  await page.waitForTimeout(700); await expect(page.locator('#world-position')).toHaveText(position);
  await page.keyboard.down('w');
  try { await expect(page.locator('#world-position')).not.toHaveText(position); }
  finally { await page.keyboard.up('w'); }
  await page.locator('.world-shop summary').click();
  const money = Number((await page.locator('#money').innerText()).replace(/\D/g, ''));
  await page.locator('[data-world-buy="poke-ball"][data-quantity="5"]').click();
  await expect(page.locator('#money')).toHaveText(`₩${(money - 100).toLocaleString('ko-KR')}`);
  await mkdir('artifacts/kanto-browser', { recursive: true });
  await page.screenshot({ path: 'artifacts/kanto-browser/shop.png' });
  await page.locator('.world-shop summary').click();
  await page.locator('#world-map-open').click();
  await expect(page.locator('#world-map-dialog')).toBeVisible();
  await expect(page.locator('.kanto-zone-list')).toContainText('상록숲');
  await expect(page.locator('.kanto-zone-list')).toContainText('홍련섬');
  await mkdir('artifacts/kanto-browser', { recursive: true });
  await page.screenshot({ path: 'artifacts/kanto-browser/map.png' });
  await page.locator('#world-map-close').click();
  await page.screenshot({ path: 'artifacts/kanto-browser/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await openExplorePanel(page);
  await expect(page.locator('#world-mode-auto')).toBeVisible();
  await page.locator('#world-mode-auto').click();
  await expect(page.locator('#world-mode-auto')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#world-mode-manual').click();
  await page.screenshot({ path: 'artifacts/kanto-browser/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Manual Save is intentionally hidden in the narrow header. Save on desktop,
  // then verify the restored controls again at the mobile viewport.
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('#save-now').click(); await expect(page.getByRole('status')).toContainText('이 기기에 저장했습니다.'); await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await openExplorePanel(page);
  await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true', { timeout: 20000 });
  await expect(page.locator('.world-battle-hud')).not.toHaveAttribute('open', '');
  const save = await exported(page);
  expect(save.view.openWorld.mapVersion).toBe('kanto-v2');
  expect(save.view.openWorld.entities.filter((entity: { kind: string }) => entity.kind === 'wild').length).toBeGreaterThanOrEqual(12);
  expect(errors).toEqual([]);
});

test('inspect a visible wild, pin tracking, teleport and persist experience sharing', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page);
  await expect(page.locator('#world-exp-share')).toBeChecked();
  await page.locator('#world-exp-share').uncheck();
  await page.locator('.world-objective summary').click();
  const chosen = page.locator('[data-world-wild]').first();
  await chosen.click();
  await expect(page.locator('#world-target')).toBeVisible();
  await expect(page.locator('#world-target')).toContainText('이동');
  await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#world-pause').click();
  await page.locator('#world-target-track').click();
  await expect(page.locator('#world-mode-auto')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#world-mode-manual').click();
  await page.screenshot({ path: 'artifacts/kanto-browser/selection.png' });
  await page.locator('#world-map-open').click();
  await expect(page.locator('[data-world-travel="cerulean"]')).toBeDisabled();
  await page.locator('[data-world-travel="pallet"]').click();
  await expect(page.locator('#world-map-dialog')).not.toBeVisible();
  await expect(page.locator('#world-target')).toBeHidden();
  await page.locator('#save-now').click(); await expect(page.getByRole('status')).toContainText('이 기기에 저장했습니다.'); await page.reload();
  await expect(page.locator('#world-exp-share')).not.toBeChecked();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 25000 });
  const save = await exported(page);
  expect(save.game.experienceShare).toBe(false);
  expect(save.view.openWorld.visitedTownIds).toContain('pallet');
  expect(errors).toEqual([]);
});

test('manual battle waits, victory choice survives reload, buying and catching persists', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page);
  const game = createGame(1, 'kanto-ui-victory'), world = new OpenWorldSimulation(graph, game, 34415, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  // A victory with no balls is released immediately by the simulation, so keep
  // one ball available while verifying that the pending choice survives reload.
  game.inventory['poke-ball'] = 1; game.inventory['great-ball'] = 0; game.inventory['ultra-ball'] = 0;
  world.startEncounter(world.entities.find(entity => entity.kind === 'wild')!.id);
  game.player.team[0].moves = [{ moveId: 33, pp: 35 }];
  game.battle!.enemy.team[0].hp = 1; game.battle!.enemy.team[0].status = 'sleep'; game.battle!.enemy.team[0].statusTurns = 3;
  const enemyId = game.battle!.enemy.team[0].instanceId;
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: false });
  await page.locator('#import-file').setInputFiles({ name: 'kanto-battle.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.getByRole('status')).toContainText('불러왔습니다');
  await page.waitForTimeout(1200); await expect(page.locator('#world-battle-state')).toContainText('턴 1');
  await page.locator('[data-world-move="0"]').click();
  await expect(page.locator('#world-capture-offer')).toBeVisible({ timeout: 12000 });
  await page.locator('#save-now').click(); await expect(page.getByRole('status')).toContainText('이 기기에 저장했습니다.'); await page.reload();
  await expect(page.locator('#world-capture-offer')).toBeVisible({ timeout: 25000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 25000 });
  await openExplorePanel(page);
  await page.screenshot({ path: 'artifacts/kanto-browser/victory-choice.png' });
  await page.locator('.world-shop summary').click();
  await page.locator('[data-world-buy="poke-ball"][data-quantity="1"]').click();
  await page.locator('.world-shop summary').click();
  await page.locator('#world-win-catch').click();
  await expect(page.locator('#world-capture-offer')).toBeHidden();
  // Catching queues an autosave. Wait for that write to settle before
  // reloading; the prior manual-save toast has identical text and can be stale.
  await page.waitForTimeout(500);
  await expect(page.locator('#save-state')).toHaveAttribute('data-state', /^(?:local|saved|synced)$/, { timeout: 25000 });
  await page.reload();
  const loaded = await storedDeviceSave(page) as { game: { player: { team: Array<{ instanceId: string }> }; inventory: Record<string, number>; captureOffer?: unknown } };
  expect(loaded.game.player.team.map((mon: { instanceId: string }) => mon.instanceId)).toContain(enemyId);
  expect(loaded.game.inventory['poke-ball']).toBe(1);
  expect(loaded.game.captureOffer).toBeUndefined();
  expect(errors).toEqual([]);
});

test('imports a previous map save onto walkable ground while keeping individual brains', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page);
  const game = createGame(1, 'old-kanto-browser'), world = new OpenWorldSimulation(graph, game, 35211, undefined, policy);
  world.setControlMode('manual');
  const snapshot = world.snapshot(); snapshot.mapVersion = 'kanto-v1'; snapshot.player = { x: 0, z: 0, heading: 0 };
  const partner = snapshot.entities.find(entity => entity.kind === 'companion')!; partner.x = 0; partner.z = 0;
  const before = structuredClone(partner.brain);
  const save = packSave(game, graph, { ...defaultView(), openWorld: snapshot, openWorldPaused: true });
  await page.locator('#import-file').setInputFiles({ name: 'old-kanto.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.getByRole('status')).toContainText('불러왔습니다');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 25000 });
  const loaded = await exported(page), migrated = loaded.view.openWorld;
  expect(migrated.mapVersion).toBe('kanto-v2');
  expect(sampleWorld(migrated.player.x, migrated.player.z).blocked).toBe(false);
  expect(migrated.entities.find((entity: { id: string }) => entity.id === partner.id).brain).toEqual(before);
  expect(errors).toEqual([]);
});
