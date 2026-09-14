import { expect, test } from '@playwright/test';
import { openExplorePanel } from './helpers/explore-panel';
test.setTimeout(90_000);

test('default nameplates, left-drag orbit and wheel work without a camera-reset control', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('choketmon-audio-v1', JSON.stringify({ muted: true })));
  await page.goto('/?renderProbe');
  await page.locator('[data-starter="152"]').click();
  await page.keyboard.press('Space');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'true');
  await openExplorePanel(page);
  await page.locator('#world-mode-manual').click();
  await page.locator('#world-auto-hunt').uncheck();
  await page.locator('.world-explore-toggle').click();
  await expect(page.locator('#world-nameplates')).toHaveAttribute('aria-pressed', 'true');
  const pose = () => page.evaluate(() => {
    const probe = (window as unknown as { __renderProbe?: { read(): { camera: number[]; nameplates: number } } }).__renderProbe;
    return probe?.read() ?? { camera: [0, 0, 0], nameplates: 0 };
  });
  await expect.poll(async () => (await pose()).nameplates, { timeout: 30_000 }).toBeGreaterThan(0);
  const initial = (await pose()).camera;
  const canvas = (await page.locator('#ow-host canvas').boundingBox())!;
  const x = canvas.x + canvas.width * .55, y = canvas.y + canvas.height * .55;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 150, y - 45, { steps: 12 }); await page.mouse.up();
  const distance = (a: number[], b: number[]) => Math.hypot(...a.map((n, i) => n - b[i]));
  await expect.poll(async () => distance((await pose()).camera, initial)).toBeGreaterThan(1);
  // Drain OrbitControls damping before checking that Shift has no camera action.
  await page.waitForTimeout(1800);
  const rotated = (await pose()).camera;
  await page.keyboard.press('Shift');
  await page.waitForTimeout(400);
  expect(distance((await pose()).camera, rotated)).toBeLessThan(.25);
  await page.mouse.wheel(0, -350);
  await expect.poll(async () => distance((await pose()).camera, rotated)).toBeGreaterThan(.5);
  await expect(page.getByRole('button', { name: '시점 초기화' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '시점 초기화' })).toHaveCount(0);
  await expect(page.locator('#world-nameplates')).toBeVisible();
});

