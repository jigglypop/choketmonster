import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { getWorldAtlas } from '../../src/openworld/atlas';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
const output = process.env.WORLD_VISUAL_ARTIFACTS ?? 'artifacts/world-visuals-runtime';

test.beforeAll(() => mkdirSync(output, { recursive: true }));

async function load(page: Page, save: ReturnType<typeof packSave>) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/?renderProbe=1');
  await expect(page.locator('[data-starter="152"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'visual.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().loadedPokemon.length ?? 0), { timeout: 45_000 }).toBeGreaterThan(0);
  return errors;
}

function leagueSave(region: 'johto' | 'kanto') {
  const game = createGame(152, `league-visual-${region}`);
  game.campaign = { startRegion: 'johto', johtoBadges: [1, 2, 3, 4, 5, 6, 7, 8], johtoLeague: region === 'kanto' ? 5 : 0, kantoLeague: 0, redDefeated: false };
  if (region === 'kanto') { game.player.badges = 8; game.defeatedGyms = [1, 2, 3, 4, 5, 6, 7, 8]; }
  const world = new OpenWorldSimulation(graph, game, region === 'kanto' ? 9711 : 9712, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  if (region === 'kanto') world.changeRegion('kanto');
  const locationId = region === 'kanto' ? 'indigo-plateau' : 'tohjo-falls';
  const destination = getWorldAtlas(region).locations.find(item => item.id === locationId)!;
  world.player = { x: destination.x, z: destination.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  return packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });
}

for (const region of ['kanto', 'johto'] as const) test(`${region} league hall renders with a real Pokemon GLB`, async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await load(page, leagueSave(region));
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().landmarks ?? []), { timeout: 45_000 })
    .toContain(`landmark:league:${region}`);
  await page.screenshot({ path: `${output}/${region}-league.png` });
  expect(errors).toEqual([]);
});

test('campaign fly guide renders a route in the live scene', async ({ page }) => {
  test.setTimeout(120_000);
  const game = createGame(152, 'fly-guide-visual');
  const world = new OpenWorldSimulation(graph, game, 9713, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const errors = await load(page, packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false }));
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().landmarks ?? []), { timeout: 45_000 })
    .toContain('campaign-fly-guide');
  await expect(page.locator('#world-next-guide')).toHaveAttribute('data-status', 'route');
  await page.screenshot({ path: `${output}/campaign-fly-guide.png` });
  expect(errors).toEqual([]);
});
