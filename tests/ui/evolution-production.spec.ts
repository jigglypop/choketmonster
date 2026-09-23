import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { ConnectomeController } from '../../src/game/connectome';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { clickAccountMenu } from './helpers/account-menu';

// Explicit release check: never creates accounts during the ordinary UI suite.
test.skip(process.env.CHOKETMON_LIVE_EVOLUTION !== '1', 'enable only for an authorized production release check');
test('production account restores legacy friendship data but evolves through capsules in a clean browser', async ({ browser, request, baseURL }) => {
  test.setTimeout(240_000);
  if (!baseURL?.startsWith('https://')) throw new Error('The live check requires an explicit HTTPS origin');
  const suffix = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
  const username = `evo_${suffix}`, password = `Evo-${suffix}!`;
  const registration = await request.post(`${baseURL}/api/auth/register`, { headers: { origin: baseURL }, data: { username, password } });
  expect(registration.ok()).toBe(true);
  const { user } = await registration.json(), headers = { origin: baseURL, 'x-choketmon-profile': user.id };
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
  const game = createGame(152, `live-evolution-${suffix}`), golbat = createMonster(game, 42, 20), combee = createMonster(game, 415, 21);
  golbat.evolutionProgress!.friendship = 150; combee.evolutionProgress!.gender = 'male';
  game.player.team = [golbat]; game.player.box = [combee];
  game.dex.seen = [42,152,415]; game.dex.caught = [...game.dex.seen];
  game.inventory['friendship-treat'] = 1; game.inventory['evolution-catalyst'] = 2;
  const controller = new ConnectomeController(graph); controller.ensure(golbat); controller.ensure(combee);
  const world = new OpenWorldSimulation(graph, game, 24_680).snapshot();
  world.entities = world.entities.filter(entity => entity.kind === 'companion').concat(world.entities.filter(entity => entity.kind === 'wild').slice(0, 8));
  world.respawnQueue = [];
  const save = packSave(game, graph, { ...defaultView(), openWorldPaused: true, learning: false, openWorld: world });
  const seeded = await request.put(`${baseURL}/api/saves/current`, { headers, data: { save, revision: 0, requestId: crypto.randomUUID() } });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  const errors: string[] = [];
  async function login(page: Page) {
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL!);
    await page.locator('[data-load-account]').click();
    await page.locator('.account-dialog input[name="username"]').fill(username);
    await page.locator('.account-dialog input[name="password"]').fill(password);
    await page.locator('.account-submit').click();
    await expect(page.locator('.account-dialog')).toBeHidden({ timeout: 45_000 });
    await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    await page.locator('[data-tab="team"]').click();
  }
  const first = await browser.newContext({ viewport: { width: 1440, height: 1100 } }), page = await first.newPage();
  await login(page);
  await page.locator('.evolution-panel > summary').click();
  await expect(page.locator('.evolution-growth')).toHaveCount(0);
  await expect(page.locator('[data-evolve="169"]')).toBeDisabled();
  await page.locator('[data-capsule-evolve="169"]').click();
  await expect(page.locator('.detail-title h2')).toHaveText('크로뱃');
  await page.locator(`[data-monster="${combee.instanceId}"]`).click();
  await page.locator('.evolution-panel > summary').click();
  await expect(page.locator('[data-evolve="416"]')).toBeDisabled();
  await page.locator('[data-capsule-evolve="416"]').click();
  await expect(page.locator('.detail-title h2')).toHaveText('비퀸');
  await clickAccountMenu(page, '#save-now');
  let persisted: any;
  await expect.poll(async () => {
    const response = await request.get(`${baseURL}/api/saves/current`, { headers });
    persisted = await response.json();
    return persisted.save?.game?.player?.box?.find((mon: any) => mon.instanceId === combee.instanceId)?.speciesId;
  }, { timeout: 45_000 }).toBe(416);
  expect(persisted.save.game.player.team[0].speciesId).toBe(169);
  expect(persisted.save.game.player.team[0].evolutionProgress.friendship).toBe(150);
  expect(persisted.save.game.inventory['friendship-treat']).toBe(1);
  expect(persisted.save.game.inventory['evolution-catalyst']).toBe(0);
  const population = persisted.save.view.openWorld.entities.filter((entity: any) => entity.kind === 'wild').length + (persisted.save.view.openWorld.respawnQueue?.length ?? 0);
  expect(population).toBeGreaterThanOrEqual(12);
  await first.close();

  const clean = await browser.newContext({ viewport: { width: 390, height: 844 } }), restored = await clean.newPage();
  await login(restored);
  await expect(restored.locator(`.monster-card[data-monster="${golbat.instanceId}"]`)).toContainText('크로뱃');
  await expect(restored.locator(`.monster-card[data-monster="${combee.instanceId}"]`)).toContainText('비퀸');
  await expect(restored.locator('.evolution-growth')).toHaveCount(0);
  mkdirSync('artifacts/evolution-completeness/production', { recursive: true });
  await restored.locator('#team-detail').scrollIntoViewIfNeeded();
  await restored.screenshot({ path: 'artifacts/evolution-completeness/production/restored-mobile.png' });
  expect(errors).toEqual([]);
  writeFileSync('artifacts/evolution-completeness/production/receipt.json', JSON.stringify({ verifiedAt: new Date().toISOString(), baseURL, username,
    source: 'real production API and two clean browser contexts; no route mocks', revision: persisted.revision,
    species: [169,416], preservedLegacyFriendship: 150, shortPopulationRepairedTo: population, errors }, null, 2));
  await clean.close();
});
