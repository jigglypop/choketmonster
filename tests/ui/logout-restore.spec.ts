import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGame } from '../../src/game/engine';
import { ConnectomeController } from '../../src/game/connectome';
import { defaultView, packSave } from '../../src/game/storage';

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

async function fixture(page: Page, loggedIn: boolean, paused = true) {
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
  const game = createGame(4, 'logout-local-restore');
  game.player.team[0].nickname = '저장된 파이리';
  new ConnectomeController(graph).ensure(game.player.team[0]);
  const save = packSave(game, graph, { ...defaultView(), openWorldPaused: paused });
  const user = { id: 'logout-restore-user', username: 'restore' };
  const state = { loggedIn, rejectLogout: false, puts: [] as any[], reads: 0, remote: save, revision: 1 };
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: state.loggedIn ? user : null } }));
  await page.route('**/api/auth/login', route => { state.loggedIn = true; return route.fulfill({ json: { user } }); });
  await page.route('**/api/auth/logout', route => {
    if (state.rejectLogout) return route.fulfill({ status: 503, json: { message: '로그아웃 재시도' } });
    state.loggedIn = false; return route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/saves/current', route => {
    expect(route.request().headers()['x-choketmon-profile']).toBe(user.id);
    if (route.request().method() === 'GET') { state.reads++; return route.fulfill({ json: { save: state.remote, revision: state.revision } }); }
    const body = route.request().postDataJSON(); state.puts.push(body); state.remote = body.save;
    return route.fulfill({ json: { revision: ++state.revision } });
  });
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  return { state, save, user };
}

async function login(page: Page) {
  await page.locator('[data-open-auth]').click();
  await page.locator('.account-dialog input[name="username"]').fill('restore');
  await page.locator('.account-dialog input[name="password"]').fill('correct-password');
  await page.locator('.account-dialog button[value="login"]').click();
  await expect(page.locator('.account-dialog')).toBeHidden();
  await expect(page.locator('.account-name')).toContainText('restore');
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
      await page.locator('[data-starter="152"]').click();
      await expect(page.locator('#world-pause')).toBeVisible();
      await page.locator('#save-now').click();
      await expect.poll(async () => (await slots(page)).current?.game.seed, { timeout: 30000 }).toBeTruthy();
      guestSeed = (await slots(page)).current.game.seed;
      await login(page);
    }
    await expect(page.locator('#world-pause')).toContainText('계속 탐험', { timeout: 30000 });
    await page.locator('.logout-button').click();
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
  await expect(page.locator('#world-pause')).toContainText('일시 정지', { timeout: 30000 });
  await page.locator('.logout-button').click();
  await expect(page.locator('[data-open-auth]')).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('#world-pause')).toContainText('일시 정지');
  expect(state.puts.at(-1).save.view.openWorldPaused).toBe(false);
  expect((await slots(page)).current.view.openWorldPaused).toBe(false);
});

test('a rejected logout keeps the current account and the previous device save', async ({ page }) => {
  test.setTimeout(90000);
  const { state, user } = await fixture(page, false);
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#world-pause')).toBeVisible(); await login(page);
  const prior = (await slots(page)).current;
  state.rejectLogout = true;
  await page.locator('.logout-button').click();
  await expect(page.locator('#toast')).toContainText('로그아웃에 실패했습니다');
  await expect(page.locator('.logout-button')).toBeEnabled();
  const stored = await slots(page);
  expect(stored.current).toEqual(prior);
  expect(stored[`account:${user.id}:current`].game.seed).toBe('logout-local-restore');
  expect(Object.keys(stored).filter(key => key.startsWith('backup-before-logout-'))).toEqual([]);
  await expect(page.locator('.account-name')).toContainText('restore');
  await expect(page.locator('#starter-dialog')).toBeHidden();
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
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#world-pause')).toBeVisible();
  await page.locator('[data-open-auth]').click();
  await page.locator('.account-dialog input[name="username"]').fill('restore');
  await page.locator('.account-dialog input[name="password"]').fill('correct-password');
  await page.locator('.account-dialog button[value="login"]').click();
  try {
    await expect.poll(() => arrived).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    expect((await slots(page))[`account:${user.id}:current`]).toBeUndefined();
  } finally { release(); }
  await expect(page.locator('.account-dialog')).toBeHidden();
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.monster-card strong').first()).toHaveText('저장된 파이리');
});
