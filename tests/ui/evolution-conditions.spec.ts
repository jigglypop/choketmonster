import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { ConnectomeController } from '../../src/game/connectome';
import { initialEvolutionProgress } from '../../src/game/evolution-progress';
import { getMove } from '../../src/data/pokemon';
import { defaultView, packSave } from '../../src/game/storage';

const output = 'artifacts/evolution-completeness/ui';

async function selectMonster(page: Page, instanceId: string) {
  await page.locator(`.monster-card[data-monster="${instanceId}"]`).click();
  await expect(page.locator('.monster-card.selected')).toHaveAttribute('data-monster', instanceId);
}

test('removes friendship evolution UI and uses the explicit capsule substitute, then restores exact progress', async ({ page }) => {
  test.setTimeout(150_000);
  mkdirSync(output, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));

  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
  const game = createGame(152, 'evolution-conditions-ui');
  const pichu = createMonster(game, 172, 20);
  const combee = createMonster(game, 415, 21);
  const bonsly = createMonster(game, 438, 20);
  pichu.evolutionProgress = { ...initialEvolutionProgress(pichu), friendship: 70 };
  combee.evolutionProgress = { ...initialEvolutionProgress(combee), gender: 'male' };
  bonsly.moves = [{ moveId: 102, pp: getMove(102).pp }];
  game.player.team = [pichu, combee, bonsly];
  game.player.money = 20_000;
  game.dex.caught = [152, 172, 415, 438];
  game.dex.seen = [...game.dex.caught];
  const controller = new ConnectomeController(graph);
  for (const monster of game.player.team) controller.ensure(monster);
  const brainSeeds = Object.fromEntries(game.player.team.map(monster => [monster.instanceId, monster.brain!.seed]));
  const save = packSave(game, graph, { ...defaultView(), openWorldPaused: true, learning: false });

  await page.goto('/');
  await expect(page.locator('[data-starter="152"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'evolution-conditions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');

  await page.locator('[data-tab="shop"]').click();
  await expect(page.locator('[data-buy="friendship-treat"]')).toHaveCount(0);
  await page.locator('[data-buy="evolution-catalyst"]').click();
  await page.locator('[data-buy="evolution-catalyst"]').click();
  await expect(page.locator('.shop-card').filter({ has: page.locator('[data-buy="evolution-catalyst"]') })).toContainText('보유 2개');

  await page.locator('[data-tab="team"]').click();
  await page.locator('.evolution-panel > summary').click();
  await expect(page.locator('.evolution-growth')).toHaveCount(0);
  await expect(page.locator('[data-evolve="25"]')).toBeDisabled();
  await expect(page.locator('[data-capsule-evolve="25"]')).toBeEnabled();
  await page.locator('.evolution-panel').screenshot({ path: `${output}/pichu-capsule-ready.png` });
  await page.locator('[data-capsule-evolve="25"]').click();
  await expect(page.locator('.detail-title h2')).toHaveText('피카츄');

  await selectMonster(page, combee.instanceId);
  await page.locator('.evolution-panel > summary').click();
  await expect(page.locator('[data-evolve="416"]')).toBeDisabled();
  const combeeRoute = page.locator('[data-capsule-evolve="416"]').locator('..');
  await expect(page.locator('[data-capsule-evolve="416"]')).toBeEnabled();
  await expect(page.locator('[data-capsule-evolve="416"]')).toContainText('특수진화 캡슐 ×1 · 보유 1개 · 필요 Lv.21');
  await combeeRoute.locator('details > summary').click();
  await expect(combeeRoute.locator('details')).toContainText('암컷');
  await expect(combeeRoute.locator('details')).toContainText('Lv.21');
  await expect(combeeRoute.locator('details')).toContainText('성별·시간·장소·동료·특수 행동 조건을 대신합니다');
  await combeeRoute.screenshot({ path: `${output}/combee-source-and-capsule.png` });
  await page.locator('[data-capsule-evolve="416"]').click();
  await expect(page.locator('.detail-title h2')).toHaveText('비퀸');

  await selectMonster(page, bonsly.instanceId);
  await page.locator('.evolution-panel > summary').click();
  await expect(page.locator('#pokemon-canvas')).toHaveAttribute('data-species', '438', { timeout: 45_000 });
  await expect(page.locator('#pokemon-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await expect(page.locator('[data-evolve="185"]')).toBeEnabled();
  await expect(page.locator('[data-evolve="185"]')).toContainText('준비 완료');
  const bonslyRoute = page.locator('[data-evolve="185"]').locator('..');
  await bonslyRoute.locator('details > summary').click();
  await expect(bonslyRoute.locator('details')).toContainText('흉내내기 배우기');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#toast')).toBeHidden({ timeout: 5_000 });
  await bonslyRoute.scrollIntoViewIfNeeded();
  await page.locator('.detail-portrait').screenshot({ path: `${output}/bonsly-model.png` });
  await page.locator('.evolution-panel').screenshot({ path: `${output}/native-known-move-mobile.png`, style: '.topbar{visibility:hidden!important}' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await page.locator('#team-detail').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('#save-now').click();
  await expect(page.locator('#save-state')).toContainText('저장됨');
  await page.reload();
  await expect(page.locator('#starter-dialog')).toBeHidden();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator(`.monster-card[data-monster="${pichu.instanceId}"]`)).toContainText('피카츄');
  await expect(page.locator(`.monster-card[data-monster="${combee.instanceId}"]`)).toContainText('비퀸');
  await selectMonster(page, pichu.instanceId);
  await expect(page.locator('.evolution-growth')).toHaveCount(0);

  const restored = await page.evaluate(async () => {
    const modulePath = '/src/game/storage.ts';
    const storage = await import(/* @vite-ignore */ modulePath);
    return storage.readSave();
  }) as any;
  expect(restored.game.inventory['friendship-treat']).toBe(0);
  expect(restored.game.inventory['evolution-catalyst']).toBe(0);
  expect(restored.game.player.team.map((monster: any) => [monster.instanceId, monster.speciesId, monster.brain.seed])).toEqual([
    [pichu.instanceId, 25, brainSeeds[pichu.instanceId]],
    [combee.instanceId, 416, brainSeeds[combee.instanceId]],
    [bonsly.instanceId, 438, brainSeeds[bonsly.instanceId]],
  ]);
  expect(restored.game.player.team[0].evolutionProgress.friendship).toBe(70);
  expect(errors).toEqual([]);
});
