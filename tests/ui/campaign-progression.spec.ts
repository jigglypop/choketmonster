import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createGame, createMonster, ITEM_PRICES, type GameState } from '../../src/game/engine';
import { defaultView, packSave, type SaveEnvelope } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { JOHTO_LOCATIONS } from '../../src/openworld/johto';
import { KANTO_LOCATIONS } from '../../src/openworld/kanto';
import { openExplorePanel } from './helpers/explore-panel';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));

test.setTimeout(120_000);
test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
});

async function load(page: Page, save: SaveEnvelope) {
  await page.goto('/');
  await expect(page.locator('[data-starter="152"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'campaign.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await openExplorePanel(page);
}

test('new adventures offer only the three Johto starters and begin with Gold records', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-starter]')).toHaveCount(3, { timeout: 30_000 });
  await expect(page.locator('[data-starter="152"]')).toContainText('치코리타');
  await expect(page.locator('[data-starter="155"]')).toContainText('브케인');
  await expect(page.locator('[data-starter="158"]')).toContainText('리아코');
  await expect(page.locator('[data-starter="1"], [data-starter="4"], [data-starter="7"]')).toHaveCount(0);
  await page.locator('[data-starter="155"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region', 'johto', { timeout: 30_000 });
  await expect(page.locator('#world-version')).toHaveValue('gold');
  await expect(page.locator('#world-encounter-layout')).toContainText('골드 고정');
});

test('the Johto map presents the next campaign challenge and destination', async ({ page }) => {
  const game = createGame(152, 'johto-campaign-ui');
  const world = new OpenWorldSimulation(graph, game, 8114, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const violet = JOHTO_LOCATIONS.find(location => location.id === 'violet')!;
  world.player = { x: violet.x, z: violet.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  await load(page, packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true }));
  await expect(page.locator('#world-gym')).toContainText('비상');
  await expect(page.locator('#world-gym')).toContainText('성도 배지 0/8');
  await page.locator('#world-map-open').click();
  await expect(page.locator('#world-campaign-guide')).toContainText('다음 도전');
  await expect(page.locator('#world-campaign-guide')).toContainText('윙배지');
  await expect(page.locator('#world-campaign-guide')).toContainText('도라지시티');
  await expect(page.locator('.kanto-zone-list .destination')).toContainText('다음 목적지');
});

test('a Johto gym victory names the regional badge, leader and next destination', async ({ page }) => {
  const game = createGame(152, 'johto-gym-victory-ui');
  const world = new OpenWorldSimulation(graph, game, 8244, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const violet = JOHTO_LOCATIONS.find(location => location.id === 'violet')!;
  world.player = { x: violet.x, z: violet.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  expect(world.challengeLocalGym()).toBe(true);
  game.player.team[0].moves = [{ moveId: 33, pp: 35 }];
  Object.assign(game.battle!.enemy.team[0], { hp: 1, status: 'sleep', statusTurns: 3 });
  world.requestAction({ type: 'move', index: 0 });
  await load(page, packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false }));
  await page.locator('#world-pause').click();
  const dialog = page.getByRole('dialog', { name: '윙배지 획득!' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText('도라지시티 관장 비상');
  await expect(dialog).toContainText('다음 도전 · 고동마을의 호일');
  await dialog.getByRole('button', { name: '모험 계속하기' }).click();
});

for (const fixture of [
  { title: 'Johto first elite', region: 'johto', locationId: 'tohjo-falls', johtoLeague: 0, kantoLeague: 0, name: '사천왕 일목' },
  { title: 'Johto champion', region: 'johto', locationId: 'tohjo-falls', johtoLeague: 4, kantoLeague: 0, name: '챔피언 목호' },
  { title: 'Kanto first elite', region: 'kanto', locationId: 'indigo-plateau', johtoLeague: 5, kantoLeague: 0, name: '사천왕 칸나' },
  { title: 'Kanto champion', region: 'kanto', locationId: 'indigo-plateau', johtoLeague: 5, kantoLeague: 4, name: '챔피언 그린' },
  { title: 'Red', region: 'johto', locationId: 'mt-silver', johtoLeague: 5, kantoLeague: 5, name: '레드' },
] as const) test(`${fixture.title} challenge starts from its world location and survives reload`, async ({ page }) => {
  const game = createGame(152, `campaign-${fixture.title}`);
  game.player.badges = fixture.region === 'kanto' || fixture.name === '레드' ? 8 : 0;
  game.defeatedGyms = game.player.badges === 8 ? [1, 2, 3, 4, 5, 6, 7, 8] : [];
  game.campaign = { startRegion: 'johto', johtoBadges: [1, 2, 3, 4, 5, 6, 7, 8], johtoLeague: fixture.johtoLeague, kantoLeague: fixture.kantoLeague, redDefeated: false };
  game.championDefeated = fixture.kantoLeague === 5;
  const world = new OpenWorldSimulation(graph, game, 8400 + fixture.johtoLeague * 10 + fixture.kantoLeague, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  if (fixture.region === 'kanto') world.changeRegion('kanto');
  const locations = fixture.region === 'kanto' ? KANTO_LOCATIONS : JOHTO_LOCATIONS;
  const destination = locations.find(location => location.id === fixture.locationId)!;
  world.player = { x: destination.x, z: destination.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  await load(page, packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false }));
  await expect(page.locator('#world-trainer-challenge')).toContainText(fixture.name);
  await page.locator('#world-trainer-challenge').click();
  await expect(page.locator('#world-battle-state')).toContainText('턴 1');
  await page.waitForTimeout(1_500);
  await page.reload();
  await expect(page.locator('#world-battle-state')).toContainText('턴 1', { timeout: 30_000 });
  await expect(page.locator('#world-combatants .world-combatant')).toHaveCount(2);
});

test('battle keeps the shop and safe box operations available while protecting the active monster', async ({ page }) => {
  await page.unroute('**/api/connectome');
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: true, graphId: 'test-full' } }));
  let requestStarted!: () => void, releaseRequest!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseRequest = resolve; });
  await page.route('**/api/local-brains/step-batch', async route => {
    requestStarted(); await release;
    const body = route.request().postDataJSON() as { steps: { creatureId: string; requestId: string }[] };
    await route.fulfill({ json: { decisions: body.steps.map(step => ({ creatureId: step.creatureId, requestId: step.requestId,
      decision: { action: 0, updates: 0, activity: 0, elapsedMs: 1, graphId: 'test-full', nodes: 10, edges: 10 } })) } });
  });
  const game: GameState = createGame(152, 'battle-box-ui');
  game.player.money = 20_000;
  game.player.team.push(createMonster(game, 155, 8));
  game.player.box.push(createMonster(game, 158, 7));
  const world = new OpenWorldSimulation(graph, game, 9135, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const wild = world.entities.find(entity => entity.kind === 'wild')!;
  world.player = { x: wild.x, z: wild.z + 1, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  expect(world.startEncounter(wild.id)).toBe(true);
  await load(page, packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true }));
  await page.locator('[data-world-move="0"]').click();
  await page.locator('#world-pause').click();
  await started;

  await page.locator('.world-shop summary').click();
  await expect(page.locator('[data-world-buy="poke-ball"]')).toHaveCount(2);
  await expect(page.locator('[data-world-buy="great-ball"], [data-world-buy="ultra-ball"]')).toHaveCount(0);
  const money = game.player.money;
  await page.locator('[data-world-buy="poke-ball"][data-quantity="1"]').click();
  await expect(page.locator('#world-ball-stock')).toContainText(`₩${(money - ITEM_PRICES['poke-ball']).toLocaleString('ko-KR')}`);

  const opening = page.locator('#world-box-open').click();
  await expect(page.locator('#world-box-dialog')).not.toHaveAttribute('open', '');
  releaseRequest(); await opening;
  const dialog = page.getByRole('dialog', { name: '팀 · 박스 관리' });
  await expect(dialog).toBeVisible();
  mkdirSync('artifacts/ui-campaign-checks', { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.screenshot({ path: 'artifacts/ui-campaign-checks/battle-box-mobile.png' });
  await expect(dialog.locator('[data-world-deposit="0"]')).toBeDisabled();
  await expect(dialog.locator('[data-world-deposit="1"]')).toBeEnabled();
  await dialog.locator('[data-world-deposit="1"]').click();
  await expect(dialog.getByRole('heading', { name: '팀 1/6' })).toBeVisible();
  await expect(dialog.locator('[data-world-withdraw]')).toHaveCount(2);
  await dialog.locator('[data-world-withdraw="0"]').click();
  await expect(dialog.getByRole('heading', { name: '팀 2/6' })).toBeVisible();
});

test('top team navigation settles an in-flight neural turn before allowing a safe deposit', async ({ page }) => {
  await page.unroute('**/api/connectome');
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: true, graphId: 'test-full' } }));
  let requestStarted!: () => void, releaseRequest!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseRequest = resolve; });
  await page.route('**/api/local-brains/step-batch', async route => {
    requestStarted(); await release;
    const body = route.request().postDataJSON() as { steps: { creatureId: string; requestId: string }[] };
    await route.fulfill({ json: { decisions: body.steps.map(step => ({ creatureId: step.creatureId, requestId: step.requestId,
      decision: { action: 0, updates: 0, activity: 0, elapsedMs: 1, graphId: 'test-full', nodes: 10, edges: 10 } })) } });
  });
  const game = createGame(152, 'top-team-settle-ui');
  game.player.team.push(createMonster(game, 155, 8));
  const world = new OpenWorldSimulation(graph, game, 9815, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const wild = world.entities.find(entity => entity.kind === 'wild')!;
  world.player = { x: wild.x, z: wild.z + 1, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  expect(world.startEncounter(wild.id)).toBe(true);
  await load(page, packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true }));
  await page.locator('[data-world-move="0"]').click();
  await page.locator('#world-pause').click();
  await started;

  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('[data-tab="team"]')).toBeDisabled();
  await expect(page.locator('.team-rack')).toHaveCount(0);
  releaseRequest();
  await expect(page.locator('.team-rack')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-deposit="0"]')).toBeDisabled();
  await expect(page.locator('[data-deposit="1"]')).toBeEnabled();
  await page.locator('[data-deposit="1"]').click();
  await expect(page.locator('.count-chip')).toContainText('팀 1/6 · 박스 1');
  await page.locator('[data-tab="map"]').click();
  await expect(page.locator('#world-battle-state')).toContainText('턴 1');
  await expect(page.locator('#world-combatants .world-combatant')).toHaveCount(2);
});
