import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test.setTimeout(90_000);
for (const mobile of [false, true]) test(`notification appears above an open map ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.addInitScript(() => localStorage.setItem('choketmon-audio-v1', JSON.stringify({ muted: true })));
  await page.goto('/');
  await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await page.locator('#world-map-open').click();
  await expect(page.locator('#world-map-dialog')).toBeVisible();
  await page.locator('#import-file').setInputFiles({ name: 'invalid-save.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
  const toast = page.locator('#toast');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveClass(/error/);
  expect(await toast.evaluate(element => element.matches(':popover-open'))).toBe(true);
  const box = await toast.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y).toBeLessThan(20);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await toast.evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
  mkdirSync('artifacts/toast-visibility', { recursive: true });
  await page.screenshot({ path: `artifacts/toast-visibility/map-${mobile ? 'mobile' : 'desktop'}.png` });
  // The notification must not consume modal controls or steal keyboard focus.
  await page.keyboard.press('Escape');
  await expect(page.locator('#world-map-dialog')).not.toBeVisible();
});
