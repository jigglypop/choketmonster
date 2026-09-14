import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave, type SaveEnvelope } from '../../src/game/storage';
import { getCaveScene } from '../../src/openworld/caves';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { FieldPolicy } from '../../src/game/field';
import { openExplorePanel } from './helpers/explore-panel';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
const cave = getCaveScene('cave:johto:slowpoke-well')!;
const portal = cave.portals[0];
const output = 'artifacts/caves-runtime';

function simulation(seed: number) {
  const game = createGame(152, seed), world = new OpenWorldSimulation(graph, game, seed, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  world.player = { ...portal.surface, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  return { game, world };
}

function saveAtSurface(seed: number): SaveEnvelope {
  const { game, world } = simulation(seed);
  return packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });
}

function saveAtTrainer(seed: number) {
  const { game, world } = simulation(seed);
  expect(world.traverseCavePortal()).toBe(true);
  const trainer = world.trainerRenderData().find(item => item.id === 'crystal-gruntm-gruntm-29');
  expect(trainer).toBeDefined();
  world.player = { x: trainer!.x, z: trainer!.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  return { trainer: trainer!, save: packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false }) };
}

async function load(page: Page, save: SaveEnvelope, expectedScene: string, expectedPosition?: string) {
  await page.goto('/?renderProbe=1');
  await expect(page.locator('[data-starter="152"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#starter-dialog')).not.toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await page.locator('#import-file').setInputFiles({ name: 'cave.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-scene', expectedScene, { timeout: 45_000 });
  if (expectedPosition) await expect(page.locator('#world-position')).toHaveText(expectedPosition, { timeout: 45_000 });
  await openExplorePanel(page);
}

const sceneId = (page: Page) => page.locator('#ow-host').getAttribute('data-scene');

test.beforeAll(() => {
  mkdirSync(output, { recursive: true });
});
test('localized portal enters, persists through reload, and exits the isolated cave', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await load(page, saveAtSurface(95_201), 'surface:johto', '-24, 126');
  const entrance = page.locator(`[data-portal="${portal.id}"]`);
  await expect(entrance).toBeVisible();
  await expect(entrance).toContainText('야돈의 우물');
  await expect(entrance).toContainText('동굴 들어가기');
  await page.locator('#world-cave-enter').click();
  await expect.poll(() => sceneId(page), { timeout: 45_000 }).toBe(cave.sceneId);
  await expect(page.locator('.world-portal-label')).toContainText('밖으로 나가기');
  await page.screenshot({ path: `${output}/slowpoke-well-entered.png` });

  // changed() checkpoints the scene switch; reload must restore the cave rather than duplicate an entry transfer.
  await page.waitForTimeout(1_200); await page.reload();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await expect.poll(() => sceneId(page), { timeout: 45_000 }).toBe(cave.sceneId);
  await openExplorePanel(page);
  const exit = page.locator(`[data-portal="${portal.id}"]`);
  await expect(exit).toContainText('밖으로 나가기');
  await page.locator('#world-pause').click();
  await exit.click();
  await expect(page.locator('#world-cave-enter')).toHaveCount(1, { timeout: 45_000 });
  await expect(page.locator('#world-cave-enter')).toBeVisible({ timeout: 45_000 });
  await page.locator('#world-cave-enter').click();
  await expect.poll(() => sceneId(page), { timeout: 45_000 }).toBe('surface:johto');
  writeFileSync(`${output}/portal-evidence.json`, JSON.stringify({ cave: cave.sceneId, portal: portal.id, label: cave.name, errors }, null, 2));
  expect(errors).toEqual([]);
});

test('cave trainer loads the real GLB and the exact trainer id starts battle', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [], trainerRequests: Array<{ url: string; status: number }> = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.url().includes('/models/trainer.glb')) trainerRequests.push({ url: response.url(), status: response.status() }); });
  const fixture = saveAtTrainer(95_202);
  await load(page, fixture.save, cave.sceneId);
  await expect.poll(() => sceneId(page), { timeout: 45_000 }).toBe(cave.sceneId);
  const label = page.locator(`[data-field-trainer="${fixture.trainer.id}"]`);
  await expect(label).toBeVisible({ timeout: 45_000 });
  await expect(label).toContainText(fixture.trainer.name);
  await expect.poll(() => page.evaluate(id => (window as unknown as { __renderProbe: { read(): { trainers: string[] } } }).__renderProbe.read().trainers.includes(`field-trainer:${id}`), fixture.trainer.id)).toBe(true);
  await expect.poll(() => trainerRequests.some(request => request.status === 200)).toBe(true);
  await page.screenshot({ path: `${output}/slowpoke-well-trainer.png` });
  await label.click();
  await expect(page.locator('#world-battle-state')).toContainText('턴 1');
  writeFileSync(`${output}/trainer-evidence.json`, JSON.stringify({ sceneId: cave.sceneId, trainerId: fixture.trainer.id, trainerRequests, errors }, null, 2));
  expect(errors).toEqual([]);
});
