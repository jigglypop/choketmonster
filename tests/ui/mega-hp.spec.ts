import { mockAuthenticatedSession } from './helpers/authenticated-session';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { activateBattleTransformation, createGame, createMonster } from '../../src/game/engine';
import { getMove } from '../../src/data/pokemon';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';
import { clickAccountMenu } from './helpers/account-menu';

test('Mega Floette and Zygarde use form HP in the world, healing and saved team details', async ({ page }, info) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**', socket => socket.close());
  await mockAuthenticatedSession(page);
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  await page.goto('/?renderProbe'); await page.locator('[data-starter="1"]').click();
  for (const [speciesId, identifier] of [[670, 'floette-mega'], [718, 'zygarde-mega']] as const) {
    const game = createGame(152, `mega-hp-ui-${speciesId}`), monster = createMonster(game, speciesId, 50);
    game.player.team = [monster]; game.inventory['super-potion'] = 1;
    monster.heldTool = `mega-stone:${identifier}`;
    const world = new OpenWorldSimulation(graph, game, 719); world.setControlMode('manual'); world.setAutoHunt(false);
    const wild = world.entities.find(entity => entity.kind === 'wild')!; world.battleWildId = wild.id;
    const enemy = createMonster(game, wild.speciesId, wild.level); enemy.moves = [{ moveId: 45, pp: getMove(45).pp }];
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
    const form = activateBattleTransformation(game, 'mega', { formIdentifier: identifier });
    monster.hp = monster.stats.hp + 1;
    const healedHp = Math.min(form.stats.hp, monster.hp + 60);
    await page.locator('#import-file').setInputFiles({ name: 'mega-hp.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true }))) });
    await expect(page.locator('#toast')).toContainText('불러왔습니다');
    await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
    await expect.poll(() => page.evaluate(id => (window as any).__renderProbe.read().formModels.some((model: any) => model.identifier === id && model.drawn > 0), identifier), { timeout: 20000 }).toBe(true);
    await expect(page.locator('.world-summary-hp')).toHaveText(`HP ${monster.hp} / ${form.stats.hp}`);
    await page.locator('.world-battle-hud > summary').click();
    await expect(page.locator('#world-super-potion')).toBeEnabled();
    await page.locator('#world-super-potion').click(); await page.locator('#world-resume').click();
    await expect(page.locator('#world-super-potion')).toHaveText('좋은상처약 ×0');
    await expect(page.locator('.world-summary-hp')).toHaveText(`HP ${healedHp} / ${form.stats.hp}`);
    await page.locator('[data-tab="team"]').click();
    await expect(page.locator('.stat-list')).toContainText(`${healedHp}/${form.stats.hp}`);
    await clickAccountMenu(page, '#save-now'); await expect(page.locator('#save-state')).toContainText('저장됨');
    await page.reload(); await page.locator('[data-tab="team"]').click();
    await expect(page.locator('.stat-list')).toContainText(`${healedHp}/${form.stats.hp}`);
    await page.screenshot({ path: info.outputPath(`${identifier}-hp.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
