import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { openExplorePanel } from './helpers/explore-panel';
import { clickAccountMenu } from './helpers/account-menu';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));

test('a legacy Kanto champion receives one local Hoenn starter without replacing the veteran team', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  const loadedGlbs = new Set<string>();
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (/\.glb(?:$|\?)/.test(response.url()) && response.ok()) loadedGlbs.add(response.url());
  });
  await page.routeWebSocket(url => url.pathname === '/' && url.searchParams.has('token'), () => {});
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));

  const game = createGame(1, 'regional-starter-ui');
  game.player.badges = 8;
  game.defeatedGyms = [1, 2, 3, 4, 5, 6, 7, 8];
  game.championDefeated = true;
  game.player.team = [createMonster(game, 6, 80, 'kanto'), createMonster(game, 9, 75, 'kanto')];
  game.dex.seen = [1, 6, 9]; game.dex.caught = [1, 6, 9];
  delete game.campaign;
  delete game.claimedRegionalStarters;
  for (const monster of [...game.player.team, ...game.player.box]) delete monster.originRegion;
  const world = new OpenWorldSimulation(graph, game, 74621, undefined, policy);
  world.setControlMode('manual');
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });

  await page.goto('/');
  await expect(page.locator('[data-starter="152"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'legacy-kanto-champion.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await openExplorePanel(page);
  await page.locator('#world-map-open').click();
  await expect(page.locator('#world-map-dialog')).toBeVisible();
  await page.locator('#world-region').selectOption('hoenn');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region', 'hoenn');

  const dialog = page.locator('#regional-starter-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-regional-starter]')).toHaveCount(3);
  await expect(dialog.locator('[data-regional-starter="252"]')).toContainText('나무지기');
  await expect(dialog.locator('[data-regional-starter="255"]')).toContainText('아차모');
  await expect(dialog.locator('[data-regional-starter="258"]')).toContainText('물짱이');
  await expect(dialog.locator('[data-regional-starter]')).toContainText(['Lv.5', 'Lv.5', 'Lv.5']);
  await expect(dialog.locator('.regional-starter-rule')).toContainText('배지 1개부터 타지방 포켓몬 사용 가능');
  const font = await dialog.locator('[data-regional-starter="258"] strong').evaluate(async element => {
    await document.fonts.ready;
    const style = getComputedStyle(element);
    const text = element.textContent ?? '';
    const loaded = await document.fonts.load('300 19px "Choket Sans"', text);
    return {
      family: style.fontFamily,
      weight: style.fontWeight,
      loadedFaces: loaded.length,
      resourceLoaded: performance.getEntriesByType('resource').some(entry => entry.name.includes('ChoketSansVariable.woff2')),
    };
  });
  expect(font.family).toContain('Choket Sans');
  expect(font.weight).toBe('300');
  expect(font.loadedFaces).toBeGreaterThan(0);
  expect(font.resourceLoaded).toBe(true);

  await dialog.locator('[data-regional-starter="258"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.world-battle-hud > summary strong')).toContainText('물짱이 · Lv.5');

  await page.locator('#world-region').selectOption('kanto');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region', 'kanto');
  await page.locator('#world-region').selectOption('hoenn');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region', 'hoenn');
  await page.waitForTimeout(500);
  await expect(page.locator('#regional-starter-dialog')).toHaveCount(0);
  await page.locator('#world-map-close').click();
  await expect(page.locator('#world-map-dialog')).not.toBeVisible();
  await clickAccountMenu(page, '#save-now');
  await expect(page.locator('#save-state')).toContainText('저장됨');

  await page.reload();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region', 'hoenn', { timeout: 45_000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await page.waitForTimeout(500);
  await expect(page.locator('#regional-starter-dialog')).toHaveCount(0);
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.team-slots .team-monster')).toHaveCount(3);
  await expect(page.locator('.team-slots')).toContainText('리자몽');
  await expect(page.locator('.team-slots')).toContainText('Lv.80');
  await expect(page.locator('.team-slots')).toContainText('거북왕');
  await expect(page.locator('.team-slots')).toContainText('Lv.75');
  await expect(page.locator('.team-slots .team-monster').filter({ hasText: 'No.258' })).toHaveCount(1);
  await expect(page.locator('.team-slots .team-monster').filter({ hasText: 'No.258' })).toContainText('Lv.5');
  expect(loadedGlbs.size).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
