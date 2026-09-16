import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
const cases = [
  ['hoenn', 252, 'hoenn-route-111', 'desert'],
  ['sinnoh', 387, 'mt-coronet', 'mountain'],
  ['alola', 722, 'mount-lanakila', 'snow'],
] as const;

test('desert, mountain and snow relief render through the textured terrain pipeline', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/?renderProbe=1');
  await page.locator('[data-starter="152"]').click();
  await expect.poll(() => page.locator('#import-file').evaluate(input => typeof (input as HTMLInputElement).onchange === 'function'), { timeout: 30_000 }).toBe(true);
  mkdirSync('artifacts/terrain-landforms', { recursive: true });

  for (const [region, starter, locationId, surface] of cases) {
    const game = createGame(152, `terrain-${surface}`);
    game.player.badges = 8; game.defeatedGyms = [1,2,3,4,5,6,7,8]; game.championDefeated = true;
    game.campaign!.johtoBadges = [1,2,3,4,5,6,7,8]; game.campaign!.johtoLeague = 5; game.campaign!.kantoLeague = 5;
    const sequence = ['hoenn', 'sinnoh', 'unova', 'kalos', 'alola'] as const;
    game.campaign!.expansion = Object.fromEntries(sequence.slice(0, sequence.indexOf(region)).map(id => [id, { badges: [1,2,3,4,5,6,7,8], league: 5 }]));
    game.claimedRegionalStarters = ['kanto', 'johto', 'hoenn', 'sinnoh', 'unova', 'kalos', 'alola'];
    game.player.team = [createMonster(game, starter, 35, region)]; game.dex.seen = [152, starter]; game.dex.caught = [152, starter];
    const world = new OpenWorldSimulation(graph, game, 9910 + starter, undefined, policy);
    world.changeRegion(region); world.setControlMode('manual');
    const point = world.atlas.safeArrival(locationId, 8)!;
    world.player = { ...point, heading: 0 }; Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
    expect(world.sampleWorld(point.x, point.z).surface).toBe(surface);
    await page.locator('#import-file').setInputFiles({ name: `${surface}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true }))) });
    await expect(page.locator('#ow-host')).toHaveAttribute('data-region', region, { timeout: 30_000 });
    await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
    await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().terrainMaterials ?? []), { timeout: 45_000 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ effect: expect.stringContaining('surface:ground') })]));
    await page.waitForTimeout(350);
    await page.locator('#ow-host').screenshot({ path: `artifacts/terrain-landforms/${surface}.png` });
  }
  expect(errors).toEqual([]);
});
