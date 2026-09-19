import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));

test('Johto towns keep textured buildings and distinct paving at a fixed instance budget', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [], palettes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: { id: 'town-identity', username: 'town-check' } } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route('**/api/auth/realtime-ticket', route => route.fulfill({ status: 401, json: {} }));
  mkdirSync('artifacts/town-identity', { recursive: true });
  for (const townId of ['new-bark', 'cherrygrove', 'violet']) {
    const game = createGame(152, 'town-identity');
    const world = new OpenWorldSimulation(graph, game, 35211, undefined, policy);
    world.setControlMode('manual'); world.setAutoHunt(false);
    const town = world.atlas.locations.find(location => location.id === townId)!;
    world.player = { x: town.x, z: town.z, heading: 0 };
    Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
    const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });
    await page.route('**/api/saves/current', route => route.fulfill({ json: { save, revision: 1 } }));
    await page.goto('/?renderProbe', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    await expect.poll(() => page.evaluate(id => (window as any).__renderProbe?.read().townBuildings
      .filter((name: string) => name.startsWith(`town-building:${id}:`) && name.endsWith(':loaded')).length ?? 0, townId), { timeout: 45_000 }).toBeGreaterThan(0);
    const paving = await page.evaluate(id => (window as any).__renderProbe.read().townPaving.find((entry: any) => entry.town === `town:${id}`), townId);
    expect(paving.instances).toBe(161);
    palettes.push(JSON.stringify(paving.colors));
    await page.screenshot({ path: `artifacts/town-identity/${townId}.png` });
    await page.unroute('**/api/saves/current');
  }
  expect(new Set(palettes).size).toBe(3);
  expect(errors).toEqual([]);
});
