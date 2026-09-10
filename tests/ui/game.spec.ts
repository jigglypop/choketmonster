import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createGame, createMonster, type GameState } from '../../src/game/engine';
import { ConnectomeController } from '../../src/game/connectome';
import { packSave, defaultView } from '../../src/game/storage';
import type { Graph } from '../../src/core/brain';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const controller = new ConnectomeController(graph);
async function start(page: Page) {
  await page.goto('/');
  await page.locator('[data-starter="1"]').click();
  await expect(page.locator('#ow-host canvas')).toBeVisible(); await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-runtime', 'gaesup-world');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}
async function importGame(page: Page, game: GameState) {
  for (const mon of [...game.player.team, ...game.player.box, ...(game.battle?.enemy.team ?? [])]) controller.ensure(mon);
  await page.locator('#import-file').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packSave(game, graph, defaultView()))) });
  await expect(page.getByRole('status')).toContainText('불러왔습니다');
}
async function exported(page: Page) {
  await page.locator('[data-tab="lab"]').click();
  const download = page.waitForEvent('download'); await page.locator('#export-save').click();
  const file = await download; return JSON.parse(await readFile((await file.path())!, 'utf8'));
}

test('real starter, map, all 151 local sprites, search, and an error-free desktop', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page);
  await page.keyboard.press('ArrowLeft');
  await page.screenshot({ path: 'artifacts/ui-desktop.png', fullPage: true });
  await page.locator('[data-tab="dex"]').click();
  await expect(page.locator('.dex-card')).toHaveCount(151);
  await page.locator('#dex-search').fill('피카츄');
  await expect(page.locator('.dex-card')).toHaveCount(1);
  await expect(page.locator('.dex-card img')).toHaveAttribute('src', '/pokemon/25.png');
  await page.locator('#dex-search').fill('151');
  await expect(page.locator('.dex-card img')).toHaveAttribute('src', '/pokemon/151.png');
  await expect.poll(() => page.locator('img').evaluateAll(images => images.filter(image => !(image as HTMLImageElement).complete || !(image as HTMLImageElement).naturalWidth).length)).toBe(0);
  expect(errors).toEqual([]);
});

test('browser capture, candy, evolution, save/reload and validated import', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page);
  const game = createGame(1, 'ui-capture-evolve'), mon = createMonster(game, 1, 15), enemy = createMonster(game, 10, 4);
  game.player.team = [mon]; game.inventory['rare-candy'] = 1; game.inventory['ultra-ball'] = 10;
  enemy.hp = 1; enemy.status = 'sleep'; enemy.statusTurns = 3; game.dex.seen = [1, 10];
  game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
  await importGame(page, game);
  await expect(page.locator('.battle-stage')).toBeVisible();
  await expect(page.locator('#battle-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
  await page.screenshot({ path: 'artifacts/ui-battle.png', fullPage: true });
  for (let attempt = 0; attempt < 8 && await page.locator('#catch').count(); attempt++) {
    await page.locator('#ball-select').selectOption('ultra-ball'); await page.locator('#catch').click();
  }
  await expect(page.locator('#ow-host canvas')).toBeVisible(); await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
  await page.locator('[data-tab="team"]').click();
  await page.locator('#use-candy').click();
  await expect(page.locator('[data-evolve="2"]')).toBeEnabled();
  await page.locator('[data-evolve="2"]').click();
  await expect(page.locator('.detail-title h2')).toHaveText('이상해풀');
  await page.locator('#save-now').click(); await expect(page.getByRole('status')).toContainText('저장했습니다');
  await page.reload(); await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.detail-title h2')).toHaveText('이상해풀');
  const save = await exported(page);
  expect(save.game.player.team.map((m: { speciesId: number }) => m.speciesId)).toEqual([2, 10]);
  expect(save.game.dex.caught).toEqual([1, 2, 10]);
  expect(save.graph.nodes).toHaveLength(128); expect(save.game.player.team[0].brain.graph).toBeUndefined();
  const bad = structuredClone(save); bad.graph.edges[0].weight += .2;
  await page.locator('#import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) });
  await expect(page.getByRole('status')).toContainText('커넥톰');
  await page.locator('#import-file').setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from('\uFEFF' + JSON.stringify(save)) });
  await expect(page.getByRole('status')).toContainText('불러왔습니다');
  expect(errors).toEqual([]);
});

test('stone and trade evolution keep identity and memories through the interface', async ({ page }) => {
  await start(page);
  const game = createGame(1, 'ui-stone-trade'), pikachu = createMonster(game, 25, 25), kadabra = createMonster(game, 64, 30);
  game.player.team = [pikachu, kadabra]; game.dex.seen = [25, 64]; game.dex.caught = [25, 64];
  game.inventory['thunder-stone'] = 1; game.inventory['link-cable'] = 1;
  await importGame(page, game); await page.locator('[data-tab="team"]').click();
  await page.locator('[data-evolve="26"]').click();
  await expect(page.locator('.detail-title h2')).toHaveText('라이츄');
  await page.locator(`[data-monster="${kadabra.instanceId}"]`).click();
  await page.locator('[data-evolve="65"]').click();
  await expect(page.locator('.detail-title h2')).toHaveText('후딘');
  const save = await exported(page);
  expect(save.game.player.team.map((m: { instanceId: string; speciesId: number }) => [m.instanceId, m.speciesId])).toEqual([[pikachu.instanceId, 26], [kadabra.instanceId, 65]]);
  expect(save.game.player.team[0].brain.seed).toBe(pikachu.brain!.seed);
  expect(save.game.player.team[1].brain.seed).toBe(kadabra.brain!.seed);
});

test('mobile uses local assets and shows actual connectome provenance', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const external: string[] = [];
  await page.route('**/*', route => { if (!route.request().url().startsWith('http://127.0.0.1:5173')) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  await start(page);
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.viewport);
  await page.screenshot({ path: 'artifacts/ui-mobile.png', fullPage: true });
  await page.locator('[data-tab="lab"]').click();
  await expect(page.locator('.graph-numbers')).toContainText('128');
  await expect(page.locator('.graph-numbers')).toContainText('3,623');
  await expect(page.locator('.source-card')).toContainText(graph.provenance.sha256);
  expect(external).toEqual([]);
});

test('animated 3D specimens, model switching, and bounded GPU cache', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page); await page.locator('[data-tab="dex"]').click();
  for (const id of [1, 4, 7, 25, 26, 64, 65, 94, 129, 130, 132, 150, 151, 1]) {
    await page.locator('#dex-search').fill(String(id));
    await page.locator(`.dex-card[data-species="${id}"]`).click();
    const canvas = page.locator('#pokemon-canvas');
    await expect(canvas).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
    await expect(canvas).toHaveAttribute('data-species', String(id));
    await expect.poll(async () => Number(await canvas.getAttribute('data-triangles'))).toBeGreaterThan(0);
    const time = Number(await canvas.getAttribute('data-animation-time'));
    await expect.poll(async () => Number(await canvas.getAttribute('data-animation-time'))).toBeGreaterThan(time);
    expect(Number(await canvas.getAttribute('data-cached-assets'))).toBeLessThanOrEqual(10);
    if ([25, 150, 151].includes(id)) await page.screenshot({ path: `artifacts/ui-model-${id}.png` });
    await page.getByRole('button', { name: '닫기', exact: true }).click();
  }
  await page.locator('[data-tab="map"]').click();
  await expect(page.locator('#ow-host canvas')).toBeVisible(); await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
  expect(errors).toEqual([]);
});
