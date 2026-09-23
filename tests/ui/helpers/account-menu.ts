import type { Page } from '@playwright/test';

/** Save and account controls live in the header account menu; open it before clicking one. */
export async function clickAccountMenu(page: Page, selector: string): Promise<void> {
  const menu = page.locator('.account-menu');
  if (await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click();
  await page.locator(selector).click();
}
