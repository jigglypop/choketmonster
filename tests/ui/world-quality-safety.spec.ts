import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
const output = 'artifacts/world-quality-safety';
test.setTimeout(120_000);
test.beforeAll(() => mkdirSync(output, { recursive: true }));

async function load(page: Page, water = false) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /THREE|shader|WebGPU|WGSL/i.test(message.text())) errors.push(message.text()); });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.addInitScript(() => localStorage.setItem('choketmon-audio-v1', JSON.stringify({ muted: true })));
  const game = createGame(152, `world-quality-${water}`);
  if (water) game.campaign!.johtoBadges = [1, 2, 3, 4, 5, 6, 7, 8];
  const world = new OpenWorldSimulation(graph, game, 7331, undefined, policy);
  world.setControlMode('manual');
  if (water) {
    const point = world.atlas.safeArrival('route-40', 8)!;
    world.player = { ...point, heading: 0 };
    Object.assign(world.entities.find(entity => entity.kind === 'companion')!, point);
  }
  await page.goto('/?renderProbe=1');
  await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'quality.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false }))) });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await expect(page.locator('.ow-creature-label').filter({ hasText: '치코리타' })).toBeVisible({ timeout: 45_000 });
  return errors;
}

test('crisp native nameplates and target route remain visible on desktop and mobile', async ({ page }) => {
  const errors = await load(page);
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().loadedPokemon ?? []), { timeout: 45_000 }).toContain(152);
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().targetRoutes ?? 0)).toBeGreaterThan(0);
  const label = page.locator('.ow-creature-label').filter({ hasText: '치코리타' });
  expect(await label.evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
  await page.screenshot({ path: `${output}/town-nameplate-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(label).toBeVisible();
  expect(await label.evaluate(element => getComputedStyle(element).fontSize)).toBe('13px');
  await page.screenshot({ path: `${output}/town-nameplate-mobile.png` });
  expect(errors).toEqual([]);
});

test('releasing movement returns to automatic control immediately', async ({ page }) => {
  await load(page);
  await page.keyboard.press('Space');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'false');
  await page.keyboard.down('KeyD');
  await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('KeyD');
  await expect(page.locator('#world-mode-auto')).toHaveAttribute('aria-pressed', 'true', { timeout: 1500 });
});

test('nearby sea uses decoded normal texture without renderer errors', async ({ page }) => {
  const texture = page.waitForResponse(response => response.url().includes('/textures/water/three-waternormals.jpg') && response.ok());
  const errors = await load(page, true);
  await texture;
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().water ?? []), { timeout: 45_000 })
    .toEqual(expect.arrayContaining([expect.objectContaining({ lod: 'detailed' })]));
  await page.screenshot({ path: `${output}/water-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/water-mobile.png` });
  expect(errors).toEqual([]);
});
