import { mockAuthenticatedSession } from './helpers/authenticated-session';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createGame, createMonster, ITEM_PRICES, SHOP_ITEMS } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
test('shop quantities, held-tool stock, healing and treats persist on mobile', async ({ page }, info) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**', socket => socket.close());
  await mockAuthenticatedSession(page);
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  const game = createGame(1, 'item-balance-ui'), monster = createMonster(game, 133, 50);
  game.player.team = [monster]; game.player.money = 30000; game.inventory.potion = 0; monster.hp -= 80;
  game.inventory.leftovers = 2; game.inventory['life-orb'] = 1;
  const world = new OpenWorldSimulation(graph, game, 221);
  world.setControlMode('manual'); world.setAutoHunt(false);
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'items.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true }))) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('#monster-tool option[value="focus-sash"]')).toHaveJSProperty('disabled', true);
  await page.locator('[data-tab="shop"]').click();
  await expect(page.locator('[data-shop-item]')).toHaveCount(SHOP_ITEMS.length);
  await expect(page.locator('[data-shop-item="leftovers"],[data-shop-item="life-orb"],[data-shop-category="held"]')).toHaveCount(0);
  const purchases = [['super-potion', 2], ['beauty-treat', 3], ['affection-treat', 2]] as const;
  let spent = 0;
  for (const [item, quantity] of purchases) {
    await page.locator(`[data-buy-quantity="${item}"]`).fill(String(quantity));
    await page.locator(`[data-buy="${item}"]`).click();
    await expect(page.locator(`[data-shop-item="${item}"]`)).toContainText(`보유 ${quantity}개`);
    spent += ITEM_PRICES[item] * quantity;
  }
  await expect(page.locator('.wallet')).toHaveText(`₩${(30000 - spent).toLocaleString('ko-KR')}`);
  await page.locator('[data-tab="team"]').click();
  await page.locator('#monster-tool').selectOption('leftovers');
  await page.locator('#monster-tool').selectOption('life-orb');
  await page.locator('.item-use-fold > summary').click();
  await page.locator('[data-heal-item="super-potion"]').click();
  await expect(page.locator('.stat-list')).toContainText(`${monster.hp + 60}/${monster.stats.hp}`);
  for (const [item, quantity] of [['beauty-treat', 3], ['affection-treat', 2]] as const) {
    await page.locator('.item-use-fold > summary').click();
    await page.locator(`[data-treat-quantity="${item}"]`).fill(String(quantity));
    await page.locator(`[data-use-treat="${item}"]`).click();
  }
  await page.locator('.item-use-fold > summary').click();
  await expect(page.locator('.treat-use').filter({ has: page.locator('[data-use-treat="beauty-treat"]') })).toContainText('60/255');
  await expect(page.locator('.treat-use').filter({ has: page.locator('[data-use-treat="affection-treat"]') })).toContainText('2/255');
  await page.locator('#save-now').click(); await expect(page.locator('#save-state')).toContainText('저장됨');
  await page.reload(); await page.locator('[data-tab="team"]').click();
  await expect(page.locator('#monster-tool')).toHaveValue('life-orb');
  await page.locator('[data-tab="shop"]').click();
  await expect(page.locator('[data-shop-category="held"]')).toHaveCount(0);
  await expect(page.locator('[data-shop-item="leftovers"],[data-shop-item="life-orb"]')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('item-shop-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('open-world battle allows Super Potion when regular Potion stock is empty', async ({ page }) => {
  await page.routeWebSocket('**', socket => socket.close());
  await mockAuthenticatedSession(page);
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  const game = createGame(1, 'super-potion-world'), monster = createMonster(game, 6, 50);
  game.player.team = [monster]; monster.hp -= 80; game.inventory.potion = 0; game.inventory['super-potion'] = 1;
  const world = new OpenWorldSimulation(graph, game, 222); world.setControlMode('manual'); world.setAutoHunt(false);
  const wild = world.entities.find(entity => entity.kind === 'wild')!; world.battleWildId = wild.id;
  game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, wild.speciesId, 2)], activeIndex: 0 }, turn: 1, canRun: true };
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'heal-battle.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true }))) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await page.locator('.world-battle-hud > summary').click();
  await expect(page.locator('#world-potion')).toBeDisabled();
  await expect(page.locator('#world-super-potion')).toBeEnabled();
  await page.locator('#world-super-potion').click();
  await page.locator('#world-resume').click();
  await expect(page.locator('#world-super-potion')).toHaveText('좋은상처약 ×0', { timeout: 15000 });
});
