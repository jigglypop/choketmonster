import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

test.skip(!process.env.CHOKETMON_LIVE_AUTH, 'Requires the local Rust/PostgreSQL server.');

test('account save continues locally after logout and restores Johto from the server in a clean browser', async ({ page, browser }) => {
  test.setTimeout(240000);
  const username = `live_${Date.now().toString(36)}`, password = `Test-${crypto.randomUUID()}-pass`;
  await page.goto('/');
  await expect(page.locator('#starter-dialog')).toBeVisible();
  await page.locator('#starter-dialog [data-starter="1"]').click();
  await expect(page.locator('#starter-dialog')).toBeHidden();

  await page.locator('[data-open-auth]').click();
  await page.locator('.account-dialog input[name="username"]').fill(username);
  await page.locator('.account-dialog input[name="password"]').fill(password);
  await page.locator('.account-dialog button[value="register"]').click();
  await expect(page.locator('.account-name')).toContainText(username);
  await expect(page.locator('.account-dialog')).toBeHidden();
  await expect(page.locator('#starter-dialog')).toBeVisible();
  // Keep the world clock stopped while staging the save. Otherwise an automatic
  // encounter can legitimately lock region travel before Playwright reaches it.
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
  await page.locator('#starter-dialog [data-starter="4"]').click();
  await expect(page.locator('#starter-dialog')).toBeHidden();
  await page.locator('#world-pause').click();
  await expect(page.locator('#world-pause')).toContainText('계속 탐험');
  await expect(page.locator('#save-state')).toHaveAttribute('data-state', 'local', { timeout: 30000 });

  await page.locator('#world-map-open').click();
  await page.locator('#world-region').selectOption('johto');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region', 'johto');
  await page.locator('#world-map-close').click();
  await page.locator('#world-version').selectOption('gold');
  await expect(page.locator('#world-version')).toHaveValue('gold');
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
  expect(remote.body.save.game.player.team[0].speciesId).toBe(4);
  expect(remote.body.save.game.adventureVersion).toBe('gold');
  expect(remote.body.save.view.openWorld.regionId).toBe('johto');
  const savedSeed = remote.body.save.game.seed;

  await page.locator('.logout-button').click();
  await expect(page.locator('[data-open-auth]')).toBeVisible({ timeout: 30000 });
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.monster-card strong').first()).toContainText('파이리');

  await page.locator('[data-open-auth]').click();
  await page.locator('.account-dialog input[name="username"]').fill(username);
  await page.locator('.account-dialog input[name="password"]').fill(password);
  await page.locator('.account-dialog button[value="login"]').click();
  await expect(page.locator('.account-name')).toContainText(username, { timeout: 30000 });
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.monster-card strong').first()).toContainText('파이리');

  const cleanContext = await browser.newContext({ baseURL: process.env.CHOKETMON_BASE_URL ?? 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1100 } });
  try {
    const cleanPage = await cleanContext.newPage();
    await cleanPage.goto('/');
    await expect(cleanPage.locator('#starter-dialog')).toBeVisible();
    await cleanPage.locator('[data-load-account]').click();
    await expect(cleanPage.locator('.account-dialog')).toBeVisible();
    await cleanPage.locator('.account-dialog input[name="username"]').fill(username);
    await cleanPage.locator('.account-dialog input[name="password"]').fill(password);
    const restoreStarted = Date.now();
    const restoreResponse = cleanPage.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/api/saves/current') && response.ok());
    await cleanPage.locator('.account-dialog button[value="login"]').click();
    await restoreResponse;
    const restoreResponseMs = Date.now() - restoreStarted;
    await expect(cleanPage.locator('.account-dialog')).toBeHidden();
    await expect(cleanPage.locator('#ow-host')).toHaveAttribute('data-region', 'johto', { timeout: 30000 });
    const restoreRenderedMs = Date.now() - restoreStarted;
    await expect(cleanPage.locator('#world-version')).toHaveValue('gold');
    await cleanPage.locator('[data-tab="team"]').click();
    await expect(cleanPage.locator('.monster-card strong').first()).toContainText('파이리');
    const cleanRemote = await cleanPage.evaluate(async () => {
      const me = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' }).then(response => response.json());
      return fetch('/api/saves/current', { credentials: 'same-origin', cache: 'no-store', headers: { 'x-choketmon-profile': me.user.id } }).then(response => response.json());
    });
    expect(cleanRemote.save.game.seed).toBe(savedSeed);
    expect(cleanRemote.save.game.player.team[0].speciesId).toBe(4);
    expect(cleanRemote.save.view.openWorld.regionId).toBe('johto');
    const output = process.env.CHOKETMON_AUTH_ARTIFACTS ?? 'artifacts/auth-live';
    mkdirSync(output, { recursive: true });
    writeFileSync(`${output}/fresh-context-restore.json`, JSON.stringify({
      saveClickReturnedMs, serverAckMs, ...saveTiming, restoreResponseMs, restoreRenderedMs,
      revision: remote.body.revision, seed: savedSeed, speciesId: 4, version: 'gold', regionId: 'johto', indexedDbInitiallyEmpty: true,
    }, null, 2));
  } finally { await cleanContext.close(); }
});
