import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { openExplorePanel } from './helpers/explore-panel';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
test.use({ launchOptions: { args: ['--mute-audio', '--enable-unsafe-webgpu'] } });

test('PP가 0인 기존 저장도 기술을 실행하고 PP UI나 자동 회복 없이 값을 보존한다', async ({ page }) => {
  test.setTimeout(90_000);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/');
  await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });

  const game = createGame(1, 'browser-pp-recovery'), world = new OpenWorldSimulation(graph, game, 7717, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false); world.setAutoCapture(false);
  expect(world.startEncounter(world.entities.find(entity => entity.kind === 'wild')!.id)).toBe(true);
  game.player.team[0].moves = [{ moveId: 33, pp: 0 }];
  game.battle!.enemy.team[0].hp = 1;
  game.battle!.enemy.team[0].status = 'sleep'; game.battle!.enemy.team[0].statusTurns = 3;
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: false, learning: false });
  await page.locator('#import-file').setInputFiles({ name: 'pp-battle.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.getByRole('status')).toContainText('불러왔습니다');
  await openExplorePanel(page);

  await expect(page.locator('.world-battle-hud')).not.toHaveAttribute('open', '');
  await page.locator('.world-battle-hud > summary').click();
  const move = page.locator('[data-world-move-id="33"]');
  await expect(move).not.toContainText('PP');
  await expect(page.locator('body')).not.toContainText('자동 회복');
  await move.click();
  await expect(page.locator('#world-capture-offer')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#world-feed')).toContainText(/몸통박치기! [1-9]\d* 피해/);

  await page.locator('[data-tab="lab"]').click();
  const download = page.waitForEvent('download');
  await page.locator('#export-save').click();
  const file = await download, path = await file.path();
  const exported = JSON.parse(await readFile(path!, 'utf8')) as { game: { player: { team: Array<{ moves: Array<{ moveId: number; pp: number }> }> } } };
  expect(exported.game.player.team[0].moves).toEqual([{ moveId: 33, pp: 0 }]);
});
