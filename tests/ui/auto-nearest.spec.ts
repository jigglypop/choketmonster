import { expect, test, type BrowserContext, type Page } from '@playwright/test';
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

function manualSaveWithPinnedFarWild(seed: number) {
  const game = createGame(1, `auto-nearest-${seed}`);
  const world = new OpenWorldSimulation(graph, game, seed, undefined, policy);
  world.setControlMode('manual');
  world.setAutoCapture(true);
  game.inventory['poke-ball'] = game.inventory['great-ball'] = game.inventory['ultra-ball'] = 0;
  const companion = world.entities.find(entity => entity.kind === 'companion')!;
  const [close, far] = world.entities.filter(entity => entity.kind === 'wild');
  Object.assign(close, { x: companion.x, z: companion.z });
  Object.assign(far, { x: companion.x + 25, z: companion.z + 25 });
  world.selectWild(far.id, true);
  const snapshot = world.snapshot();
  expect(snapshot.autoHunt).toBe(false);
  expect(snapshot.selectedWildId).toBe(far.id);
  return { close, far, save: packSave(game, graph, { ...defaultView(), openWorld: snapshot, openWorldPaused: true, learning: false }) };
}

async function exportSave(page: Page) {
  await page.locator('[data-tab="lab"]').click();
  const pending = page.waitForEvent('download');
  await page.locator('#export-save').click();
  const download = await pending;
  return JSON.parse(await readFile((await download.path())!, 'utf8')) as {
    game: { battle?: { enemy: { team: Array<{ speciesId: number }> } } };
    view: { openWorld: { selectedWildId?: string; battleWildId?: string; autoHunt: boolean } };
  };
}

async function verifyAutoChoosesNearest(page: Page, seed: number, activate: (page: Page) => Promise<void>) {
  const { close, far, save } = manualSaveWithPinnedFarWild(seed);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/');
  await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({
    name: 'auto-nearest.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)),
  });
  await expect(page.getByRole('status')).toContainText('불러왔습니다');
  await openExplorePanel(page);
  await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#world-auto-hunt, #world-engage')).toHaveCount(0);
  await expect(page.locator('#world-target')).toBeVisible();

  await activate(page);
  await expect(page.locator('#world-mode-auto')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#world-battle-state')).toContainText('자동 배틀', { timeout: 15_000 });
  await expect(page.locator('.world-battle-hud')).not.toHaveAttribute('open', '');
  await page.locator('#world-pause').click();
  const exported = await exportSave(page);
  expect(exported.view.openWorld.autoHunt).toBe(true);
  expect(exported.view.openWorld.selectedWildId).toBe(close.id);
  expect(exported.view.openWorld.battleWildId).toBe(close.id);
  expect(exported.view.openWorld.battleWildId).not.toBe(far.id);
  expect(exported.game.battle?.enemy.team[0].speciesId).toBe(close.speciesId);
}

test('자동 버튼은 고정한 먼 대상을 버리고 볼이 없어도 가장 가까운 야생 전투를 시작한다', async ({ page }) => {
  test.setTimeout(90_000);
  await verifyAutoChoosesNearest(page, 82301, current => current.locator('#world-mode-auto').click());
});

test('모바일 터치로 누른 자동 버튼도 가장 가까운 야생 전투를 시작한다', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const context: BrowserContext = await browser.newContext({
    baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  const page = await context.newPage();
  try {
    await verifyAutoChoosesNearest(page, 82302, current => current.locator('#world-mode-auto').tap());
  } finally {
    await context.close();
  }
});
