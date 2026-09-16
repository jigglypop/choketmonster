import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import { ConnectomeController } from '../../src/game/connectome';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const controller = new ConnectomeController(graph);

async function openCollection(page: Page) {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/');
  await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  const game = createGame(152, 'search-stability');
  game.player.team = [createMonster(game, 25, 20)];
  game.player.box = Array.from({ length: 72 }, (_, index) => createMonster(game, index % 36 + 1, 5 + index % 20));
  for (const monster of [...game.player.team, ...game.player.box]) controller.ensure(monster);
  const save = packSave(game, graph, { ...defaultView(), openWorldPaused: true });
  await page.locator('#import-file').setInputFiles({ name: 'search-stability.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
}

test('dex and box search update results without remounting stable UI or the selected model', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openCollection(page);

  await page.locator('[data-tab="team"]').click();
  const canvas = page.locator('#pokemon-canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(canvas).toHaveAttribute('data-species', '25');
  await page.evaluate(() => {
    const scope = window as unknown as { searchProbe: Record<string, unknown> };
    const detail = document.querySelector('.detail-portrait')!;
    scope.searchProbe = { detail, canvas: document.querySelector('#pokemon-canvas'), detailMutations: 0 };
    new MutationObserver(records => { scope.searchProbe.detailMutations = Number(scope.searchProbe.detailMutations) + records.length; })
      .observe(detail, { childList: true, subtree: true });
  });
  const boxSearch = page.locator('#box-search');
  const animationBeforeSearch = Number(await canvas.getAttribute('data-animation-time'));
  await boxSearch.click();
  const boxScrollBefore = await page.evaluate(() => scrollY);
  await boxSearch.pressSequentially('피');
  await expect(boxSearch).toBeFocused();
  expect(Math.abs(await page.evaluate(() => scrollY) - boxScrollBefore)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => {
    const probe = (window as any).searchProbe;
    return {
      detailSame: probe.detail === document.querySelector('.detail-portrait'),
      canvasSame: probe.canvas === document.querySelector('#pokemon-canvas'),
      canvasParentSame: probe.canvas?.parentElement === probe.detail,
      mutations: probe.detailMutations,
    };
  })).toEqual({ detailSame: true, canvasSame: true, canvasParentSame: true, mutations: 0 });
  await expect.poll(async () => Number(await canvas.getAttribute('data-animation-time'))).toBeGreaterThan(animationBeforeSearch);
  await boxSearch.fill('');
  await expect(canvas).toHaveAttribute('data-species', '25');
  expect(await page.evaluate(() => (window as any).searchProbe.detail === document.querySelector('.detail-portrait'))).toBe(true);

  await boxSearch.fill('이상');
  await page.locator('.box-monster').first().click();
  await expect(canvas).toHaveAttribute('data-species', '1', { timeout: 30_000 });
  await expect(canvas).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await page.evaluate(() => {
    const scope = window as unknown as { searchProbe: Record<string, unknown> };
    scope.searchProbe = { detail: document.querySelector('.detail-portrait'), canvas: document.querySelector('#pokemon-canvas') };
  });
  await boxSearch.fill('이상해씨');
  await expect(boxSearch).toBeFocused();
  expect(await page.evaluate(() => {
    const probe = (window as any).searchProbe;
    return probe.detail === document.querySelector('.detail-portrait') && probe.canvas === document.querySelector('#pokemon-canvas') && probe.canvas?.parentElement === probe.detail;
  })).toBe(true);
  await boxSearch.fill('');
  expect(await page.evaluate(() => (window as any).searchProbe.detail === document.querySelector('.detail-portrait'))).toBe(true);

  await page.locator('[data-tab="dex"]').click();
  await page.evaluate(() => {
    const scope = window as unknown as { searchProbe: Record<string, unknown> };
    scope.searchProbe = { page: document.querySelector('.dex-page'), search: document.querySelector('#dex-search') };
  });
  const dexSearch = page.locator('#dex-search');
  await dexSearch.click();
  const dexScrollBefore = await page.evaluate(() => scrollY);
  await dexSearch.pressSequentially('피카');
  await expect(dexSearch).toBeFocused();
  expect(Math.abs(await page.evaluate(() => scrollY) - dexScrollBefore)).toBeLessThanOrEqual(1);
  await expect(page.locator('.dex-card')).toHaveCount(1);
  expect(await page.evaluate(() => {
    const probe = (window as any).searchProbe;
    return { pageSame: probe.page === document.querySelector('.dex-page'), searchSame: probe.search === document.querySelector('#dex-search') };
  })).toEqual({ pageSame: true, searchSame: true });
  await dexSearch.fill('');
  await expect(page.locator('.dex-card')).toHaveCount(60);
  expect(await page.evaluate(() => {
    const probe = (window as any).searchProbe;
    return probe.page === document.querySelector('.dex-page') && probe.search === document.querySelector('#dex-search');
  })).toBe(true);
  expect(errors).toEqual([]);
});
