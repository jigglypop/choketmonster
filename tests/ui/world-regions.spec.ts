import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { getWorldAtlas, getLegacyJohtoAtlas } from '../../src/openworld/atlas';
import type { Graph } from '../../src/core/brain';

const model152 = readFileSync('data/local/pokemon-models-expanded/429de1288cea0d43f5b4f56305d2276e94239d65/152.glb');

test('migrates a legacy Johto save to reconstructed Johto and renders the preserved real model', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [], modelRequests = new Set<string>();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/Pokemon-3D-api.*\/152\.glb/.test(request.url())) modelRequests.add(request.url()); });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route('https://raw.githubusercontent.com/Pokemon-3D-api/assets/**/152.glb', route => route.fulfill({ body: model152, contentType: 'model/gltf-binary' }));
  await page.goto('/?renderProbe=1');
  await page.locator('[data-starter="1"]').click();

  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  const game = createGame(1, 'johto-migration-ui'), partner = createMonster(game, 152, 5);
  game.player.team = [partner]; game.dex.seen.push(152); game.dex.caught.push(152);
  game.dex.seen.sort((a, b) => a - b); game.dex.caught.sort((a, b) => a - b);
  game.versionCaught = { red: [1], gold: [152] };
  const world = new OpenWorldSimulation(graph, game, 9402), checkpoint = world.snapshot(), johto = getLegacyJohtoAtlas();
  world.setControlMode('manual');
  checkpoint.regionId = 'johto'; checkpoint.mapVersion = johto.mapVersion; checkpoint.player = { ...johto.start, heading: 0 };
  checkpoint.visitedTownIds = ['new-bark']; checkpoint.visitedTownsByRegion = { kanto: ['pallet'], johto: ['new-bark'] };
  checkpoint.entities.forEach(entity => { entity.x = johto.start.x; entity.z = johto.start.z; });
  const foodPoints: Array<{ x: number; z: number }> = [];
  for (let x = -118; x <= 118 && foodPoints.length < checkpoint.foods.length; x++) for (let z = -118; z <= 118 && foodPoints.length < checkpoint.foods.length; z++) {
    if (!johto.sample(x, z).blocked) foodPoints.push({ x, z });
  }
  checkpoint.foods.forEach((food, index) => Object.assign(food, foodPoints[index]));
  const companionMemory = structuredClone(checkpoint.entities.find(entity => entity.kind === 'companion')!.brain);
  game.adventureVersion = 'gold';
  const save = packSave(game, graph, { ...defaultView(), openWorld: checkpoint, openWorldPaused: true });
  await page.locator('#import-file').setInputFiles({ name: 'legacy-johto.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });

  await expect(page.locator('#ow-host')).toHaveAttribute('data-region', 'johto');
  await expect(page.locator('#world-version')).toHaveValue('gold');
  await page.locator('#world-map-open').click();
  await expect(page.locator('#world-region option')).toHaveCount(2);
  await expect(page.locator('#world-region')).toHaveValue('johto');
  await page.locator('#world-map-close').click();

  const probe = () => page.evaluate(() => (window as any).__renderProbe?.read());
  await expect.poll(async () => (await probe())?.loadedPokemon ?? [], { timeout: 45000 }).toContain(152);
  const first = await probe();
  expect(first.streaming.detailedCreatures).toBeLessThanOrEqual(8);
  expect(first.streaming.activeLoads).toBeLessThanOrEqual(3);
  expect(modelRequests.size).toBeGreaterThan(0);

  const stored = await page.evaluate(() => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open('choketmon-151', 2);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('saves', 'readonly'), store = tx.objectStore('saves');
      const current = store.get('current'), keys = store.getAllKeys(), values = store.getAll();
      tx.oncomplete = () => { resolve({ current: current.result, keys: keys.result, values: values.result }); db.close(); };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  }));
  expect(stored.current.game.adventureVersion).toBe('gold');
  expect(stored.current.game.versionCaught.gold).toEqual([152]);
  expect(stored.current.view.openWorld.regionId).toBe('johto');
  expect(stored.current.view.openWorld.visitedTownsByRegion.johto).toEqual(['new-bark']);
  expect(stored.current.view.openWorld.entities.find((entity: { kind: string }) => entity.kind === 'companion').brain).toEqual(companionMemory);
  const backupIndex = stored.keys.findIndex((key: IDBValidKey) => String(key).startsWith('backup-before-map-'));
  expect(backupIndex).toBeGreaterThanOrEqual(0);
  const backup = stored.values[backupIndex];
  expect(backup.game.adventureVersion).toBe('gold');
  expect(backup.view.openWorld.regionId).toBe('johto');
  expect(backup.view.openWorld.entities.find((entity: { kind: string }) => entity.kind === 'companion').brain).toEqual(companionMemory);

  await page.reload();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region', 'johto');
  await expect(page.locator('#world-version')).toHaveValue('gold');
  await expect.poll(async () => (await probe())?.loadedPokemon ?? [], { timeout: 45000 }).toContain(152);
  const restored = await probe();
  expect(restored.streaming.detailedCreatures).toBeLessThanOrEqual(8);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await expect(page.locator('.world-battle-hud')).not.toHaveAttribute('open', '');
  await expect.poll(async () => (await probe())?.loadedPokemon ?? [], { timeout: 45000 }).toContain(152);
  await expect.poll(async () => (await probe())?.streaming?.modelLimit).toBe(4);
  expect((await probe()).streaming.detailedCreatures).toBeLessThanOrEqual(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.waitForTimeout(1000);
  mkdirSync('artifacts/world-expansion', { recursive: true });
  await page.screenshot({ path: 'artifacts/world-expansion/johto-migrated-mobile.png' });
  writeFileSync('artifacts/world-expansion/johto-migration-browser.json', JSON.stringify({ first, restored, mobile: await probe(), modelRequests: [...modelRequests], errors }, null, 2));
  expect(errors).toEqual([]);
});
