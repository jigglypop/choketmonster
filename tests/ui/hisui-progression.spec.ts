import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { getWorldAtlas } from '../../src/openworld/atlas';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { openExplorePanel } from './helpers/explore-panel';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
const allBadges = [1, 2, 3, 4, 5, 6, 7, 8];
const atlas = getWorldAtlas('hisui');
test.setTimeout(150_000);
test.use({ launchOptions: { args: ['--mute-audio', '--enable-unsafe-webgpu'] } });

function fixture(earned: number, point: { x: number; z: number }) {
  const game = createGame(152, `hisui-stage-${earned}`);
  game.defeatedGyms = [...allBadges]; game.player.badges = 8; game.championDefeated = true;
  game.campaign = { startRegion: 'johto', johtoBadges: [...allBadges], johtoLeague: 5, kantoLeague: 5, redDefeated: false, expansion: {
    hoenn: { badges: [...allBadges], league: 5 }, sinnoh: { badges: [...allBadges], league: 5 }, unova: { badges: [...allBadges], league: 5 },
    kalos: { badges: [...allBadges], league: 5 }, alola: { badges: [...allBadges], league: 5 }, galar: { badges: [...allBadges], league: 5 },
    hisui: { badges: allBadges.slice(0, earned), league: 0 },
  } };
  const partner = createMonster(game, 899, 30); partner.originRegion = 'hisui'; game.player.team = [partner];
  game.claimedRegionalStarters = [...new Set([...(game.claimedRegionalStarters ?? []), 'hisui' as const])];
  game.dex.caught = [152, 899]; game.dex.seen = [152, 899];
  const world = new OpenWorldSimulation(graph, game, 7192, undefined, policy);
  world.changeRegion('hisui'); world.setControlMode('manual'); world.setAutoHunt(false);
  world.player = { x: point.x, z: point.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  return packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });
}

async function importSave(page: Page, save: ReturnType<typeof fixture>) {
  await page.locator('#import-file').setInputFiles({ name: 'hisui-progression.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region', 'hisui');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
}

async function prepare(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /WebGPU|WGSL|GPUValidation|THREE/i.test(message.text())) errors.push(message.text()); });
  await page.routeWebSocket(url => url.pathname === '/' && url.searchParams.has('token'), () => {});
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/?renderProbe=1');
  await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  return errors;
}

test('one investigation badge walks to Brava Arena and starts the second challenge', async ({ page }, testInfo) => {
  const errors = await prepare(page);
  const start = atlas.locations.find(location => location.id === 'crimson-mirelands')!;
  await importSave(page, fixture(1, start));
  await page.locator('[data-tab="map"]').click();
  await page.locator('#world-map-open').click();
  const brava = page.locator('[data-location-id="brava-arena"]');
  await expect(brava).toHaveClass(/traversable/);
  const locked = page.locator('[data-map-list-location="coastlands-camp"]');
  await expect(locked).toContainText('드레디어 진정 완료');
  await expect(locked).toContainText('조사증 2개 필요 (현재 1개)');
  await locked.click();
  await expect(page.locator('#toast')).toContainText('드레디어 진정 완료');
  await expect(page.locator('#world-map-dialog')).toBeVisible();
  await testInfo.attach('hisui-stage-one-map', { body: await page.screenshot({ path: testInfo.outputPath('stage-one-map.png') }), contentType: 'image/png' });
  await page.locator('#world-map-close').click();
  await openExplorePanel(page);
  await page.locator('#world-pause').click();
  await page.locator('#world-map-open').click();
  await brava.focus(); await brava.press('Enter');
  await expect(page.locator('#world-map-dialog')).not.toBeVisible();
  await openExplorePanel(page);
  if (await page.locator('#ow-host').getAttribute('data-paused') === 'true') await page.locator('#world-pause').click();
  await expect(page.locator('#world-location-short')).toContainText('무대의 전장', { timeout: 40_000 });
  await page.locator('#world-pause').click();
  await expect(page.locator('#world-gym-challenge')).toBeEnabled();
  await expect(page.locator('#world-gym-challenge')).toContainText('드레디어 진정');
  await page.locator('#world-gym-challenge').click();
  await expect(page.locator('#world-battle-state')).toContainText('턴 1');
  await expect(page.locator('#world-combatants .world-combatant')).toHaveCount(2);
  await testInfo.attach('brava-challenge-started', { body: await page.screenshot({ path: testInfo.outputPath('brava-battle.png') }), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('a visible terrain gate explains the prerequisite and opens after it is earned', async ({ page }, testInfo) => {
  const errors = await prepare(page);
  const gate = atlas.gates.find(item => item.from === 'coronet-highlands' && item.to === 'moonview-arena')!;
  const from = atlas.locations.find(item => item.id === gate.from)!, to = atlas.locations.find(item => item.id === gate.to)!;
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  const point = { x: gate.position!.x - (to.x - from.x) / length * 7, z: gate.position!.z - (to.z - from.z) / length * 7 };
  await importSave(page, fixture(3, point));
  await page.locator('[data-tab="map"]').click();
  const label = page.locator(`[data-gate-id="${gate.id}"]`);
  await expect(label).toBeVisible({ timeout: 30_000 });
  await expect(label).toHaveAttribute('data-gate-state', 'locked');
  await expect(label).toContainText('천관산 조사 완료 후 개방');
  await expect(label).toContainText('조사증 3/4');
  await expect(label).toBeInViewport({ ratio: 1 });
  await testInfo.attach('hisui-locked-gate', { body: await page.screenshot({ path: testInfo.outputPath('locked-gate.png') }), contentType: 'image/png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(label).toBeVisible();
  await expect(label).toBeInViewport({ ratio: 1 });
  await testInfo.attach('hisui-locked-gate-mobile', { body: await page.screenshot({ path: testInfo.outputPath('locked-gate-mobile.png') }), contentType: 'image/png' });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await importSave(page, fixture(4, point));
  await expect(label).toHaveAttribute('data-gate-state', 'open');
  await expect(label).toContainText('관문 개방');
  await page.locator('#save-now').click();
  await expect(page.locator('#toast')).toContainText('저장했습니다');
  await page.reload();
  await expect(label).toHaveAttribute('data-gate-state', 'open', { timeout: 45_000 });
  expect(errors).toEqual([]);
});
