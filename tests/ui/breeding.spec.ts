import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import { advanceEggProgress, createEgg } from '../../src/game/breeding';
import { ConnectomeController } from '../../src/game/connectome';
import { createGame, createMonster, type GameState } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const controller = new ConnectomeController(graph);

async function boot(page: Page) {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.goto('/');
  await expect.poll(() => page.locator('#import-file').evaluate(input => typeof (input as HTMLInputElement).onchange === 'function'), { timeout: 30_000 }).toBe(true);
}

async function importGame(page: Page, game: GameState) {
  game.versionCaught = { [game.adventureVersion ?? 'red']: [...game.dex.caught] };
  for (const monster of [...game.player.team, ...game.player.box]) controller.ensure(monster);
  const save = packSave(game, graph, { ...defaultView(), openWorldPaused: true });
  await page.locator('#import-file').setInputFiles({ name: 'breeding.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await page.locator('#starter-dialog').evaluate(dialog => { if ((dialog as HTMLDialogElement).open) (dialog as HTMLDialogElement).close(); });
}

test('compatible parents create a persistent egg and a ready egg hatches with its own brain', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await boot(page);
  const game = createGame(1, 'breeding-ui'), first = game.player.team[0], second = createMonster(game, 1, 20);
  first.gender = 'female'; second.gender = 'male'; game.player.box.push(second); controller.ensure(first); controller.ensure(second);
  await importGame(page, game); await page.locator('[data-tab="team"]').click();
  await expect(page.locator('#breeding-compatibility')).toContainText('알을 만들 수 있습니다');
  await page.locator('#create-egg').click();
  await expect(page.locator('.egg-card')).toContainText('이상해씨의 알');
  await expect(page.locator('#toast')).toContainText('알을 받았습니다');

  const ready = structuredClone(game), egg = createEgg(ready, first.instanceId, second.instanceId, graph);
  advanceEggProgress(ready, egg.requiredSteps);
  await importGame(page, ready); await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.egg-card')).toContainText('부화 준비 완료');
  await page.locator('[data-hatch]').click();
  await expect(page.locator('.egg-card')).toHaveCount(0);
  await expect(page.locator('.detail-title h2')).toHaveText('이상해씨');
  await expect(page.locator('.brain-memory')).toContainText('저장됨');
  await page.screenshot({ path: testInfo.outputPath('breeding-hatched.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('battle collection merge previews the highest-level baseline and preserves the active target', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await boot(page);
  const game = createGame(1, 'battle-merge-ui'), target = createMonster(game, 1, 10), donor = createMonster(game, 1, 80), enemy = createMonster(game, 19, 20);
  game.player.team = [target]; game.player.box = [donor];
  game.battle = { kind: 'wild', regionId: game.regionId, canRun: true, turn: 2, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 } };
  await importGame(page, game); await page.locator('[data-tab="team"]').click();
  await expect(page.locator('#merge-donor')).toContainText('기준 Lv.80 + 보너스 4 → Lv.84');
  await expect(page.locator('#merge-duplicate')).toBeEnabled();
  await page.locator('#merge-duplicate').click();
  const modal = page.getByRole('dialog', { name: '레벨을 합칠까요?' });
  await expect(modal).toContainText('최고 레벨 기준선 Lv.80');
  await expect(modal).toContainText('현재보다 +74');
  await modal.getByRole('button', { name: '레벨 합치기', exact: true }).click();
  await expect(page.locator('.detail-title > p')).toContainText('Lv.84');
  await expect(page.locator(`[data-monster="${donor.instanceId}"]`)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('battle-merge-level-84.png'), fullPage: true });
  expect(errors).toEqual([]);
});
