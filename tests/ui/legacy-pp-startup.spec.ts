import { mockAuthenticatedSession, QA_PROFILE } from './helpers/authenticated-session';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { getMove } from '../../src/data/pokemon';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';

for (const [inBattle, legacyTera] of [[false, false], [true, false], [true, true]]) test(`starts from an existing save with obsolete PP and keeps progress after reload (battle=${inBattle}, tera=${legacyTera})`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**', socket => socket.close());
  await mockAuthenticatedSession(page);
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  const game = createGame(152, 'legacy-pp-startup'), monster = createMonster(game, 54, 39);
  monster.moves = [487, 401, 133, 472].map(moveId => ({ moveId, pp: getMove(moveId).pp }));
  monster.moveOrder = [401, 487, 133, 472];
  monster.moveLearning = { '401': { choices: 7, executed: 6, effective: 4, reward: 2 } };
  monster.xp += 12;
  monster.movePpReserve = { '401': 0, '0244': 0, '999999': 0, '244': getMove(244).pp + 1 };
  game.player.team = [monster]; game.player.money = 4321;
  const world = new OpenWorldSimulation(graph, game, 719); world.setControlMode('manual'); world.setAutoHunt(false);
  if (inBattle) {
    const wild = world.entities.find(entity => entity.kind === 'wild')!; world.battleWildId = wild.id;
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, wild.speciesId, wild.level)], activeIndex: 0 }, turn: 7, canRun: true };
  }
  const envelope = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
  const expectedMoves = monster.moves.map(slot => ({ ...slot, pp: legacyTera ? 1 : slot.pp }));
  if (legacyTera) {
    const legacy = envelope.game as any;
    for (const team of [legacy.player.team, legacy.battle.player.team]) team[0].preferredTransformation = { kind: 'tera', teraType: 'water' };
    legacy.battle.playerTeraUsed = true;
    legacy.battle.transformations = { [monster.instanceId]: { speciesId: monster.speciesId, kind: 'tera', teraType: 'water', types: ['water'], stats: monster.stats, moves: expectedMoves } };
  }
  const legacyInventory = (envelope.game as typeof game).inventory;
  for (const key of Object.keys(legacyInventory)) if (key.startsWith('mega-stone:')) delete legacyInventory[key as keyof typeof legacyInventory];
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await page.locator('[data-tab="team"]').click();
  await page.evaluate(async ({save, slot}) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('choketmon-151', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('saves', 'readwrite'); tx.objectStore('saves').put(save, slot); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, {save: envelope, slot: `account:${QA_PROFILE.id}:current`});
  await page.reload();
  await expect(page.locator('#money')).toContainText('4,321', { timeout: 30000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator(`.monster-card[data-monster="${monster.instanceId}"]`)).toContainText('고라파덕');
  await page.locator('#save-now').click(); await expect(page.locator('#save-state')).toContainText('저장됨');
  const saved = await page.evaluate(async slot => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('choketmon-151', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const save = await new Promise<any>((resolve, reject) => { const tx = db.transaction('saves', 'readonly'), request = tx.objectStore('saves').get(slot); tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); });
    db.close(); return save.game.player.team[0];
  }, `account:${QA_PROFILE.id}:current`);
  expect(saved.instanceId).toBe(monster.instanceId);
  expect(saved.xp).toBe(monster.xp);
  expect(saved.moves).toEqual(expectedMoves);
  if (legacyTera) expect(saved.preferredTransformation).toBeUndefined();
  expect(saved.moveOrder).toEqual(monster.moveOrder);
  expect(saved.moveLearning).toEqual(monster.moveLearning);
  expect(saved.movePpReserve).toEqual({ '244': getMove(244).pp });
  await page.reload(); await expect(page.locator('#money')).toContainText('4,321', { timeout: 30000 });
  await page.screenshot({ path: info.outputPath('restored-save.png'), fullPage: true });
  expect(errors).toEqual([]);
});
