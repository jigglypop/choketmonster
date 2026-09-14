import { expect, type Page } from '@playwright/test';

/** Opens the real disclosure control only when the exploration panel is closed. */
export async function openExplorePanel(page: Page): Promise<void> {
  const panel = page.locator('.world-explore-panel');
  await expect(panel).toBeAttached();
  if (await panel.getAttribute('open') === null) {
    await panel.locator(':scope > .world-explore-toggle').click();
  }
  await expect(panel).toHaveAttribute('open', '');
}

