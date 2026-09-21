import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

test('a wild victory shows the field item reward and makes it available to equip', async ({ page }) => {
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  const game = createGame(1, 'field-drop-ui'), world = new OpenWorldSimulation(graph, game, 9);
  world.setControlMode('manual'); world.setAutoHunt(false); world.autoCapture = false;
  const target = world.entities.find(entity => entity.kind === 'wild')!;
  world.player = { x: target.x, z: target.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  expect(world.startEncounter(target.id)).toBe(true);
  game.battle!.enemy.team[0].hp = 0; world.requestAction({ type: 'wait' });
  const snapshot = world.snapshot();
  let itemId = '', message = '';
  for (let seed = 0; seed < 200; seed++) {
    snapshot.rng = seed;
    const trial = new OpenWorldSimulation(graph, structuredClone(game), world.seed, snapshot);
    const drop = trial.step({ deltaSeconds: 1 }).events.find(event => event.type === 'item-drop');
    if (drop?.type === 'item-drop' && !drop.itemId.startsWith('mega-stone:')) { itemId = drop.itemId; message = drop.message; break; }
  }
  expect(itemId).not.toBe('');
  await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'field-drop.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packSave(game, graph, { ...defaultView(), openWorld: snapshot, openWorldPaused: true }))) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await page.locator('#world-resume').click();
  await expect(page.locator('#toast')).toHaveText(message, { timeout: 15000 });
  await page.locator('#world-win-release').click();
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator(`#monster-tool option[value="${itemId}"]`)).toHaveJSProperty('disabled', false);
  await page.locator('#monster-tool').selectOption(itemId);
  await expect(page.locator('#monster-tool')).toHaveValue(itemId);
});
