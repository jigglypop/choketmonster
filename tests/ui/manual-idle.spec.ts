import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

test.setTimeout(90000);
async function start(page: Page, phase: 'field' | 'battle' | 'capture' = 'field') {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  // These scenarios exercise controls and persistence, independently of asset downloads.
  await page.route(/\.glb(?:\?|$)/, route => route.abort());
  await page.goto('/');
  await page.locator('[data-starter="1"]').click();
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  const game = createGame(1, 'idle-controls');
  const world = new OpenWorldSimulation(graph, game, 63017);
  world.setControlMode('manual'); world.setAutoHunt(false);
  // Inspect without tracking so automatic field movement cannot start an
  // unrelated contact battle between the controls assertions.
  world.selectWild(world.entities.find(entity => entity.kind === 'wild')!.id, true);
  if (phase === 'battle') world.startEncounter(world.selectedWildId!);
  if (phase === 'capture') {
    game.captureOffer = createMonster(game, 19, 5); game.captureOffer.hp = 0;
    game.dex.seen.push(19);
  }
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
  await page.locator('#import-file').setInputFiles({ name: 'idle.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await expect(page.locator('#world-pause')).toContainText('계속');
}

test('returns to auto after keyboard inactivity, while pause and the map suspend the delay', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page);
  await page.waitForTimeout(3500);
  await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#world-pause').click();
  await page.keyboard.down('KeyW');
  try {
    await page.waitForTimeout(4000);
    await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
  } finally { await page.keyboard.up('KeyW'); }
  await expect(page.locator('#world-mode-auto')).toHaveAttribute('aria-pressed', 'true', { timeout: 10000 });
  await expect(page.locator('#world-auto-hunt')).not.toBeChecked();
  await page.locator('#world-mode-manual').click();
  await page.locator('#world-map-open').click();
  await page.waitForTimeout(3500);
  await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#world-map-close').click();
  await expect(page.locator('#world-mode-auto')).toHaveAttribute('aria-pressed', 'true', { timeout: 10000 });
  await page.locator('#world-pause').click();
  await page.locator('#save-now').click();
  await expect(page.locator('#toast')).toContainText('저장');
  await page.reload();
  await expect(page.locator('#world-mode-auto')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('touch input keeps manual mode until the held direction is released', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await page.locator('#world-pause').click();
  const box = await page.locator('[data-world-step="0,-1"]').boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  try {
    await page.waitForTimeout(4000);
    await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
  } finally { await page.mouse.up(); }
  await expect(page.locator('#world-mode-auto')).toHaveAttribute('aria-pressed', 'true', { timeout: 10000 });
});

for (const phase of ['battle', 'capture'] as const) {
  test(`keeps manual mode while waiting for a ${phase} decision`, async ({ page }) => {
    await start(page, phase);
    await page.locator('#world-pause').click();
    await page.waitForTimeout(4000);
    await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
    if (phase === 'battle') await expect(page.locator('#world-battle-state')).toContainText('턴 1');
    else await expect(page.locator('#world-capture-offer')).toBeVisible();
  });
}
