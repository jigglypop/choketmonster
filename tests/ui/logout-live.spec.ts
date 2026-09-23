import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { clickAccountMenu } from './helpers/account-menu';

test.skip(!process.env.CHOKETMON_LIVE_AUTH, 'Requires an explicitly selected Rust/PostgreSQL server.');
test.setTimeout(120000);
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test('real Rust logout clears the cookie and continues the saved adventure after reload', async ({ page, baseURL }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
  const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
  const username = `logout_${Date.now().toString(36)}`;
  const registered = await page.request.post('/api/auth/register', { headers: { origin: baseURL! }, data: { username, password: crypto.randomUUID() } });
  expect(registered.ok()).toBe(true);
  const { user } = await registered.json();
  const game = createGame(152, username);
  const world = new OpenWorldSimulation(graph, game, 35211, undefined, policy);
  world.setAutoHunt(false); world.setControlMode('manual');
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: false });
  const stored = await page.request.put('/api/saves/current', {
    headers: { origin: baseURL!, 'x-choketmon-profile': user.id },
    data: { save, revision: 0, requestId: crypto.randomUUID() },
  });
  expect(stored.ok()).toBe(true);
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => /\/152\.glb$/.test(route.request().url()) ? route.continue() : route.abort());
  await page.goto('/?renderProbe');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await expect(page.locator('.logout-button')).toBeEnabled();
  await clickAccountMenu(page, '.logout-button');
  await expect(page.locator('[data-open-auth]')).toBeEnabled({ timeout: 30000 });
  expect((await (await page.request.get('/api/auth/me')).json()).user).toBeNull();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'false');
  const tick = await page.locator('#ow-host').getAttribute('data-tick');
  await expect(page.locator('#ow-host')).not.toHaveAttribute('data-tick', tick!);
  await page.reload();
  await expect(page.locator('[data-open-auth]')).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  const restoredTick = await page.locator('#ow-host').getAttribute('data-tick');
  await expect(page.locator('#ow-host')).not.toHaveAttribute('data-tick', restoredTick!);
  expect((await (await page.request.get('/api/auth/me')).json()).user).toBeNull();
  await expect(page.locator('.world-summary-name')).toContainText('치코리타');
  expect(errors).toEqual([]);
  const output = process.env.CHOKETMON_LOGOUT_ARTIFACTS ?? 'artifacts/logout-restore/live';
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: `${output}/guest-after-reload.png` });
  writeFileSync(`${output}/result.json`, JSON.stringify({ baseURL, checkedAt: new Date().toISOString(), server: 'Rust/PostgreSQL', cookieCleared: true, guestTickAdvances: true, reloadTickAdvances: true, errors }, null, 2));
});
