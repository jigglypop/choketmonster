import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openExplorePanel } from './helpers/explore-panel';

test.skip(!process.env.CHOKETMON_LIVE_AUTH, 'Requires an explicitly selected Rust/PostgreSQL server.');

test('account save continues locally after logout and restores Johto from the server in a clean browser', async ({ page, browser, baseURL }) => {
  test.setTimeout(240000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const username = `live_${Date.now().toString(36)}`, password = `Test-${crypto.randomUUID()}-pass`;
  await page.goto('/');
  await expect(page.locator('#starter-dialog')).toBeVisible();
  await page.locator('#starter-dialog [data-starter="152"]').click();
  await expect(page.locator('#starter-dialog')).toBeHidden();

  await page.locator('[data-open-auth]').click();
  await page.locator('.account-mode button[value="register"]').click();
  await page.locator('.account-dialog input[name="username"]').fill(username);
  await page.locator('.account-dialog input[name="password"]').fill(password);
  await page.locator('.account-dialog input[name="passwordConfirmation"]').fill(password);
  await page.locator('.account-submit').click();
  await expect(page.locator('.account-name')).toContainText(username);
  await expect(page.locator('.account-dialog')).toBeHidden();
  await expect(page.locator('#starter-dialog')).toBeVisible();
  // Keep the world clock stopped while staging the save. Otherwise an automatic
  // encounter can legitimately lock region travel before Playwright reaches it.
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
  await page.locator('#starter-dialog [data-starter="155"]').click();
  await expect(page.locator('#starter-dialog')).toBeHidden();
  await openExplorePanel(page);
  await page.locator('#world-pause').click();
  await expect(page.locator('#world-pause')).toContainText('계속 탐험');
  await expect(page.locator('#save-state')).toHaveAttribute('data-state', 'local', { timeout: 30000 });

  await page.locator('#world-map-open').click();
  await page.locator('#world-region').selectOption('johto');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region', 'johto');
  await page.locator('#world-map-close').click();
  // Encounter versions are now fixed by region; legacy collection metadata
  // still travels with the save without exposing a version selector.
  await expect(page.locator('#world-version')).toHaveCount(0);
  await page.evaluate(() => { Reflect.deleteProperty(document, 'hidden'); });

  await page.evaluate(() => {
    const badge = document.querySelector<HTMLElement>('#save-state')!;
    const marks: Record<string, number> = { started: performance.now() };
    const observer = new MutationObserver(() => {
      const state = badge.dataset.state;
      if (state === 'local' && marks.local === undefined) marks.local = performance.now();
      if (state === 'synced' && marks.local !== undefined && marks.synced === undefined) marks.synced = performance.now();
    });
    observer.observe(badge, { attributes: true, attributeFilter: ['data-state'] });
    (window as typeof window & { __saveTiming?: unknown }).__saveTiming = { marks, observer };
  });
  const saveStarted = Date.now();
  const saveClickReturnedMs = await page.evaluate(() => {
    const started = performance.now();
    document.querySelector<HTMLButtonElement>('#save-now')!.click();
    return performance.now() - started;
  });
  await expect(page.locator('#toast')).toContainText('서버와 동기화했습니다.', { timeout: 60000 });
  await expect(page.locator('#save-state')).toContainText('서버 동기화 완료');
  const serverAckMs = Date.now() - saveStarted;
  const saveTiming = await page.evaluate(() => {
    const timing = (window as typeof window & { __saveTiming?: { marks: Record<string, number>; observer: MutationObserver } }).__saveTiming!;
    timing.observer.disconnect();
    return { localWriteMs: timing.marks.local - timing.marks.started, syncedMs: timing.marks.synced - timing.marks.started };
  });
  const remote = await page.evaluate(async () => {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' }).then(response => response.json());
    const response = await fetch('/api/saves/current', { credentials: 'same-origin', cache: 'no-store', headers: { 'x-choketmon-profile': me.user.id } });
    return { status: response.status, body: await response.json() };
  });
  expect(remote.status).toBe(200);
  expect(remote.body.revision).toBeGreaterThan(0);
  expect(remote.body.save.game.player.team[0].speciesId).toBe(155);
  expect(remote.body.save.game.adventureVersion).toBe('gold');
  expect(remote.body.save.view.openWorld.regionId).toBe('johto');
  const savedSeed = remote.body.save.game.seed;

  await page.locator('.logout-button').click();
  await expect(page.locator('[data-open-auth]')).toBeVisible({ timeout: 30000 });
  expect((await (await page.request.get('/api/auth/me')).json()).user).toBeNull();
  await page.reload();
  await expect(page.locator('[data-open-auth]')).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region', 'johto');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'true');
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.monster-card strong').first()).toContainText('브케인');

  await page.locator('[data-open-auth]').click();
  await page.locator('.account-dialog input[name="username"]').fill(username);
  await page.locator('.account-dialog input[name="password"]').fill(password);
  await page.locator('.account-submit').click();
  await expect(page.locator('.account-name')).toContainText(username, { timeout: 30000 });
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.monster-card strong').first()).toContainText('브케인');

  const cleanContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1100 } });
  try {
    const cleanPage = await cleanContext.newPage();
    cleanPage.on('pageerror', error => errors.push(error.message));
    await cleanPage.goto('/');
    await expect(cleanPage.locator('#starter-dialog')).toBeVisible();
    expect(await cleanPage.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'choketmon-neural-cache'))).toBe(false);
    await cleanPage.locator('[data-load-account]').click();
    await expect(cleanPage.locator('.account-dialog')).toBeVisible();
    await cleanPage.locator('.account-dialog input[name="username"]').fill(username);
    await cleanPage.locator('.account-dialog input[name="password"]').fill(password);
    const restoreStarted = Date.now();
    const restoreResponse = cleanPage.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/api/saves/current') && response.ok());
    await cleanPage.locator('.account-submit').click();
    await restoreResponse;
    const restoreResponseMs = Date.now() - restoreStarted;
    await expect(cleanPage.locator('.account-dialog')).toBeHidden();
    await expect(cleanPage.locator('#ow-host')).toHaveAttribute('data-region', 'johto', { timeout: 30000 });
    const restoreRenderedMs = Date.now() - restoreStarted;
    await expect(cleanPage.locator('#ow-host')).toHaveAttribute('data-paused', 'true');
    await expect(cleanPage.locator('#world-version')).toHaveCount(0);
    await cleanPage.locator('[data-tab="team"]').click();
    await expect(cleanPage.locator('.monster-card strong').first()).toContainText('브케인');
    const cleanRemote = await cleanPage.evaluate(async () => {
      const me = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' }).then(response => response.json());
      return fetch('/api/saves/current', { credentials: 'same-origin', cache: 'no-store', headers: { 'x-choketmon-profile': me.user.id } }).then(response => response.json());
    });
    expect(cleanRemote.save.game.seed).toBe(savedSeed);
    expect(cleanRemote.save.game.player.team[0].speciesId).toBe(155);
    expect(cleanRemote.save.view.openWorld.regionId).toBe('johto');
    const restored = await cleanPage.evaluate(profileId => new Promise<any>((resolve, reject) => {
      const request = indexedDB.open('choketmon-151', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('saves', 'readonly');
        const save = tx.objectStore('saves').get(`account:${profileId}:current`);
        tx.oncomplete = () => { resolve(save.result); db.close(); };
        tx.onerror = () => reject(tx.error);
      };
    }), (await (await cleanPage.request.get('/api/auth/me')).json()).user.id);
    expect(restored.game.seed).toBe(savedSeed);
    expect(restored.game.player.team[0].brain).toEqual(cleanRemote.save.game.player.team[0].brain);
    expect(restored.game.player.team[0].brain).toBeTruthy();
    expect(errors).toEqual([]);
    const output = process.env.CHOKETMON_AUTH_ARTIFACTS ?? 'artifacts/auth-live';
    mkdirSync(output, { recursive: true });
    writeFileSync(`${output}/fresh-context-restore.json`, JSON.stringify({
      saveClickReturnedMs, serverAckMs, ...saveTiming, restoreResponseMs, restoreRenderedMs,
      baseURL, checkedAt: new Date().toISOString(), revision: remote.body.revision, seed: savedSeed,
      speciesId: 155, version: 'gold', regionId: 'johto', freshBrowserContext: true,
      cookieCleared: true, guestReloadPreservesPause: true, restoredIndividualBrain: true, errors,
    }, null, 2));
  } finally { await cleanContext.close(); }
});
