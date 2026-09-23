import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function beginAdventure(page: Page) {
  await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  await page.goto('/');
  await page.locator('[data-starter="1"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-renderer-ready', 'true', { timeout: 25_000 });
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test('mobile route guide stays compact beside the radar and reveals details on tap', async ({ page }) => {
  test.setTimeout(90_000);
  await mkdir('artifacts/ui-guide-compact-20260919', { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await beginAdventure(page);

  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const guide = page.locator('#world-next-guide'), radar = page.locator('.world-radar');
    await expect(guide).toBeVisible();
    await expect(guide.locator('.world-guide-detail')).toBeHidden();
    const compact = (await guide.boundingBox())!, radarBox = (await radar.boundingBox())!;
    expect(compact.height).toBeLessThanOrEqual(52);
    expect(overlaps(compact, radarBox)).toBe(false);
    expect(compact.x + compact.width).toBeLessThanOrEqual(radarBox.x - 8);
    await page.screenshot({ path: `artifacts/ui-guide-compact-20260919/guide-${width}-compact.png` });

    await guide.click();
    await expect(guide).toHaveAttribute('aria-expanded', 'true');
    await expect(guide.locator('.world-guide-detail')).toBeVisible();
    const expanded = (await guide.boundingBox())!;
    expect(expanded.height).toBeGreaterThan(compact.height);
    expect(overlaps(expanded, (await radar.boundingBox())!)).toBe(false);
    await page.screenshot({ path: `artifacts/ui-guide-compact-20260919/guide-${width}-expanded.png` });

    await guide.click();
    await expect(page.locator('#world-map-dialog')).toBeVisible();
    await page.locator('#world-map-close').click();
  }
});
