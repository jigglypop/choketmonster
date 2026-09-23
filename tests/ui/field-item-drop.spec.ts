import { mockAuthenticatedSession } from './helpers/authenticated-session';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { Random } from '../../src/core/random';
import type { Graph } from '../../src/core/brain';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

test('catching the specified Pokemon shows its equipment reward and makes it available to equip', async ({ page }) => {
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  const game = createGame(1, 'field-drop-ui'), world = new OpenWorldSimulation(graph, game, 9);
  world.setControlMode('manual'); world.setAutoHunt(false); world.autoCapture = false;
  game.captureOffer = createMonster(game, 143, 5); game.captureOffer.hp = 0;
  game.dex.seen.push(143);
  const snapshot = world.snapshot();
  for (let seed = 1; seed < 1000; seed++) { if (new Random(seed).next() < .04) { snapshot.rng = seed; break; } }
  const itemId = 'leftovers', message = '먹다남은음식 +1';
  await page.routeWebSocket('**', socket => socket.close());
  await mockAuthenticatedSession(page);
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'field-drop.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packSave(game, graph, { ...defaultView(), openWorld: snapshot, openWorldPaused: true }))) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await page.locator('#world-win-catch').click();
  await expect(page.locator('#toast')).toHaveText(message, { timeout: 15000 });
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator(`#monster-tool option[value="${itemId}"]`)).toHaveJSProperty('disabled', false);
  await page.locator('#monster-tool').selectOption(itemId);
  await expect(page.locator('#monster-tool')).toHaveValue(itemId);
});
