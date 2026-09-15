import { expect, test } from '@playwright/test';

test('계정 폼이 가입 조건과 기존 로그인 비밀번호를 구분해 안내한다', async ({ page }) => {
  const requests: Array<{ path: string; body: { username: string; password: string } }> = [];
  await page.route('**/api/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":null}' }));
  await page.route('**/api/auth/register', async route => {
    requests.push({ path: 'register', body: route.request().postDataJSON() });
    await route.fulfill({ status: 409, contentType: 'application/json', body: '{"message":"이미 사용 중인 아이디입니다."}' });
  });
  await page.route('**/api/auth/login', async route => {
    requests.push({ path: 'login', body: route.request().postDataJSON() });
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"아이디 또는 비밀번호가 올바르지 않습니다."}' });
  });

  await page.goto('/');
  await expect(page.locator('[data-open-auth]')).toBeEnabled({ timeout: 30_000 });
  await page.locator('[data-load-account]').click();
  const dialog = page.locator('.account-dialog');
  const password = dialog.locator('input[name="password"]');
  const confirmation = dialog.locator('input[name="passwordConfirmation"]');
  await expect(dialog.locator('.account-submit')).toHaveText('로그인');
  await expect(dialog.locator('.account-confirm')).toBeHidden();

  await dialog.locator('.account-mode button[value="register"]').click();
  await expect(dialog.locator('.account-submit')).toHaveText('회원가입');
  await expect(dialog.locator('.account-confirm')).toBeVisible();
  await dialog.locator('input[name="username"]').fill(' Valid_User ');

  await password.fill('가'.repeat(9));
  await confirmation.fill('가'.repeat(9));
  await dialog.locator('.account-submit').click();
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.locator('#account-password-error')).toContainText('10~128자');
  expect(requests).toHaveLength(0);

  await password.fill('😀'.repeat(10));
  await expect(password).not.toHaveAttribute('aria-invalid');
  await dialog.locator('.account-submit').click();
  await expect(confirmation).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.locator('#account-password-confirmation-error')).toContainText('일치하지 않습니다');
  await confirmation.fill('😀'.repeat(10));
  await expect(confirmation).not.toHaveAttribute('aria-invalid');
  await dialog.locator('.account-password-toggle').click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(confirmation).toHaveAttribute('type', 'text');
  await dialog.locator('.account-submit').click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(dialog.locator('.account-submit')).toBeEnabled();
  expect(requests[0]).toEqual({ path: 'register', body: { username: 'valid_user', password: '😀'.repeat(10) } });

  await dialog.locator('.account-mode button[value="register"]').click();
  await password.fill('가'.repeat(129));
  await confirmation.fill('가'.repeat(129));
  await dialog.locator('.account-submit').click();
  await expect(dialog.locator('#account-password-error')).toContainText('10~128자');
  await password.fill(' '.repeat(10));
  await confirmation.fill(' '.repeat(10));
  await dialog.locator('.account-submit').click();
  await expect(dialog.locator('#account-password-error')).toContainText('공백만');
  expect(requests).toHaveLength(1);

  await dialog.locator('.account-mode button[value="login"]').click();
  await expect(dialog.locator('.account-confirm')).toBeHidden();
  await password.fill('짧은암호');
  await dialog.locator('.account-submit').click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ path: 'login', body: { username: 'valid_user', password: '짧은암호' } });
  await expect(dialog.locator('.account-error')).toHaveText('아이디 또는 비밀번호가 올바르지 않습니다.');
});
