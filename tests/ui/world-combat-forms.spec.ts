import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { activateBattleTransformation, assignAlolaForm, createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';

test('WebGPU exploration renders Alola sprites, Mega aura and Tera crystal', async ({ page }, info) => {
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
    const world = new OpenWorldSimulation(graph, game, 420);
    world.setControlMode('manual'); world.setAutoHunt(false);
    if (kind !== 'alola') {
      const wild = world.entities.find(entity => entity.kind === 'wild')!;
      world.battleWildId = wild.id;
      game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, wild.speciesId, wild.level)], activeIndex: 0 }, turn: 1, canRun: true };
      activateBattleTransformation(game, kind, kind === 'mega' ? { formIdentifier: 'charizard-mega-x' } : { teraType: 'water' });
    }
    const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
    await page.locator('#import-file').setInputFiles({ name: 'world-form.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
    await expect(page.locator('#toast')).toContainText('불러왔습니다');
    await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    const expected = kind === 'alola' ? 'pokemon-form:raichu-alola' : `pokemon-transformation:${kind}`;
    await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().pokemonForms), { timeout: 20_000 }).toContain(expected);
    if (kind === 'mega') expect(await page.evaluate(() => (window as any).__renderProbe.read().pokemonForms)).toContain('pokemon-form:charizard-mega-x');
    await page.screenshot({ path: info.outputPath(`world-${kind}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
