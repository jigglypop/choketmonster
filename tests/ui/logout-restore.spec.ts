import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGame } from '../../src/game/engine';
import { ConnectomeController } from '../../src/game/connectome';
import { defaultView, packSave, type ViewState } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { openExplorePanel } from './helpers/explore-panel';
import { clickAccountMenu } from './helpers/account-menu';

async function slots(page: Page) {
  return page.evaluate(() => new Promise<Record<string, any>>((resolve, reject) => {
    const request = indexedDB.open('choketmon-151', 2);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('saves', 'readonly'), store = tx.objectStore('saves');
      const keys = store.getAllKeys(), values = store.getAll();
      tx.oncomplete = () => { resolve(Object.fromEntries(keys.result.map((key, i) => [String(key), values.result[i]]))); db.close(); };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  }));
}

async function fixture(page: Page, loggedIn: boolean, paused = true, shortRoster = false) {
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
  const game = createGame(4, 'logout-local-restore');
  game.player.team[0].nickname = '저장된 파이리';
  new ConnectomeController(graph).ensure(game.player.team[0]);
  const view: ViewState = { ...defaultView(), openWorldPaused: paused };
  if (shortRoster) {
    const world = new OpenWorldSimulation(graph, game, 24_680).snapshot();
    world.entities = world.entities.filter(entity => entity.kind === 'companion').concat(world.entities.filter(entity => entity.kind === 'wild').slice(0, 8));
    world.respawnQueue = [];
    view.openWorld = world;
  }
  const save = packSave(game, graph, view);
  const user = { id: 'logout-restore-user', username: 'restore' };
  const state = { loggedIn, rejectLogout: false, rejectCheckpoint: false, puts: [] as any[], reads: 0, remote: save, revision: 1 };
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: state.loggedIn ? user : null } }));
  await page.route('**/api/auth/login', route => { state.loggedIn = true; return route.fulfill({ json: { user } }); });
  await page.route('**/api/auth/logout', route => {
    if (state.rejectLogout) return route.fulfill({ status: 503, json: { message: '로그아웃 재시도' } });
    state.loggedIn = false; return route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/saves/current', route => {
    expect(route.request().headers()['x-choketmon-profile']).toBe(user.id);
    if (route.request().method() === 'GET') { state.reads++; return route.fulfill({ json: { save: state.remote, revision: state.revision } }); }
    if (state.rejectCheckpoint) return route.fulfill({ status: 401, json: { message: 'session expired' } });
    const body = route.request().postDataJSON(); state.puts.push(body); state.remote = body.save;
    return route.fulfill({ json: { revision: ++state.revision } });
  });
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  return { state, save, user };
}

test('login repairs a short server wild roster and preserves its saved individuals across reload', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { save, user } = await fixture(page, false, true, true);
  const savedWorld = save.view.openWorld!;
  const savedWilds = savedWorld.entities.filter(entity => entity.kind === 'wild').map(entity => ({ id: entity.id, brain: entity.brain }));
  await page.goto('/');
  await login(page, true);
  await expect(page.locator('#toast')).not.toContainText('Open world requires');
  await clickAccountMenu(page, '#save-now');
  const accountKey = `account:${user.id}:current`;
  await expect.poll(async () => (await slots(page))[accountKey]?.view?.openWorld?.entities?.filter((entity: { kind: string }) => entity.kind === 'wild').length, { timeout: 30000 }).toBe(12);
  const repaired = (await slots(page))[accountKey].view.openWorld;
  for (const saved of savedWilds) expect(repaired.entities.find((entity: { id: string }) => entity.id === saved.id)?.brain).toEqual(saved.brain);
  await page.reload(); await openExplorePanel(page);
  await expect(page.locator('#world-pause')).toBeVisible({ timeout: 30000 });
  expect(errors).toEqual([]);
});

async function login(page: Page, fromStarter = false) {
  if (fromStarter) { await expect(page.locator('[data-load-account]')).toBeVisible(); await page.locator('[data-load-account]').click(); }
  else await page.locator('[data-open-auth]').click();
  await page.locator('.account-dialog input[name="username"]').fill('restore');
  await page.locator('.account-dialog input[name="password"]').fill('correct-password');
  await page.locator('.account-submit').click();
  await expect(page.locator('.account-dialog')).toBeHidden();
  await expect(page.locator('.account-name')).toContainText('restore');
  await openExplorePanel(page);
  await expect(page.locator('#world-pause')).toBeVisible();
}

for (const existingGuest of [false, true]) {
  test(`logout restores the account adventure locally and after reload (existing guest: ${existingGuest})`, async ({ page }) => {
    test.setTimeout(120000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const { state, save, user } = await fixture(page, !existingGuest);
    await page.goto('/');
    let guestSeed: unknown;
    if (existingGuest) {
      await page.locator('[data-starter="1"]').click();
      await openExplorePanel(page);
      await expect(page.locator('#world-pause')).toBeVisible();
      await clickAccountMenu(page, '#save-now');
      await expect.poll(async () => (await slots(page)).current?.game.seed, { timeout: 30000 }).toBeTruthy();
      guestSeed = (await slots(page)).current.game.seed;
      await login(page);
    } else await openExplorePanel(page);
    await expect(page.locator('#world-pause')).toContainText('계속 탐험', { timeout: 30000 });
    await clickAccountMenu(page, '.logout-button');
    await expect(page.locator('[data-open-auth]')).toBeEnabled({ timeout: 30000 });
    await expect(page.locator('#starter-dialog')).toBeHidden();
    await expect(page.locator('#world-pause')).toContainText('계속 탐험');
    const stored = await slots(page), checkpoint = state.puts.at(-1).save;
    expect(stored.current).toEqual(checkpoint);
    expect(stored[`account:${user.id}:current`]).toEqual(checkpoint);
    expect(stored.current.game.player.team[0].brain).toEqual((save.game as any).player.team[0].brain);
    const backups = Object.entries(stored).filter(([key]) => key.startsWith('backup-before-logout-'));
    expect(backups).toHaveLength(existingGuest ? 1 : 0);
    if (existingGuest) expect(backups[0][1].game.seed).toEqual(guestSeed);
    const requestsAtLogout = { reads: state.reads, puts: state.puts.length };
    await page.reload();
    await openExplorePanel(page);
    await expect(page.locator('#world-pause')).toContainText('계속 탐험', { timeout: 30000 });
    await expect(page.locator('#starter-dialog')).toBeHidden();
    await page.locator('[data-tab="team"]').click();
    await expect(page.locator('.monster-card strong').first()).toHaveText('저장된 파이리');
    expect((await slots(page)).current).toEqual(checkpoint);
    expect({ reads: state.reads, puts: state.puts.length }).toEqual(requestsAtLogout);
    await login(page);
    await page.locator('[data-tab="team"]').click();
    await expect(page.locator('.monster-card strong').first()).toHaveText('저장된 파이리');
    expect(errors).toEqual([]);
    const output = process.env.CHOKETMON_LOGOUT_ARTIFACTS ?? 'artifacts/logout-restore/local'; mkdirSync(output, { recursive: true });
    writeFileSync(`${output}/restore-${existingGuest}.json`, JSON.stringify({ existingGuest, seed: checkpoint.game.seed, backupCount: backups.length, restoredBrain: true, reloadWithoutServerSaves: true, errors }, null, 2));
  });
}

test('logout preserves a running adventure instead of saving the temporary transition pause', async ({ page }) => {
  test.setTimeout(90000);
  const { state } = await fixture(page, true, false);
  await page.goto('/');
  await openExplorePanel(page);
  await expect(page.locator('#world-pause')).toContainText('일시 정지', { timeout: 30000 });
  await clickAccountMenu(page, '.logout-button');
  await expect(page.locator('[data-open-auth]')).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('#world-pause')).toContainText('일시 정지');
  expect(state.puts.at(-1).save.view.openWorldPaused).toBe(false);
  expect((await slots(page)).current.view.openWorldPaused).toBe(false);
  const tick = await page.locator('#ow-host').getAttribute('data-tick');
  await expect(page.locator('#ow-host')).not.toHaveAttribute('data-tick', tick!);
  await page.reload();
  await expect(page.locator('[data-open-auth]')).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'false');
  const restoredTick = await page.locator('#ow-host').getAttribute('data-tick');
  await expect(page.locator('#ow-host')).not.toHaveAttribute('data-tick', restoredTick!);
});

test('a rejected server logout remains logged out locally across reload and preserves both save slots', async ({ page }) => {
  test.setTimeout(90000);
  const { state, user } = await fixture(page, false);
  await page.goto('/'); await page.locator('[data-starter="1"]').click();
  await openExplorePanel(page);
  await expect(page.locator('#world-pause')).toBeVisible(); await login(page);
  const prior = (await slots(page)).current;
  state.rejectLogout = true;
  await clickAccountMenu(page, '.logout-button');
  await expect(page.locator('[data-open-auth]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.logout-button')).toBeHidden();
  const stored = await slots(page);
  expect(stored.current.game.seed).toBe('logout-local-restore');
  expect(stored[`account:${user.id}:current`].game.seed).toBe('logout-local-restore');
  expect(Object.values(stored).some((value: any) => value?.game?.seed === prior.game.seed)).toBe(true);
  await expect(page.locator('#starter-dialog')).toBeHidden();
  await page.reload();
  await expect(page.locator('[data-open-auth]')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.logout-button')).toBeHidden();
  expect((await slots(page)).current.game.seed).toBe('logout-local-restore');
});

test('an expired save checkpoint cannot block logout or discard its outbox', async ({ page }) => {
  test.setTimeout(90000);
  const { state, user } = await fixture(page, true);
  state.rejectCheckpoint = true;
  await page.goto('/'); await openExplorePanel(page);
  await expect(page.locator('.account-name')).toContainText('restore');
  await clickAccountMenu(page, '.logout-button');
  await expect(page.locator('[data-open-auth]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.logout-button')).toBeHidden();
  const stored = await slots(page);
  expect(stored.current.game.seed).toBe('logout-local-restore');
  expect(stored[`account:${user.id}:current`].game.seed).toBe('logout-local-restore');
  await page.reload();
  await expect(page.locator('[data-open-auth]')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.logout-button')).toBeHidden();
  expect((await slots(page)).current.game.seed).toBe('logout-local-restore');
});

test('pagehide during login cannot write the previous adventure into the new account slot', async ({ page }) => {
  test.setTimeout(90000);
  const { save, user } = await fixture(page, false);
  let release!: () => void, arrived = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/saves/current', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    arrived = true; await gate; return route.fulfill({ json: { save, revision: 1 } });
  });
  await page.goto('/'); await page.locator('[data-starter="1"]').click();
  await openExplorePanel(page);
  await expect(page.locator('#world-pause')).toBeVisible();
  await page.locator('[data-open-auth]').click();
  await page.locator('.account-dialog input[name="username"]').fill('restore');
  await page.locator('.account-dialog input[name="password"]').fill('correct-password');
  await page.locator('.account-submit').click();
  try {
    await expect.poll(() => arrived).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    expect((await slots(page))[`account:${user.id}:current`]).toBeUndefined();
  } finally { release(); }
  await expect(page.locator('.account-dialog')).toBeHidden();
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.monster-card strong').first()).toHaveText('저장된 파이리');
});
