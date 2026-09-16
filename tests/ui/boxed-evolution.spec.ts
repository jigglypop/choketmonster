import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;

test('evolves a non-participating box Pokemon while keeping the battle participant locked', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());

  const game = createGame(152, 'boxed-evolution-ui');
  const participant = createMonster(game, 152, 16), boxed = createMonster(game, 1, 16);
  game.player.team = [participant]; game.player.box = [boxed];
  game.dex.seen = [1, 152]; game.dex.caught = [1, 152];
  const world = new OpenWorldSimulation(graph, game, 76_101, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const wild = world.entities.find(entity => entity.kind === 'wild')!;
  world.player = { x: wild.x, z: wild.z + 1, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  expect(world.startEncounter(wild.id)).toBe(true);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });

  await page.goto('/');
  await expect(page.locator('[data-starter="152"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'boxed-evolution.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.getByRole('status')).toContainText('불러왔습니다');
  await page.locator('[data-tab="team"]').click();

  await expect(page.locator('[data-evolve="153"]')).toBeDisabled();
  await page.locator(`[data-monster="${boxed.instanceId}"]`).click();
  await expect(page.locator('.monster-card.selected')).toHaveAttribute('data-monster', boxed.instanceId);
  await expect(page.locator('.evolution-growth')).toContainText('박스의 비참가 포켓몬은 진화할 수 있습니다');
  await expect(page.locator('[data-evolve="2"]')).toBeEnabled();
  await page.locator('[data-evolve="2"]').click();
  await expect(page.locator('.detail-title h2')).toHaveText('이상해풀');
  await expect(page.locator(`[data-monster="${boxed.instanceId}"]`)).toContainText('이상해풀');

  await page.locator('#save-now').click();
  await expect(page.locator('#save-state')).toContainText('저장됨');
  const restored = await page.evaluate(async () => {
    const modulePath = '/src/game/storage.ts';
    const storage = await import(/* @vite-ignore */ modulePath);
    return storage.readSave();
  }) as any;
  expect(restored.game.battle).toMatchObject({ kind: 'wild', turn: 1 });
  expect(restored.game.player.team[0]).toMatchObject({ instanceId: participant.instanceId, speciesId: 152 });
  expect(restored.game.player.box[0]).toMatchObject({ instanceId: boxed.instanceId, speciesId: 2 });
  expect(errors).toEqual([]);
});
