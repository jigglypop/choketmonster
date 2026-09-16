import { expect, test } from '@playwright/test';

test('a failed visible Pokemon model is stopped instead of moving as an empty placeholder', async ({ page }) => {
  test.setTimeout(90_000);
  let unavailable = true;
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route('**/models/opt/regular/152.glb', route => unavailable ? route.abort('failed') : route.continue());
  await page.goto('/?renderProbe=1');
  await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-renderer-ready', 'true', { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().modelStatuses ?? []), { timeout: 30_000 }).toContain('3D 불러오기 실패');
  const readCompanion = () => page.evaluate(() => (window as any).__renderProbe.read().creatures.find((item: any) => item.id.startsWith('companion:'))?.position);
  const before = await readCompanion();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'false');
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(1_200);
  await page.keyboard.up('ArrowUp');
  const after = await readCompanion();
  expect(before).toBeDefined();
  expect(after).toEqual(before);
  unavailable = false;
  await page.locator('#world-model-retry').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().loadedPokemon ?? [])).toContain(152);
  await expect(page.locator('#world-recovery')).toBeHidden();
});

test('slow model loading does not mark the world ready or move an invisible partner', async ({ page }) => {
  test.setTimeout(90_000);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route('**/models/opt/regular/152.glb', async route => { await gate; await route.continue(); });
  await page.goto('/?renderProbe=1');
  await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-renderer-ready', 'true', { timeout: 30_000 });
  const before = await page.locator('#world-position').innerText();
  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(1_000); await page.keyboard.up('ArrowUp');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'false');
  await expect(page.locator('#world-position')).toHaveText(before);
  release();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().loadedPokemon ?? [])).toContain(152);
});
