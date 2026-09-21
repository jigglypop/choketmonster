import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;

test('adds, removes and confirms bag items with money in the mobile trade room', async ({ page }, testInfo) => {
  const user = { id: 'trade-item-user', username: 'item_trainer' };
  const other = { id: 'trade-item-other', username: 'other_trainer' };
  const game = createGame(152, 'trade-item-ui');
  (game.inventory as Record<string, number>).leftovers = 3;
  (game.inventory as Record<string, number>)['life-orb'] = 1;
  (game.inventory as Record<string, number>)['mega-stone:charizard-mega-x'] = 2;
  const initial = packSave(game, graph, defaultView());
  let offerBody: any, confirmBody: any;
  let room = {
    id: 'trade-item-room', code: 'ITEMROOM12345', status: 'active', version: 1, expiresAt: '2030-01-01T00:00:00Z',
    participants: [
      { side: 'creator', user, confirmed: false, offer: { monster: null, money: 0, items: [] } },
      { side: 'joiner', user: other, confirmed: false, offer: { monster: null, money: 25, items: [{ itemId: 'focus-sash', quantity: 1 }] } },
    ],
  };
  await page.route('**/trade-item-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.route('**/api/saves/current', route => route.fulfill({ json: { save: initial, revision: 1 } }));
  await page.route('**/api/trades/current', route => route.fulfill({ json: { trade: room } }));
  await page.route('**/api/trades/trade-item-room/offer', route => {
    offerBody = route.request().postDataJSON();
    room = { ...room, version: room.version + 1, participants: room.participants.map(participant => participant.user.id === user.id
      ? { ...participant, confirmed: false, offer: { monster: null, money: offerBody.money, items: offerBody.items } }
      : participant) };
    return route.fulfill({ json: { trade: room } });
  });
  await page.route('**/api/trades/trade-item-room/confirm', route => {
    confirmBody = route.request().postDataJSON();
    room = { ...room, version: room.version + 1, participants: room.participants.map(participant => participant.user.id === user.id ? { ...participant, confirmed: true } : participant) };
    return route.fulfill({ json: { trade: room } });
  });
  await page.route('**/api/trades/trade-item-room/cancel', route => {
    room = { ...room, version: room.version + 1, status: 'cancelled' };
    return route.fulfill({ json: { trade: room } });
  });
  await page.route('**/api/trades', route => route.fulfill({ json: { trade: room } }));
  await page.routeWebSocket('**/api/trades/live?*', () => {});
  await page.goto('/trade-item-fixture');
  await page.evaluate(async ({ user, graph }) => {
    const helperPath = '/tests/ui/helpers/trade-items.ts';
    const helper = await import(/* @vite-ignore */ helperPath);
    await helper.startTradeItemPanel({ user, graph });
  }, { user, graph });

  await expect(page.locator('.trade-room')).toBeVisible();
  await expect(page.locator('[data-other]')).toContainText('기합의띠 ×1');
  await expect(page.locator('[data-other]')).toContainText('용돈 ₩25');
  const item = page.locator('select[name="item"]'), quantity = page.locator('input[name="itemQuantity"]');
  await item.selectOption('leftovers'); await quantity.fill('4'); await page.locator('[data-add-item]').click();
  await expect(page.locator('.trade-error')).toContainText('가방에 있는 수량');
  await quantity.fill('2'); await page.locator('[data-add-item]').click();
  await expect(page.locator('[data-offer-items]')).toContainText('먹다남은음식 ×2');
  await item.selectOption('life-orb'); await quantity.fill('1'); await page.locator('[data-add-item]').click();
  await expect(page.locator('[data-offer-items]')).toContainText('생명의구슬 ×1');
  await page.locator('[data-remove-item="life-orb"]').click();
  await expect(page.locator('[data-offer-items]')).not.toContainText('생명의구슬');

  await page.locator('input[name="money"]').fill('150');
  await page.locator('.trade-offer-save').click();
  await expect(page.locator('[data-own]')).toContainText('먹다남은음식 ×2');
  await expect(page.locator('[data-own]')).toContainText('용돈 ₩150');
  expect(offerBody).toMatchObject({ version: 1, revision: 1, monsterId: null, money: 150, items: [{ itemId: 'leftovers', quantity: 2 }] });
  await page.locator('[data-confirm]').click();
  await expect(page.locator('[data-own]')).toContainText('확인 완료');
  expect(confirmBody).toEqual({ version: 2 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.trade-item-picker').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('trade-items-mobile.png'), fullPage: true });
  await page.locator('[data-cancel]').click();
  await expect(page.locator('.trade-dialog')).not.toBeVisible();
});
