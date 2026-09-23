import { expect, type Page } from '@playwright/test';

/** Selects a visible wild Pokémon by clicking its model under the nameplate. */
export async function selectVisibleWild(page: Page): Promise<void> {
  const labels = page.locator('#world-nameplates');
  const shown = await labels.getAttribute('aria-pressed') === 'true';
  if (!shown) await labels.click();
  const target = page.locator('#world-target');
  await expect.poll(async () => {
    const plates = await page.locator('.ow-creature-label[data-creature-id^="wild"]').all();
    for (const plate of plates) {
      const box = await plate.boundingBox(); if (!box) continue;
      for (const offset of [36, 60, 90, 120]) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height + offset);
        if (await target.isVisible()) return true;
      }
    }
    return false;
  }, { timeout: 20_000 }).toBe(true);
  if (!shown) await labels.click();
}
