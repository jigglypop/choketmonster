import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { FIELD_PICKUP_ACTIVE_LIMIT } from '../../src/openworld/item-sources';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { mockAuthenticatedSession } from './helpers/authenticated-session';
import { openExplorePanel } from './helpers/explore-panel';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;

test('dims regionally unusable Pokémon and double-tapping a visited town leaves a wild battle', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const game = createGame(1, 'map-teleport-regional');
  const foreign = createMonster(game, 152, 12, 'johto'), overCap = createMonster(game, 4, 24, 'kanto');
  game.player.team.push(foreign); game.player.box = [overCap];
  const world = new OpenWorldSimulation(graph, game, 81_001, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  world.visitedTownIds.push('viridian');
  const wild = world.entities.find(entity => entity.kind === 'wild')!;
  world.player = { x: wild.x, z: wild.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  expect(world.startEncounter(wild.id)).toBe(true);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });

  await mockAuthenticatedSession(page); await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'map-teleport.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await page.locator('[data-tab="team"]').click();
  const foreignCard = page.locator(`.monster-card[data-monster="${foreign.instanceId}"]`);
  const overCapCard = page.locator(`.monster-card[data-monster="${overCap.instanceId}"]`);
  await expect(foreignCard).toBeVisible({ timeout: 20_000 });
  await expect(foreignCard).toHaveClass(/regional-locked/); await expect(foreignCard.locator('.regional-lock-tag')).toHaveText('타지방 출신');
  await expect(overCapCard).toHaveClass(/regional-locked/); await expect(overCapCard.locator('.regional-lock-tag')).toHaveText('Lv.20 초과');
  await expect(page.locator(`.monster-card[data-monster="${game.player.team[0].instanceId}"]`)).not.toHaveClass(/regional-locked/);
  await page.screenshot({ path: info.outputPath('team-regional.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('team-regional-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });

  await page.locator('[data-tab="map"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await openExplorePanel(page); await page.locator('#world-map-open').click();
  await expect(page.locator('.world-map-pickup')).toHaveCount(FIELD_PICKUP_ACTIVE_LIMIT);
  await page.screenshot({ path: info.outputPath('map-battle.png') });
  await page.locator('.world-map-point[data-location-id="viridian"] circle').dblclick();
  await expect(page.locator('#toast')).toContainText('안전한 마을 입구로 이동했습니다');
  await expect(page.locator('#world-map-dialog')).not.toHaveAttribute('open', '');
  await expect(page.locator('.world-switch')).toBeHidden();
  await page.screenshot({ path: info.outputPath('after-teleport.png') });
  expect(errors).toEqual([]);
});
