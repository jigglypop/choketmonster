import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { assignPreferredTransformation, assignAlolaForm, createGame, createMonster, replaceMonsterMove } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';

test('WebGPU exploration renders Alola geometry, Mega aura and Tera crystal', async ({ page }, info) => {
  test.setTimeout(90_000);
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/?renderProbe');
  await page.locator('[data-starter="152"]').click();
  for (const kind of ['alola', 'mega', 'tera'] as const) {
    const game = createGame(152, `world-form-${kind}`), monster = createMonster(game, kind === 'alola' ? 26 : 6, 50);
    game.player.team = [monster];
    if (kind === 'alola') assignAlolaForm(game, monster.instanceId, true);
    if (kind === 'tera') replaceMonsterMove(game, monster.instanceId, 0, 851);
    if (kind === 'mega') assignPreferredTransformation(game, monster.instanceId, { kind, formIdentifier: 'charizard-mega-x' });
    if (kind === 'tera') assignPreferredTransformation(game, monster.instanceId, { kind, teraType: 'water' });
    const world = new OpenWorldSimulation(graph, game, 420);
    world.setControlMode('manual'); world.setAutoHunt(false);
    if (kind !== 'alola') {
      const wild = world.entities.find(entity => entity.kind === 'wild')!;
      world.battleWildId = wild.id;
      game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, wild.speciesId, wild.level)], activeIndex: 0 }, turn: 1, canRun: true };
    }
    const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
    await page.locator('#import-file').setInputFiles({ name: 'world-form.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
    await expect(page.locator('#toast')).toContainText('불러왔습니다');
    await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    if (kind === 'alola') {
      await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().formModels.some((model: any) => model.identifier === 'raichu-alola' && model.meshes > 0 && model.drawn > 0)), { timeout: 20_000 }).toBe(true);
      expect(await page.evaluate(() => (window as any).__renderProbe.read().pokemonForms)).not.toContain('pokemon-form:raichu-alola');
    } else await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().pokemonForms), { timeout: 20_000 }).toContain(`pokemon-transformation:${kind}`);
    if (kind === 'mega') {
      await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().formModels.some((model: any) => model.identifier === 'charizard-mega-x' && model.drawn > 0)), { timeout: 20_000 }).toBe(true);
      expect(await page.evaluate(() => (window as any).__renderProbe.read().pokemonForms)).not.toContain('pokemon-form:charizard-mega-x');
    }
    if (kind === 'tera') {
      await expect.poll(() => page.evaluate(() => (window as any).__renderProbe.read().teraSurfaces), { timeout: 20_000 }).toBeGreaterThan(0);
      expect(await page.evaluate(() => (window as any).__renderProbe.read().teraCrowns)).toContain('tera-crown:water');
      await page.locator('.world-battle-hud > summary').click();
      await expect(page.locator('[data-world-move-id="851"]')).toHaveClass(/type-water/);
    }
    await page.screenshot({ path: info.outputPath(`world-${kind}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
