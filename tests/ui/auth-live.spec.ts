import { expect, test } from '@playwright/test';

test.skip(!process.env.CHOKETMON_LIVE_AUTH, 'Requires the local Rust/PostgreSQL server.');

test('account save continues locally after logout and survives login', async ({ page }) => {
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
  await expect(page.locator('#starter-dialog')).toBeVisible();
  await page.locator('#starter-dialog [data-starter="4"]').click();
  await expect(page.locator('#starter-dialog')).toBeHidden();

  await page.locator('#save-now').click();
  await expect(page.locator('#save-state')).toContainText('서버 동기화 완료');
  const remote = await page.evaluate(async () => {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' }).then(response => response.json());
    const response = await fetch('/api/saves/current', { credentials: 'same-origin', cache: 'no-store', headers: { 'x-choketmon-profile': me.user.id } });
    return { status: response.status, body: await response.json() };
  });
  expect(remote.status).toBe(200);
  expect(remote.body.revision).toBeGreaterThan(0);
  expect(remote.body.save.game.player.team[0].speciesId).toBe(4);

  await page.locator('.logout-button').click();
  await expect(page.locator('[data-open-auth]')).toBeVisible();
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.monster-card strong').first()).toContainText('파이리');

  await page.locator('[data-open-auth]').click();
  await page.locator('.account-dialog input[name="username"]').fill(username);
  await page.locator('.account-dialog input[name="password"]').fill(password);
  await page.locator('.account-dialog button[value="login"]').click();
  await expect(page.locator('.account-name')).toContainText(username);
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.monster-card strong').first()).toContainText('파이리');
});
