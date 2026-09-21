import type { Page } from '@playwright/test';

export const QA_PROFILE = { id: 'fixture-authenticated-player', username: 'fixture_player' };
export async function mockAuthenticatedSession(page: Page) {
  let save: unknown, revision = 0;
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: QA_PROFILE } }));
  await page.route('**/api/auth/realtime-ticket', route => route.fulfill({ json: { ticket: 'fixture-ticket' } }));
  await page.route('**/api/saves/current', route => {
    if (route.request().method() === 'GET') return save
      ? route.fulfill({ json: { save, revision } }) : route.fulfill({ status: 404, json: {} });
    save = route.request().postDataJSON().save; revision++;
    return route.fulfill({ json: { revision } });
  });
}
