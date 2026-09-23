import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { getWorldAtlas } from '../../src/openworld/atlas';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { openExplorePanel } from './helpers/explore-panel';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
const badges = [1, 2, 3, 4, 5, 6, 7, 8];

test.use({ launchOptions: { args: ['--mute-audio', '--enable-unsafe-webgpu'] } });
test.setTimeout(120_000);

test('seven Alola trials can reach Vast Poni Canyon and start the final trial', async ({ page }) => {
  const errors: string[] = [], loadedGlbs: string[] = [];
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' && /THREE|shader|WebGPU|WGSL|GPUValidation/i.test(message.text())) errors.push(`render: ${message.text()}`);
  });
  page.on('requestfailed', request => {
    if (/\.glb(?:\?|$)/i.test(request.url())) errors.push(`GLB: ${request.url()} · ${request.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', response => {
    if (/\.glb(?:\?|$)/i.test(response.url()) && response.ok()) loadedGlbs.push(response.url());
  });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));

  const game = createGame(1, 'alola-final-trial-ui');
  game.defeatedGyms = [...badges]; game.player.badges = 8; game.championDefeated = true;
  game.campaign = { startRegion: 'kanto', johtoBadges: [], johtoLeague: 0, kantoLeague: 5, redDefeated: false, expansion: {
    hoenn: { badges: [...badges], league: 5 }, sinnoh: { badges: [...badges], league: 5 },
    unova: { badges: [...badges], league: 5 }, kalos: { badges: [...badges], league: 5 },
    alola: { badges: badges.slice(0, 7), league: 0 },
  } };
  const world = new OpenWorldSimulation(graph, game, 76_004, undefined, policy);
  world.changeRegion('alola'); world.setControlMode('manual'); world.setAutoHunt(false);
  // Start beside the destination so this UI check does not depend on minutes of real-time walking.
  const canyon = getWorldAtlas('alola').locations.find(location => location.id === 'vast-poni-canyon')!;
  world.player = { x: canyon.x, z: canyon.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });

  await page.goto('/?renderProbe=1');
  await expect(page.locator('[data-starter="1"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-starter="1"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'alola-final-trial.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.getByRole('status')).toContainText('불러왔습니다');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region', 'alola');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await expect(page.locator('#world-location-short')).toContainText('포니대협곡');

  await page.locator('#world-map-open').click();
  await expect(page.locator('#world-campaign-guide')).toContainText('배지 7/8');
  await expect(page.locator('#world-campaign-guide')).toContainText('대협곡시련');
  await expect(page.locator('#world-campaign-guide')).toContainText('포니대협곡');
  await page.locator('#world-map-close').click();
  await openExplorePanel(page);
  await expect(page.locator('#world-gym-challenge')).toBeEnabled();
  await expect(page.locator('#world-gym-challenge')).toContainText('대협곡시련');

  await expect.poll(() => loadedGlbs.length, { timeout: 45_000, message: 'expected at least one real GLB response' }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().loadedPokemon?.length ?? 0), { timeout: 45_000 }).toBeGreaterThan(0);
  const frames = await page.evaluate(() => (window as any).__renderProbe.read().samples.length);
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe.read().samples.length), { timeout: 10_000 }).toBeGreaterThan(frames);

  await page.locator('#world-gym-challenge').click();
  await expect(page.locator('#world-battle-state')).toContainText('턴 1');
  await expect(page.locator('#world-combatants .world-combatant')).toHaveCount(2);
  expect(errors).toEqual([]);
});
