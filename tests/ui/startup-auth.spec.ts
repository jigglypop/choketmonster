import { expect, test } from '@playwright/test';
import { mockAuthenticatedSession, QA_PROFILE } from './helpers/authenticated-session';
import { clickAccountMenu } from './helpers/account-menu';

test('requires login before loading the game, restores illustrated loading and returns to login after logout', async ({ page }, info) => {
  let authenticated = false;
  let releaseSession: () => void = () => {};
  const session = new Promise<void>(resolve => { releaseSession = resolve; });
  let release: () => void = () => {};
  const loading = new Promise<void>(resolve => { release = resolve; });
  await mockAuthenticatedSession(page);
  await page.route('**/api/auth/me', async route => { await session; return route.fulfill({ json: { user: authenticated ? QA_PROFILE : null } }); });
  await page.route('**/api/auth/login', route => {
    if (route.request().postDataJSON().password !== 'correct-password') return route.fulfill({ status: 401, json: { message: '아이디 또는 비밀번호가 올바르지 않습니다.' } });
    authenticated = true; return route.fulfill({ json: { user: QA_PROFILE } });
  });
  await page.route('**/api/auth/logout', route => { authenticated = false; return route.fulfill({ json: {} }); });
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/data/connectome.json', async route => { await loading; await route.continue(); });
  await page.goto('/');
  const form = page.locator('#startup-auth');
  await expect(form).toBeVisible();
  await expect(form.locator('[data-auth-mode="register"]')).toBeDisabled();
  releaseSession();
  await expect(form.locator('[type="submit"]')).toBeEnabled();
  await expect(form.locator('[data-auth-mode="register"]')).toBeEnabled();
  await expect(page.locator('#app')).toBeEmpty();
  await expect(page.locator('.adventure-loading__art')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('login-mobile.png'), fullPage: true });
  await form.locator('[name="username"]').fill(QA_PROFILE.username);
  await form.locator('[name="password"]').fill('wrong-password');
  await form.locator('[type="submit"]').click();
  await expect(form.locator('[data-auth-error]')).toContainText('올바르지 않습니다');
  await expect(page.locator('#app')).toBeEmpty();
  await form.locator('[name="password"]').fill('correct-password');
  await form.locator('[type="submit"]').click();
  try {
    await expect(form).toBeHidden();
    await expect(page.locator('#startup-loading [data-loading-stages]')).toBeVisible();
    await page.screenshot({ path: info.outputPath('loading-mobile.png'), fullPage: true });
  } finally { release(); }
  await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await expect(page.locator('.adventure-loading')).toHaveCount(0);
  await clickAccountMenu(page, '.logout-button');
  await expect(form).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#app')).toBeEmpty();
});

test('keeps the login screen when the account server is unavailable', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ status: 503, json: { message: '계정 서버에 연결하지 못했습니다.' } }));
  await page.goto('/');
  await expect(page.locator('#startup-auth [data-auth-error]')).toContainText('연결하지 못했습니다');
  await expect(page.locator('#startup-auth [type="submit"]')).toBeEnabled();
  await expect(page.locator('#app')).toBeEmpty();
  await expect(page.locator('[data-starter]')).toHaveCount(0);
});

test('pauses an expired session and resumes only after successful reauthentication', async ({ page }) => {
  let expired = false;
  await mockAuthenticatedSession(page);
  await page.route('**/api/saves/current', route => expired ? route.fulfill({ status: 401, json: { message: '로그인이 필요합니다.' } }) : route.fallback());
  await page.route('**/api/auth/login', route => { expired = false; return route.fulfill({ json: { user: QA_PROFILE } }); });
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.routeWebSocket('**', socket => socket.close());
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  expired = true; await clickAccountMenu(page, '#save-now');
  const dialog = page.locator('.account-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#screen')).toHaveJSProperty('inert', true);
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
  await dialog.locator('.account-close').click(); await expect(dialog).toBeVisible();
  await dialog.locator('[name="username"]').fill(QA_PROFILE.username);
  await dialog.locator('[name="password"]').fill('correct-password');
  await dialog.locator('[type="submit"]').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#screen')).toHaveJSProperty('inert', false);
  await expect(page.locator('#money')).toContainText('3,000');
});
