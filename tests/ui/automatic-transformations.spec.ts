import { mockAuthenticatedSession } from './helpers/authenticated-session';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';
import { clickAccountMenu } from './helpers/account-menu';

test('team setup saves Korean Mega choices without a battle click', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**', socket => socket.close());
  await mockAuthenticatedSession(page);
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  const game = createGame(4, 'automatic-setup-ui'); game.player.team = [createMonster(game, 6, 50)];
  game.inventory['mega-stone:charizard-mega-x'] = 1;
  game.inventory.leftovers = 1;
  const world = new OpenWorldSimulation(graph, game, 223); world.setControlMode('manual'); world.setAutoHunt(false);
  await page.goto('/?renderProbe'); await page.locator('[data-starter="1"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'automatic-setup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true }))) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await page.locator('[data-tab="team"]').click();
  const select = page.locator('#monster-transformation');
  await expect(select.locator('option[value="mega:charizard-mega-x"]')).toHaveText('메가리자몽 X');
  await expect(select.locator('option[value="mega:charizard-mega-y"]')).toHaveJSProperty('disabled', true);
  await expect(select.locator('option[value^="tera:"]')).toHaveCount(0);
  for (const value of ['mega:charizard-mega-x', '']) {
    await select.selectOption(value);
    await clickAccountMenu(page, '#save-now'); await expect(page.locator('#save-state')).toContainText('저장됨');
    await page.reload(); await page.locator('[data-tab="team"]').click();
    await expect(select).toHaveValue(value);
    if (value.startsWith('mega:')) {
      await expect(page.locator('#monster-tool')).toHaveValue('mega-stone:charizard-mega-x');
      await page.locator('[data-tab="map"]').click();
      await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
      await expect.poll(() => page.evaluate(() => (window as any).__renderProbe.read().formModels.some((model: any) => model.identifier === 'charizard-mega-x' && model.drawn > 0)), { timeout: 20000 }).toBe(true);
      await page.screenshot({ path: info.outputPath('field-mega.png'), fullPage: true });
      await page.locator('[data-tab="team"]').click();
    } else await expect(page.locator('#monster-tool')).toHaveValue('');
  }
  await select.selectOption('mega:charizard-mega-x');
  await page.locator('#monster-tool').selectOption('leftovers');
  await expect(select).toHaveValue('');
  await select.selectOption('mega:charizard-mega-x');
  await page.setViewportSize({ width: 390, height: 844 });
  await select.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('automatic-setup-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});
