import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { createGame } from '../../src/game/engine';
import { gymTeam } from '../../src/game/gym-teams';
import { defaultView, packSave } from '../../src/game/storage';
import { getGymScene, gymSceneId } from '../../src/openworld/gym-scenes';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { mockAuthenticatedSession } from './helpers/authenticated-session';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;

test('the gym hall lists the leader party and stepping onto the court starts the battle', async ({ page }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const game = createGame(1, 'gym-hall-ui');
  const world = new OpenWorldSimulation(graph, game, 52_101, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  world.visitedTownIds.push('pewter');
  expect(world.teleportToTown('pewter')).toBe(true);
  const hall = getGymScene(gymSceneId('kanto', 'pewter'))!;
  world.player = { ...hall.door, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  expect(world.enterGym('pewter')).toBe(true);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: false, learning: false });

  await mockAuthenticatedSession(page); await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'gym-hall.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await page.locator('[data-tab="map"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-scene', hall.sceneId);

  const label = page.locator('.gym-leader-label[data-gym-leader="pewter"]');
  await expect(label).toBeVisible({ timeout: 20_000 });
  await expect(label).toHaveAttribute('data-gym-state', 'available');
  await expect(label.locator('.gym-leader-party li')).toHaveCount(gymTeam('kanto', 1)!.length);
  await expect(page.locator('#world-gym-exit')).toBeVisible();
  await page.screenshot({ path: info.outputPath('gym-hall.png') });

  // Walk forward onto the court; the camera faces into the hall on entry.
  const party = page.locator('.world-enemy-party li');
  for (const key of ['ArrowUp', 'ArrowDown']) {
    await page.keyboard.down(key);
    await expect.poll(() => party.count(), { timeout: 8_000 }).toBeGreaterThan(0).catch(() => undefined);
    await page.keyboard.up(key);
    if (await party.count()) break;
  }
  await expect(party).toHaveCount(gymTeam('kanto', 1)!.length);
  await expect(page.locator('#world-combatants')).toContainText('웅');
  await page.waitForTimeout(4_000);
  await page.screenshot({ path: info.outputPath('gym-battle.png') });
  expect(errors).toEqual([]);
});
