import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { createGame, createMonster, type GameState } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { getGymScene, gymSceneId, leagueSceneId } from '../../src/openworld/gym-scenes';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { mockAuthenticatedSession } from './helpers/authenticated-session';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;

async function openSave(page: Page, game: GameState, world: OpenWorldSimulation, errors: string[]) {
  page.on('pageerror', error => errors.push(error.message));
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: false, learning: false });
  await mockAuthenticatedSession(page); await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'hall.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await page.locator('[data-tab="map"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
}

function strongTeam(game: GameState) {
  game.player.team = [createMonster(game, 3, 70, 'kanto'), createMonster(game, 6, 70, 'kanto'), createMonster(game, 9, 70, 'kanto')];
  game.dex.seen = [...new Set([...game.dex.seen, 3, 6, 9])].sort((a, b) => a - b);
  game.dex.caught = [...new Set([...game.dex.caught, 3, 6, 9])].sort((a, b) => a - b);
}

test('entering a gym starts the leader battle and a win leads back outside', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const game = createGame(1, 'gym-auto'); strongTeam(game);
  const world = new OpenWorldSimulation(graph, game, 52_201, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  world.visitedTownIds.push('pewter');
  expect(world.teleportToTown('pewter')).toBe(true);
  const hall = getGymScene(gymSceneId('kanto', 'pewter'))!;
  world.player = { ...hall.door, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  await openSave(page, game, world, errors);

  await page.locator('#world-gym-challenge').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-scene', hall.sceneId);
  await expect(page.locator('.world-enemy-party li').first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: info.outputPath('gym-auto-battle.png') });
  await expect(page.locator('.gym-victory-dialog')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-scene', 'surface:kanto');
  await page.screenshot({ path: info.outputPath('gym-auto-exit.png') });
  expect(errors).toEqual([]);
});

test('the league hall is a gilded statue gallery that opens straight into the first battle', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const game = createGame(1, 'league-ui'); strongTeam(game);
  game.player.badges = 8; game.defeatedGyms = [1, 2, 3, 4, 5, 6, 7, 8];
  const world = new OpenWorldSimulation(graph, game, 52_202, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const hall = getGymScene(leagueSceneId('kanto', 'indigo-plateau'))!;
  world.player = { ...hall.door, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  await openSave(page, game, world, errors);
  await page.screenshot({ path: info.outputPath('league-stadium.png') });

  await page.locator('#world-trainer-challenge').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-scene', hall.sceneId);
  await expect(page.locator('#world-combatants')).toContainText('칸나', { timeout: 10_000 });
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: info.outputPath('league-hall.png') });
  expect(errors).toEqual([]);
});
