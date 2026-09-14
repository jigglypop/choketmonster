import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createGame, createMonster, experienceAtLevel } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { getSpecies } from '../../src/data/pokemon';
import { openExplorePanel } from './helpers/explore-panel';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
test.setTimeout(90000);
async function start(page: Page, url = '/') {
  await page.goto(url);
  await expect(page.locator('[data-starter="152"]')).toBeVisible();
  await page.locator('[data-starter="152"]').click();
  // A visible canvas alone does not mean panel initialization and input binding succeeded.
  await expect(page.locator('#world-position')).toHaveText(/^-?\d+, -?\d+$/);
  await openExplorePanel(page);
  await page.locator('#world-mode-manual').click();
  await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#world-auto-hunt').uncheck();
  await expect(page.locator('#ow-host canvas')).toBeVisible();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
}
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
  test.setTimeout(150000);
  await page.setViewportSize({ width: 1280, height: 850 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page, '/?renderProbe');
  const renderedPartner = () => page.evaluate(() => {
    const probe = (window as unknown as { __renderProbe: { read(): { creatures: { id: string; position: number[] }[] } } }).__renderProbe;
    return probe.read().creatures.find(creature => creature.id.startsWith('companion:'))!.position;
  });
  // Toggling auto-hunt leaves a checkbox focused; it must not suppress walking.
  await expect(page.locator('#world-auto-hunt')).toBeFocused();
  const before = await renderedPartner();
  const initialTick = await page.locator('#ow-host').getAttribute('data-tick');
  await expect(page.locator('#ow-host')).not.toHaveAttribute('data-tick', initialTick!);
  const position = await page.locator('#world-position').innerText();
  await page.keyboard.down('s');
  try { await expect(page.locator('#world-position')).not.toHaveText(position); }
  finally { await page.keyboard.up('s'); }
  await expect.poll(async () => { const after = await renderedPartner(); return Math.hypot(after[0] - before[0], after[2] - before[2]); }).toBeGreaterThan(.25);
  const after = await renderedPartner();
  await test.info().attach('rendered-partner-movement', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
  await test.info().attach('walking-restored', { body: await page.screenshot(), contentType: 'image/png' });
  await page.locator('#world-pause').click();
  const tick = await page.locator('#ow-host').getAttribute('data-tick');
  const pausedPosition = await page.locator('#world-position').innerText();
  await page.keyboard.down('ArrowDown');
  try { await page.waitForTimeout(550); }
  finally { await page.keyboard.up('ArrowDown'); }
  await expect(page.locator('#world-position')).toHaveText(pausedPosition);
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
  await page.locator('[data-tab="map"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true');
  await openExplorePanel(page);
  await page.locator('#world-pause').click();
  await page.keyboard.down('ArrowDown');
  try { await expect(page.locator('#world-position')).not.toHaveText(moved); }
  finally { await page.keyboard.up('ArrowDown'); }
  expect(errors).toEqual([]);
});

test('direction pad moves a healthy partner and stops when released', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  // Keep this input check independent of an automatic battle during shader loading.
  const world = new OpenWorldSimulation(graph, createGame(1, 'ui-direction-pad'), 35211, undefined, policy);
  world.setControlMode('manual');
  await load(page, world);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true');
  await page.locator('#world-pause').click();
  const position = await page.locator('#world-position').innerText();
  const button = page.getByRole('button', { name: '남쪽 이동' });
  const bounds = (await button.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  try { await expect(page.locator('#world-position')).not.toHaveText(position); }
  finally { await page.mouse.up(); }
  const stopped = await page.locator('#world-position').innerText();
  await page.waitForTimeout(550);
  await expect(page.locator('#world-position')).toHaveText(stopped);
  await test.info().attach('touch-movement', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('left click walks to ground and keyboard input cancels the route', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 850 });
  await start(page, '/?renderProbe');
  const canvas = page.locator('#ow-host canvas');
  const bounds = (await canvas.boundingBox())!;
  const before = await page.locator('#world-position').innerText();
  for (const [x, y] of [[.55, .72], [.43, .55], [.7, .42]] as const) {
    await page.mouse.click(bounds.x + bounds.width * x, bounds.y + bounds.height * y);
    try { await expect(page.locator('#world-position')).not.toHaveText(before, { timeout: 2500 }); break; } catch { /* Try another unobscured patch of ground. */ }
  }
  await expect(page.locator('#world-position')).not.toHaveText(before);
  await page.keyboard.press('KeyW');
  const cancelledAt = await page.locator('#world-position').innerText();
  await page.waitForTimeout(900);
  await expect(page.locator('#world-position')).toHaveText(cancelledAt);
  expect(errors).toEqual([]);
});

test('right drag orbits the camera and zoom controls stay bounded', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await start(page, '/?renderProbe');
  const camera = () => page.evaluate(() => (window as unknown as { __renderProbe: { read(): { camera: number[] } } }).__renderProbe.read().camera);
  const bounds = (await page.locator('#ow-host canvas').boundingBox())!;
  const before = await camera();
  await page.mouse.move(bounds.x + bounds.width * .55, bounds.y + bounds.height * .55);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(bounds.x + bounds.width * .7, bounds.y + bounds.height * .55, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await expect.poll(async () => { const after = await camera(); return Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]); }).toBeGreaterThan(1);
  await page.getByRole('button', { name: '카메라 확대' }).evaluate((button: HTMLButtonElement) => { for (let index = 0; index < 30; index += 1) button.click(); });
  const near = await camera();
  const player = (await page.locator('#world-position').innerText()).split(',').map(Number);
  expect(Math.hypot(near[0] - player[0], near[1] - 1.2, near[2] - player[1])).toBeGreaterThanOrEqual(3.9);
  await page.getByRole('button', { name: '카메라 축소' }).evaluate((button: HTMLButtonElement) => { for (let index = 0; index < 30; index += 1) button.click(); });
  const far = await camera();
  expect(Math.hypot(far[0] - player[0], far[1] - 1.2, far[2] - player[1])).toBeLessThanOrEqual(48.5);
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
