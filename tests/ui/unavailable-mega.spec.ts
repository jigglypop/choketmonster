import { mockAuthenticatedSession } from './helpers/authenticated-session';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';

test('Mega forms without 3D models are absent from battle choices and old saves', async ({ page }) => {
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**', socket => socket.close());
  await mockAuthenticatedSession(page);
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/?renderProbe'); await page.locator('[data-starter="1"]').click();
  const game = createGame(152, 'unavailable-mega'), monster = createMonster(game, 36, 50);
  game.player.team = [monster];
  const world = new OpenWorldSimulation(graph, game, 431);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const wild = world.entities.find(entity => entity.kind === 'wild')!;
  world.battleWildId = wild.id;
  game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, wild.speciesId, wild.level)], activeIndex: 0 }, turn: 1, canRun: true };
  for (const legacyMega of [false, true]) {
    if (legacyMega) {
      game.battle.playerMegaUsed = true;
      game.battle.transformations = { [monster.instanceId]: { kind: 'mega', speciesId: 36, formIdentifier: 'clefable-mega', types: ['fairy', 'flying'], stats: structuredClone(monster.stats), moves: structuredClone(monster.moves) } };
    }
    const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
    await page.locator('#import-file').setInputFiles({ name: 'unavailable-mega.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
    await expect(page.locator('#toast')).toContainText('불러왔습니다');
    await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
    await page.locator('.world-battle-hud > summary').click();
    await expect(page.locator('[data-mega-form]')).toHaveCount(0);
    await expect(page.locator('[data-battle-transformation="mega"]')).toHaveCount(0);
    await expect(page.locator('[data-battle-transformation="tera"]')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__renderProbe.read().pokemonForms)).not.toContain('pokemon-form:clefable-mega');
    await expect(page.locator('body')).not.toContainText('메가픽시');
  }
  expect(errors).toEqual([]);
});
