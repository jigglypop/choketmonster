import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test.skip(process.env.CHOKETMON_LIVE_RUST !== '1', 'Set CHOKETMON_LIVE_RUST=1 to use the live Rust API.');
test.setTimeout(150_000);
const evidenceStem = process.env.CHOKETMON_BASE_URL ? 'rust-production-ui' : 'rust-live-ui';

test('device save survives reload while anonymous full-connectome battle runs', async ({ page }) => {
  const traffic: Array<{ method: string; path: string; status: number }> = [];
  const decisions: Array<{ creatureId: string; action: number; updates: number; checkpoint: boolean }> = [];
  page.on('response', async response => {
    const url = new URL(response.url()); if (!url.pathname.startsWith('/api/')) return;
    traffic.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    if (url.pathname === '/api/local-brains/step-batch' && response.ok()) {
      const body = await response.json() as { decisions?: Array<{ creatureId: string; decision: { action: number; updates: number }; checkpoint?: unknown }> };
      for (const item of body.decisions ?? []) decisions.push({ creatureId: item.creatureId, action: item.decision.action, updates: item.decision.updates, checkpoint: item.checkpoint !== undefined });
    }
  });

  await page.goto('/');
  await expect(page.locator('[data-starter="1"]')).toBeVisible();
  await expect(page.locator('#account-dialog,[data-open-auth],#logout-button')).toHaveCount(0);
  await expect(page.locator('.device-storage')).toHaveText('이 기기에만 저장');
  await page.locator('[data-starter="1"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await page.locator('#world-learning').check();
  // Auto hunt starts on its own. Clicking Engage here races a turn that may
  // already have begun and can leave the test waiting on a disabled button.
  await page.locator('#world-auto-catch').check();
  await expect.poll(() => decisions.length, { timeout: 60_000, message: 'anonymous full-connectome battle decision' }).toBeGreaterThan(0);
  await expect.poll(() => Math.max(0, ...decisions.map(decision => decision.updates)), { timeout: 90_000, message: 'persisted learning updates' }).toBeGreaterThanOrEqual(2);
  await page.locator('#world-pause').click();
  await expect(page.locator('#world-pause')).toBeEnabled();

  const neuralSnapshot = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('choketmon-neural-cache', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<Array<{ key: string; lastRequestId: string; updates: number; history: number; checkpoint: boolean }>>((resolve, reject) => {
      const tx = db.transaction('brains', 'readonly'), store = tx.objectStore('brains'), keys = store.getAllKeys(), values = store.getAll();
      keys.onsuccess = () => {}; values.onsuccess = () => {};
      tx.oncomplete = () => resolve(keys.result.flatMap((key, index) => {
        const value = values.result[index] as { lastRequestId?: string; decision?: { updates?: number }; history?: unknown[]; checkpoint?: string };
        return typeof key === 'string' && value?.lastRequestId ? [{ key, lastRequestId: value.lastRequestId, updates: value.decision?.updates ?? -1, history: value.history?.length ?? -1, checkpoint: !!value.checkpoint }] : [];
      }));
      tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    db.close(); return rows.sort((a, b) => a.key.localeCompare(b.key));
  });
  const beforeReload = await neuralSnapshot();
  expect(beforeReload.length).toBeGreaterThan(0);
  expect(Math.max(...beforeReload.map(row => row.updates))).toBeGreaterThanOrEqual(2);

  await page.locator('#save-now').click();
  await expect(page.locator('#save-state')).toContainText('이 기기에 저장됨');
  await page.screenshot({ path: `artifacts/${evidenceStem}-desktop.png`, fullPage: true });
  await page.reload();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(page.locator('#world-pause')).toContainText('계속 탐험');
  const afterReload = await neuralSnapshot();
  expect(afterReload).toEqual(beforeReload);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `artifacts/${evidenceStem}-mobile.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('.detail-title h2')).toHaveText('이상해씨');
  await page.locator('[data-tab="lab"]').click();
  await expect(page.locator('.server-circuit')).toHaveAttribute('data-available', 'true');
  await page.screenshot({ path: `artifacts/${evidenceStem}-graph.png`, fullPage: true });

  const evidence = {
    schema: 2,
    suite: 'choketmon-device-save-live-ui',
    baseUrl: new URL(page.url()).origin,
    localSaveRestored: true,
    neuralState: { beforeReload, afterReload, exact: JSON.stringify(beforeReload) === JSON.stringify(afterReload) },
    server: { path: '/api/local-brains/step-batch', responses: decisions.length, decisions },
    traffic,
    forbiddenRequests: traffic.filter(item => item.path.startsWith('/api/auth/') || item.path.startsWith('/api/saves/')),
  };
  expect(evidence.forbiddenRequests).toEqual([]);
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(resolve(`artifacts/${evidenceStem}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  await test.info().attach('live-rust-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});
