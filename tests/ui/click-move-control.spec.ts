import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { openExplorePanel } from './helpers/explore-panel';

test.use({ launchOptions: { args: ['--mute-audio', '--enable-unsafe-webgpu'] } });

for (const scenario of [
  { locationId: 'new-bark', label: 'town', resumesAutomatically: false },
  { locationId: 'route-29', label: 'route', resumesAutomatically: true },
] as const) test(`a clicked ${scenario.label} destination keeps manual control until arrival`, async ({ page }) => {
  test.setTimeout(90_000);
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
  const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
  const game = createGame(152, `click-move-control-${scenario.label}`);
  const world = new OpenWorldSimulation(graph, game, 97312, undefined, policy);
  const location = world.atlas.locations.find(item => item.id === scenario.locationId)!;
  const target = world.atlas.nearestWalkable(location.x, location.z, 0)!;
  const start = scenario.resumesAutomatically
    ? world.atlas.nearestWalkable(world.atlas.locations.find(item => item.id === 'new-bark')!.x, world.atlas.locations.find(item => item.id === 'new-bark')!.z, 0)!
    : world.atlas.nearestWalkable(target.x + 9, target.z + 3, 0)!;
  world.player = { ...start, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });
  await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  await page.goto('/');
  await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: `click-move-${scenario.label}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await openExplorePanel(page);
  await page.locator('#world-pause').click();
  await page.locator('#world-map-open').click();
  await page.evaluate(() => {
    const scope = window as unknown as { modeChanges: boolean[] };
    scope.modeChanges = [];
    const button = document.querySelector('#world-mode-manual')!;
    new MutationObserver(() => {
      const manual = button.getAttribute('aria-pressed') === 'true';
      if (scope.modeChanges.at(-1) !== manual) scope.modeChanges.push(manual);
    }).observe(button, { attributes: true, attributeFilter: ['aria-pressed'] });
  });
  await page.locator(`.world-map-point[data-location-id="${scenario.locationId}"] circle`).click();
  await expect.poll(() => page.evaluate(() => (window as any).modeChanges.includes(true)), { timeout: 5_000 }).toBe(true);
  await expect.poll(async () => {
    const [x, z] = (await page.locator('#world-position').textContent())!.split(',').map(Number);
    return Math.hypot(x - target.x, z - target.z);
  }, { timeout: 40_000 }).toBeLessThan(1.5);

  if (scenario.resumesAutomatically) {
    await expect.poll(() => page.evaluate(() => {
      const changes = (window as any).modeChanges as boolean[];
      const manual = changes.indexOf(true);
      return manual >= 0 && changes.slice(manual + 1).includes(false);
    }), { timeout: 3_000 }).toBe(true);
    await expect(page.locator('#world-mode-auto')).toHaveAttribute('aria-pressed', 'true', { timeout: 3_000 });
  } else {
    await page.waitForTimeout(750);
    await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#world-control-help')).toContainText('마을에서는 수동 이동 유지');
    await page.evaluate(() => {
      const scope = window as unknown as { stableLocationMutations: number };
      scope.stableLocationMutations = 0;
      const observer = new MutationObserver(records => { scope.stableLocationMutations += records.length; });
      for (const selector of ['#world-biome', '#world-location-short', '#world-explore-short', '#world-zone-level', '#world-next-guide']) {
        observer.observe(document.querySelector(selector)!, { attributes: true, childList: true, characterData: true, subtree: true });
      }
    });
    await page.waitForTimeout(750);
    expect(await page.evaluate(() => (window as any).stableLocationMutations)).toBe(0);
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(150);
    await page.keyboard.up('ArrowRight');
    await page.waitForTimeout(750);
    await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#world-mode-auto').click();
    await expect(page.locator('#world-mode-auto')).toHaveAttribute('aria-pressed', 'true');
  }
});
