import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createGame, createMonster, experienceAtLevel } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { getSpecies } from '../../src/data/pokemon';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
test.setTimeout(90000);
async function start(page: Page) { await page.goto('/'); await page.locator('[data-starter="1"]').click(); await page.locator('#world-mode-manual').click(); await page.locator('#world-auto-hunt').uncheck(); await expect(page.locator('#ow-host canvas')).toBeVisible(); await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 20000 }); }
async function exported(page: Page) {
  await page.locator('[data-tab="lab"]').click();
  const download = page.waitForEvent('download'); await page.locator('#export-save').click();
  return JSON.parse(await readFile((await (await download).path())!, 'utf8'));
}
async function load(page: Page, simulation: OpenWorldSimulation) {
  simulation.setAutoHunt(false);
  const save = packSave(simulation.game, graph, { ...defaultView(), openWorld: simulation.snapshot(), openWorldPaused: true });
  await page.locator('#import-file').setInputFiles({ name: 'world.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.getByRole('status')).toContainText('불러왔습니다');
}

test('open world moves, pauses, and restores all brains without duplicating topology', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page);
  await page.locator('#world-mode-manual').click();
  const position = await page.locator('#world-position').innerText();
  await page.keyboard.down('s');
  try { await expect(page.locator('#world-position')).not.toHaveText(position); }
  finally { await page.keyboard.up('s'); }
  await page.locator('#world-pause').click();
  const tick = await page.locator('#ow-host').getAttribute('data-tick');
  await page.waitForTimeout(550);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-tick', tick!);
  await page.locator('#save-now').click(); await expect(page.getByRole('status')).toContainText('저장했습니다');
  const moved = await page.locator('#world-position').innerText();
  await page.reload();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-tick', tick!);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'true');
  await expect(page.locator('#world-position')).toHaveText(moved);
  const save = await exported(page);
  expect(save.view.openWorld.entities.length + save.view.openWorld.respawnQueue.length).toBe(16);
  expect(save.view.openWorld.entities.every((entity: { brain: { graph?: unknown; graphId: string; sensoryBypass: boolean } }) => !entity.brain.graph && entity.brain.graphId === graph.id && entity.brain.sensoryBypass === false)).toBe(true);
  expect(JSON.stringify(save).match(/"edges":/g)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('automatic world battle rewards, levels, evolves and retains the same world canvas', async ({ page }) => {
  await start(page);
  const game = createGame(1, 'ui-world-win'); game.player.team = [createMonster(game, 1, 15)];
  const lead = game.player.team[0]; lead.xp = experienceAtLevel(16, getSpecies(1).growthRate) - 1;
  lead.moves = [{ moveId: 33, pp: 35 }];
  const world = new OpenWorldSimulation(graph, game, 937, undefined, policy);
  world.startEncounter(world.entities.find(entity => entity.kind === 'wild')!.id);
  const enemy = game.battle!.enemy.team[0]; enemy.hp = 1; enemy.status = 'sleep'; enemy.statusTurns = 3;
  const money = game.player.money;
  await load(page, world);
  await expect(page.locator('.world-move')).toHaveCount(4);
  await page.locator('[data-world-move="0"]').click();
  await page.locator('#world-pause').click();
  await expect(page.locator('#world-capture-offer')).toBeVisible({ timeout: 15000 });
  await page.locator('#world-win-release').click();
  await expect(page.locator('#world-battle-state')).toHaveText('접근하면 자동 배틀', { timeout: 15000 });
  await expect(page.locator('#ow-host canvas')).toBeVisible(); await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
  await page.locator('#world-pause').click();
  const save = await exported(page);
  expect(save.game.player.money).toBeGreaterThan(money);
  expect(save.game.player.team[0].speciesId).toBe(2);
  expect(save.game.player.team[0].level).toBe(16);
  expect(save.game.player.team[0].instanceId).toBe(lead.instanceId);
  expect(save.game.player.team[0].moves.length).toBeLessThanOrEqual(4);
});

test('world capture consumes a ball and keeps the new individual after reload', async ({ page }) => {
  await start(page);
  const game = createGame(1, 'ui-world-catch'); game.inventory['ultra-ball'] = 10;
  const world = new OpenWorldSimulation(graph, game, 341, undefined, policy);
  world.startEncounter(world.entities.find(entity => entity.kind === 'wild')!.id);
  game.battle!.enemy.team[0].hp = 1; game.battle!.enemy.team[0].status = 'sleep'; game.battle!.enemy.team[0].statusTurns = 3;
  await load(page, world);
  await page.locator('#world-auto-catch').check(); await page.locator('#world-catch').click(); await page.locator('#world-pause').click();
  await expect(page.locator('#world-battle-state')).toHaveText('접근하면 자동 배틀', { timeout: 15000 });
  await page.locator('#world-pause').click();
  await page.locator('#save-now').click(); await expect(page.getByRole('status')).toContainText('저장했습니다');
  await page.reload();
  const save = await exported(page);
  expect(save.game.player.team).toHaveLength(2);
  expect(save.game.inventory['ultra-ball']).toBeLessThan(10);
  expect(new Set(save.game.player.team.map((mon: { instanceId: string }) => mon.instanceId)).size).toBe(2);
});
