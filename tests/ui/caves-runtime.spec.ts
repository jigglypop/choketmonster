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
const output = process.env.CAVE_UI_ARTIFACTS ?? 'artifacts/caves-runtime';

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

function saveInCave(seed: number) {
  const { game, world } = simulation(seed);
  expect(world.traverseCavePortal()).toBe(true);
  return packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });
}

async function load(page: Page, save: SaveEnvelope, expectedScene: string, expectedPosition?: string) {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
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
  // Restoring the renderer initially places Html labels at (0, 0). Wait for
  // projection before resuming so idle auto mode cannot start during the wait.
  await expect.poll(() => exit.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  }), { timeout: 45_000 }).toBe(true);
  await page.locator('#world-pause').click();
  await exit.click();
  await expect(page.locator('#world-cave-enter')).toHaveCount(1, { timeout: 45_000 });
  await expect(page.locator('#world-cave-enter')).toBeVisible({ timeout: 45_000 });
  await page.locator('#world-cave-enter').click();
  await expect.poll(() => sceneId(page), { timeout: 45_000 }).toBe('surface:johto');
  writeFileSync(`${output}/portal-evidence.json`, JSON.stringify({ cave: cave.sceneId, portal: portal.id, label: cave.name, errors }, null, 2));
  expect(errors).toEqual([]);
});

test('cave renders Pokemon and its environment without human field NPCs', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [], trainerRequests: Array<{ url: string; status: number }> = [], rockTextures = new Set<string>();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.url().includes('/models/trainer.glb')) trainerRequests.push({ url: response.url(), status: response.status() }); });
  page.on('response', response => { if (response.url().includes('rock_boulder_dry_') && response.status() === 200) rockTextures.add(response.url().split('?')[0].split('/').pop()!); });
  await load(page, saveInCave(95_202), cave.sceneId);
  await expect.poll(() => sceneId(page), { timeout: 45_000 }).toBe(cave.sceneId);
  await expect(page.locator('[data-field-trainer]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __renderProbe?: { read(): { loadedPokemon: number[] } } }).__renderProbe?.read().loadedPokemon.length ?? 0), { timeout: 45_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: `${output}/slowpoke-well-without-npcs.png` });
  const composition = await page.evaluate(() => {
    const describe = (element: Element | null) => element ? { tag: element.tagName, id: element.id, className: element.className } : null;
    const rect = (element: Element | null) => element ? (({ x, y, width, height }) => ({ x, y, width, height }))(element.getBoundingClientRect()) : null;
    return {
      artifactPoint: document.elementsFromPoint(1_000, 850).map(describe),
      canvas: rect(document.querySelector('#ow-host canvas')),
      iframe: rect(document.querySelector('#game-music-panel iframe')),
      musicPanel: rect(document.querySelector('#game-music-panel')),
      renderer: (window as unknown as { __renderProbe?: { read(): { backend?: string; streaming?: unknown; renderables: Array<{ name: string; instances: number }>; caveSurfaces: Array<{ name: string; material: string; albedoLoaded: boolean; normalLoaded: boolean; roughnessLoaded: boolean; tiled: boolean }> } } }).__renderProbe?.read(),
    };
  });
  expect(composition.renderer).toMatchObject({ background: '182326', fog: null, clearAlpha: 1 });
  expect(composition.renderer).toMatchObject({ trainers: [] });
  const surfaces = composition.renderer!.caveSurfaces;
  expect(surfaces.map(surface => surface.name).sort()).toEqual(['cave-floor', 'cave-wall:0', 'cave-wall:1', 'cave-wall:2', 'cave-wall:3']);
  expect(new Set(surfaces.map(surface => surface.material)).size).toBe(1);
  expect(surfaces.every(surface => surface.albedoLoaded && surface.normalLoaded && surface.roughnessLoaded && surface.tiled)).toBe(true);
  expect([...rockTextures].sort()).toEqual(['rock_boulder_dry_arm.webp', 'rock_boulder_dry_diff.webp', 'rock_boulder_dry_nor_gl.webp']);
  expect(trainerRequests).toEqual([]);
  writeFileSync(`${output}/npc-removal-evidence.json`, JSON.stringify({ sceneId: cave.sceneId, trainerRequests, composition, errors }, null, 2));
  expect(errors).toEqual([]);
});
