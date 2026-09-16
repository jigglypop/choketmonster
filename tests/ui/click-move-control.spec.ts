import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { openExplorePanel } from './helpers/explore-panel';

test.use({ launchOptions: { args: ['--mute-audio', '--enable-unsafe-webgpu'] } });
test('a clicked destination keeps manual control until arrival', async ({ page }) => {
  test.setTimeout(90_000);
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
  const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
  const game = createGame(152, 'click-move-control');
  const world = new OpenWorldSimulation(graph, game, 97312, undefined, policy);
  const town = world.atlas.locations.find(location => location.id === 'new-bark')!;
  const target = world.atlas.nearestWalkable(town.x, town.z, 0)!;
  const start = world.atlas.nearestWalkable(target.x + 9, target.z + 3, 0)!;
  world.player = { ...start, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });
  await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  await page.goto('/');
  await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'click-move.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await openExplorePanel(page);
  await page.locator('#world-pause').click();
  await page.locator('#world-map-open').click();
  await page.evaluate(() => {
    const scope = window as unknown as { modeChanges: Array<{ manual: boolean; position: string; time: number }> };
    scope.modeChanges = [];
    const button = document.querySelector('#world-mode-manual')!;
    const observer = new MutationObserver(() => {
      const manual = button.getAttribute('aria-pressed') === 'true';
      if (scope.modeChanges.at(-1)?.manual === manual) return;
      scope.modeChanges.push({ manual, position: document.querySelector('#world-position')!.textContent!, time: performance.now() });
    });
    observer.observe(button, { attributes: true, attributeFilter: ['aria-pressed'] });
  });
  await page.locator('.world-map-point[data-location-id="new-bark"] circle').click();
  await expect.poll(() => page.evaluate(() => (window as any).modeChanges.some((entry: { manual: boolean }) => entry.manual)), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const changes = (window as any).modeChanges as Array<{ manual: boolean }>;
    const start = changes.findIndex(entry => entry.manual);
    return start >= 0 && changes.slice(start + 1).some(entry => !entry.manual);
  }), { timeout: 40_000 }).toBe(true);
  const changes = await page.evaluate(() => (window as any).modeChanges as Array<{ manual: boolean; position: string; time: number }>);
  const manual = changes.findIndex(entry => entry.manual);
  const ended = changes.slice(manual + 1).find(entry => !entry.manual)!;
  const [x, z] = ended.position.split(',').map(Number);
  expect(Math.hypot(x - target.x, z - target.z), JSON.stringify(changes)).toBeLessThan(1.5);
  expect(ended.time - changes[manual].time).toBeGreaterThan(500);
});
