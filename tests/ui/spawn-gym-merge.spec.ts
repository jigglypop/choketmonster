import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createGame, createMonster, experienceAtLevel, type GameState } from '../../src/game/engine';
import { defaultView, packSave, type SaveEnvelope } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { KANTO_LOCATIONS } from '../../src/openworld/kanto';
import { openExplorePanel } from './helpers/explore-panel';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
const output = process.env.CHOKETMON_FLOW_ARTIFACTS ?? 'artifacts/spawn-gym-merge/local';
test.setTimeout(120000);
test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  mkdirSync(output, { recursive: true });
});

async function load(page: Page, save: SaveEnvelope) {
  await page.goto('/');
  await expect(page.locator('[data-starter="152"]')).toBeVisible({ timeout: 30000 });
  await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'flow.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await openExplorePanel(page);
}

async function exported(page: Page) {
  await page.locator('[data-tab="lab"]').click();
  const download = page.waitForEvent('download'); await page.locator('#export-save').click();
  return JSON.parse(await readFile((await (await download).path())!, 'utf8')) as SaveEnvelope & { game: GameState };
}

test('Red keeps distant individuals while standing still instead of refilling them on the old timer', async ({ page }) => {
  const game = createGame(1, 'red-idle-ui'), world = new OpenWorldSimulation(graph, game, 4401, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  world.selectWild(world.entities.find(entity => entity.kind === 'wild')!.id, true);
  const snapshot = world.snapshot();
  snapshot.player = { x: -68, z: -7, heading: 0 };
  Object.assign(snapshot.entities.find(entity => entity.kind === 'companion')!, snapshot.player);
  delete snapshot.spawnAnchor; snapshot.densityRemaining = .01;
  const save = packSave(game, graph, { ...defaultView(), openWorld: snapshot, openWorldPaused: true, learning: false });
  await load(page, save);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await expect(page.locator('#world-version')).toHaveValue('red');
  await page.locator('#world-pause').click();
  await expect.poll(async () => Number(await page.locator('[data-tick]').first().getAttribute('data-tick')), { timeout: 15000 }).toBeGreaterThanOrEqual(snapshot.tick + 24);
  await page.locator('#world-pause').click();
  const current = await exported(page);
  expect(current.view.openWorld!.spawnSerial).toBe(snapshot.spawnSerial);
  expect(current.view.openWorld!.entities.map(entity => entity.id)).toEqual(snapshot.entities.map(entity => entity.id));
  expect(current.view.openWorld!.densityRemaining).toBeUndefined();
});

test('bulk merge previews every donor, cancels safely, keeps a boxed survivor and persists the capped result', async ({ page }) => {
  const errors: string[] = [], dialogs: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  const game = createGame(1, 'merge-all-ui'), target = createMonster(game, 1, 99), donor = createMonster(game, 1, 100);
  game.player.box.push(target, donor);
  const world = new OpenWorldSimulation(graph, game, 38219, undefined, policy);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
  await load(page, save);
  await page.locator('[data-tab="team"]').click();
  await page.locator('[data-monster="mon-2"]').click();
  await expect(page.locator('#merge-all-duplicates')).toContainText('2마리');
  await page.locator('#merge-all-duplicates').click();
  const modal = page.getByRole('dialog', { name: '모두 합치기' });
  await expect(modal).toContainText('mon-2'); await expect(modal).toContainText('박스에서 팀으로');
  await expect(modal).toContainText('초과 20레벨');
  await modal.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.locator('[data-monster="mon-1"]')).toHaveCount(1);
  await expect(page.locator('[data-monster="mon-3"]')).toHaveCount(1);
  await page.locator('#open-interface-settings').click();
  await page.locator('#interface-font-size').evaluate((input: HTMLInputElement) => { input.value = '150'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('.settings-close').click();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.locator('#merge-all-duplicates').click();
  expect(await modal.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1 && dialog.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await modal.screenshot({ path: `${output}/merge-all-mobile.png` });
  await modal.getByRole('button', { name: '2마리 합치기' }).click();
  await expect(page.locator('#toast')).toContainText('2마리를 합쳐');
  await expect(page.locator('.team-monster')).toHaveCount(1);
  await expect(page.locator('.team-monster')).toHaveAttribute('data-monster', 'mon-2');
  const current = await exported(page);
  expect(current.game.player.box).toHaveLength(0);
  expect(current.game.player.team[0]).toMatchObject({ instanceId: 'mon-2', level: 100, xp: experienceAtLevel(100, 'medium-slow') });
  const backup = await page.evaluate(() => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open('choketmon-151', 2);
    request.onsuccess = () => { const db = request.result, tx = db.transaction('saves', 'readonly'), keys = tx.objectStore('saves').getAllKeys(), read = tx.objectStore('saves').getAll(); tx.oncomplete = () => { resolve(read.result[keys.result.findIndex(key => String(key).includes('backup-before-merge-all-'))]); db.close(); }; tx.onerror = () => reject(tx.error); };
    request.onerror = () => reject(request.error);
  }));
  expect(backup.game.player.team[0].instanceId).toBe('mon-1'); expect(backup.game.player.box).toHaveLength(2);
  await page.reload();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.team-monster')).toHaveAttribute('data-monster', 'mon-2', { timeout: 30000 });
  await expect(page.locator('.team-monster')).toContainText('Lv.100');
  expect(dialogs).toEqual([]); expect(errors).toEqual([]);
});

test('a gym win shows its badge, real reward and unlocked route, pauses the world and never awards twice', async ({ page }) => {
  const errors: string[] = [], dialogs: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  const game = createGame(1, 'kanto-gameplay-38215'), world = new OpenWorldSimulation(graph, game, 38215, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const city = KANTO_LOCATIONS.find(location => location.id === 'pewter')!;
  world.player = { x: city.x, z: city.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  expect(world.challengeLocalGym()).toBe(true);
  game.player.team[0].moves = [{ moveId: 33, pp: 35 }];
  Object.assign(game.battle!.enemy.team[0], { hp: 1, status: 'sleep', statusTurns: 3 });
  world.requestAction({ type: 'move', index: 0 });
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });
  await load(page, save);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await page.locator('#world-pause').click();
  const modal = page.getByRole('dialog', { name: '회색배지 획득!' });
  await expect(modal).toBeVisible({ timeout: 20000 });
  await expect(modal).toContainText('관장 웅'); await expect(modal).toContainText('₩1,500');
  await expect(modal).toContainText('회색시티 → 3번 도로');
  await expect(modal.getByRole('button', { name: '모험 계속하기' })).toBeFocused();
  const clock = page.locator('[data-tick]').first(), tick = await clock.getAttribute('data-tick');
  await page.waitForTimeout(3500); await expect(clock).toHaveAttribute('data-tick', tick!);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await modal.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1 && dialog.getBoundingClientRect().right <= innerWidth)).toBe(true);
    if (width === 390) await modal.screenshot({ path: `${output}/gym-victory-mobile.png` });
  }
  await modal.getByRole('button', { name: '모험 계속하기' }).click();
  await expect(modal).toHaveCount(0);
  await page.locator('#world-pause').click();
  await expect(page.locator('#world-gym')).toContainText('클리어');
  const current = await exported(page);
  expect(current.game.defeatedGyms).toEqual([1]); expect(current.game.player.badges).toBe(1);
  expect(current.game.player.money).toBe(game.player.money + 1500); expect(current.game.battle).toBeUndefined();
  await page.reload(); await page.locator('[data-tab="map"]').click();
  await expect(page.locator('#world-gym')).toContainText('클리어', { timeout: 30000 });
  await expect(modal).toHaveCount(0); await expect(page.locator('#money')).toContainText('4,500');
  expect(dialogs).toEqual([]); expect(errors).toEqual([]);
});
