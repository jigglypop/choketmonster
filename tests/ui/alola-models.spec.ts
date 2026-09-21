import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { assignAlolaForm, createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { ALOLA_MODEL_SOURCES } from '../../src/data/pokemon-form-models';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';

test('all 18 Alola regional forms draw their exact 3D geometry in the actual world', async ({ page }, info) => {
  test.setTimeout(240_000);
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/?renderProbe'); await page.locator('[data-starter="152"]').click();
  for (const source of ALOLA_MODEL_SOURCES) {
    const game = createGame(152, `all-alola-${source.speciesId}`), monster = createMonster(game, source.speciesId, 50);
    game.player.team = [monster]; assignAlolaForm(game, monster.instanceId, true);
    const world = new OpenWorldSimulation(graph, game, 431);
    world.setControlMode('manual'); world.setAutoHunt(false);
    const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
    await page.locator('#import-file').setInputFiles({ name: 'alola-3d.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
    await expect(page.locator('#toast')).toContainText('불러왔습니다');
    await expect.poll(() => page.evaluate(identifier => (window as any).__renderProbe?.read().formModels.find((model: any) => model.identifier === identifier)?.drawn ?? 0, source.identifier), { timeout: 30_000 }).toBeGreaterThan(0);
    const render = await page.evaluate(() => (window as any).__renderProbe.read());
    expect(render.formModels.find((model: any) => model.identifier === source.identifier)).toMatchObject({ url: source.url });
    expect(render.pokemonForms.some((name: string) => name.startsWith('pokemon-form:'))).toBe(false);
    await page.screenshot({ path: info.outputPath(`${source.identifier}.png`) });
    await page.locator('[data-tab="team"]').click();
    expect(errors, source.identifier).toEqual([]);
    const portrait = page.locator('#team-detail #pokemon-canvas');
    await expect(portrait).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
    await expect(portrait).toHaveAttribute('data-model-urls', source.url);
    await expect.poll(async () => Number(await portrait.getAttribute('data-triangles'))).toBeGreaterThan(0);
    if (source.identifier === 'raichu-alola') {
      await page.locator('#move-layout-fold > summary').click();
      await page.locator('[data-move-choice="0"]').selectOption('851');
      await page.locator('[data-replace-move="0"]').click();
      await expect(page.locator('[data-layout-move="851"]')).toBeVisible();
      await page.screenshot({ path: info.outputPath('alola-raichu-tera-blast-layout.png') });
    }
    await page.locator('[data-tab="map"]').click();
  }
  expect(errors).toEqual([]);
});
