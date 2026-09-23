import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

async function stored(page: Page) {
  return page.evaluate(() => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open('choketmon-151', 2);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('saves', 'readonly'), store = tx.objectStore('saves');
      const current = store.get('current'), keys = store.getAllKeys(), values = store.getAll();
      tx.oncomplete = () => { resolve({ current: current.result, keys: keys.result, values: values.result }); db.close(); };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  }));
}

test('Red layout stays fixed through record selectors, legacy import and reload, with an original backup', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
  const game = createGame(1, 'red-layout-ui'); game.adventureVersion = 'national';
  game.player.box.push(createMonster(game, 25, 20)); game.dex.seen.push(25); game.dex.caught.push(25);
  game.versionCaught = { red: [1], national: [25], yellow: [25] };
  const world = new OpenWorldSimulation(graph, game, 73011);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const snapshot = world.snapshot(), obsolete = snapshot.entities.find(entity => entity.kind === 'wild')!;
  delete snapshot.encounterLayout;
  Object.assign(obsolete, { speciesId: 150, level: 70, x: -68, z: 66 });
  const save = packSave(game, graph, { ...defaultView(), openWorld: snapshot, openWorldPaused: true, learning: false });
  await page.goto('/'); await expect(page.locator('[data-starter="1"]')).toBeVisible({ timeout: 30000 });
  await page.locator('[data-starter="1"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'legacy-national.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#world-version')).toHaveValue('national');
  await expect.poll(async () => (await stored(page)).current?.view.openWorld?.encounterLayout).toBe('red-v1');
  const first = await stored(page), fixed = first.current.view.openWorld;
  expect([16, 19]).toContain(fixed.entities.find((entity: any) => entity.id === obsolete.id).speciesId);
  const backups = () => stored(page).then(data => data.keys.filter((key: string) => key.startsWith('backup-before-red-layout-')));
  const backupIndex = first.keys.findIndex((key: string) => key.startsWith('backup-before-red-layout-'));
  expect(backupIndex).toBeGreaterThanOrEqual(0);
  expect(first.values[backupIndex].view.openWorld.entities.find((entity: any) => entity.id === obsolete.id).speciesId).toBe(150);
  const backupCount = (await backups()).length;
  for (const version of ['yellow', 'national']) {
    await page.locator('#world-version').selectOption(version);
    await expect.poll(async () => (await stored(page)).current?.game.adventureVersion).toBe(version);
    expect((await stored(page)).current.view.openWorld).toEqual(fixed);
  }
  await page.locator('[data-tab="dex"]').click(); await page.locator('#dex-version').selectOption('blue');
  await expect(page.locator('.collection-note')).toContainText('레드 기준으로 고정');
  await page.locator('#collect-version').click();
  await expect(page.locator('#world-version')).toHaveValue('blue');
  await expect.poll(async () => (await stored(page)).current?.game.adventureVersion).toBe('blue');
  expect((await stored(page)).current.view.openWorld).toEqual(fixed);
  await page.reload(); await expect(page.locator('#world-version')).toHaveValue('blue', { timeout: 30000 });
  expect((await stored(page)).current.view.openWorld).toEqual(fixed);
  expect((await stored(page)).current.game.player.box[0]).toMatchObject({ speciesId: 25, level: 20 });
  expect((await stored(page)).current.game.versionCaught).toMatchObject(game.versionCaught!);
  expect((await backups()).length).toBe(backupCount);
  await page.setViewportSize({ width: 390, height: 844 });
  const output = process.env.CHOKETMON_RED_ARTIFACTS ?? 'artifacts/red-layout/local'; mkdirSync(output, { recursive: true });
  await page.locator('.world-explore-toggle').screenshot({ path: `${output}/fixed-layout-mobile.png` });
  expect(errors).toEqual([]);
});
