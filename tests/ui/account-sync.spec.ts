import { expect, test } from '@playwright/test';

const save = (marker: string, savedAt = new Date().toISOString()) => ({ format: 'choketmon', version: 2, model: 'pokemon-recurrent-v1', savedAt, graph: {}, game: { marker }, view: {} });

test('logout handoff rolls back a failed device write and includes the latest queued account save on retry', async ({ page }) => {
  await page.route('**/api/saves/current', route => route.fulfill({ status: 404, json: {} }));
  await page.goto('/data/connectome.json');
  const result = await page.evaluate(async payload => {
    const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath);
    await storage.writeSave(payload.guest);
    await storage.activateSaveProfile({ id: 'handoff-user' }); await storage.writeSave(payload.account);
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      const request = originalPut.apply(this, args);
      if (this.name === 'saves' && args[1] === 'current') this.transaction.abort();
      return request;
    };
    let failed = false;
    try { await storage.activateSaveProfile(null, { continueLocally: true }); } catch { failed = true; }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const profileAfterFailure = storage.currentSaveProfile();
    await storage.activateSaveProfile(null); const guestAfterFailure = await storage.readSave();
    await storage.activateSaveProfile({ id: 'handoff-user' });
    const queuedWrite = storage.writeSave(payload.latest);
    const restored = await storage.activateSaveProfile(null, { continueLocally: true }); await queuedWrite;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('choketmon-151', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const entries = await new Promise<Record<string, any>>((resolve, reject) => {
      const tx = db.transaction('saves', 'readonly'), store = tx.objectStore('saves'), keys = store.getAllKeys(), values = store.getAll();
      tx.oncomplete = () => resolve(Object.fromEntries(keys.result.map((key, i) => [String(key), values.result[i]]))); tx.onerror = () => reject(tx.error);
    }); db.close();
    return { failed, profileAfterFailure, guestAfterFailure, restored, entries };
  }, { guest: save('guest'), account: save('account'), latest: save('latest') });
  expect(result.failed).toBe(true);
  expect(result.profileAfterFailure?.id).toBe('handoff-user');
  expect(result.guestAfterFailure.game.marker).toBe('guest');
  expect(result.restored.game.marker).toBe('latest');
  expect(result.entries['account:handoff-user:current'].game.marker).toBe('latest');
  const backups = Object.entries(result.entries).filter(([key]) => key.startsWith('backup-before-logout-'));
  expect(backups).toHaveLength(1); expect(backups[0][1].game.marker).toBe('guest');
});

test('account writes stay in IndexedDB until an explicit checkpoint and never use the guest slot', async ({ page }) => {
  const puts: unknown[] = [];
  await page.route('**/api/saves/current', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    puts.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: 1 }) });
  });
  await page.goto('/data/connectome.json');
  await page.evaluate(async payload => {
    const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath);
    await storage.activateSaveProfile({ id: 'account-a', username: 'red' });
    await storage.writeSave(payload as never);
  }, save('account-only'));
  expect(puts).toHaveLength(0);
  const result = await page.evaluate(async () => {
    const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath);
    const accountSave = await storage.readSave();
    await storage.activateSaveProfile(null);
    const guestSave = await storage.readSave();
    await storage.activateSaveProfile({ id: 'account-a', username: 'red' });
    await storage.checkpointSave('manual');
    return { accountSave, guestSave };
  });
  expect((result.accountSave as { game: { marker: string } }).game.marker).toBe('account-only');
  expect(result.guestSave).toBeUndefined();
  expect(puts).toHaveLength(1);
  expect((puts[0] as { save: { game: { marker: string } } }).save.game.marker).toBe('account-only');
});

test('a late checkpoint response cannot clear or overwrite a newer local save', async ({ page }) => {
  let releaseFirst!: () => void, firstArrived!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const arrived = new Promise<void>(resolve => { firstArrived = resolve; });
  const puts: Array<{ save: { game: { marker: string } }; revision: number; requestId: string }> = [];
  await page.route('**/api/saves/current', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    const body = route.request().postDataJSON() as typeof puts[number]; puts.push(body);
    if (puts.length === 1) { firstArrived(); await gate; }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: puts.length }) });
  });
  await page.goto('/data/connectome.json');
  await page.evaluate(async payload => {
    const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath);
    await storage.activateSaveProfile({ id: 'race-user' });
    await storage.writeSave(payload as never);
    (window as typeof window & { checkpoint?: Promise<unknown> }).checkpoint = storage.checkpointSave('manual');
  }, save('old'));
  await firstArrived;
  await page.evaluate(async payload => { const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath); await storage.writeSave(payload as never); }, save('new'));
  releaseFirst();
  await page.evaluate(async () => { await (window as typeof window & { checkpoint?: Promise<unknown> }).checkpoint; const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath); await storage.checkpointSave('auto'); });
  const local = await page.evaluate(async () => { const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath); return storage.readSave(); });
  expect(puts.map(body => body.save.game.marker)).toEqual(['old', 'new']);
  expect(puts[1].revision).toBe(1);
  expect((local as { game: { marker: string } }).game.marker).toBe('new');
});

test('failed checkpoints retry the same outbox request id', async ({ page }) => {
  const requestIds: string[] = []; let fail = true;
  await page.route('**/api/saves/current', route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    requestIds.push((route.request().postDataJSON() as { requestId: string }).requestId);
    if (fail) { fail = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'offline' }) }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: 1 }) });
  });
  await page.goto('/data/connectome.json');
  const result = await page.evaluate(async payload => {
    const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath);
    await storage.activateSaveProfile({ id: 'retry-user' }); await storage.writeSave(payload as never);
    let failed = false; try { await storage.checkpointSave('manual'); } catch { failed = true; }
    await storage.checkpointSave('manual'); return { failed };
  }, save('retry'));
  expect(result.failed).toBe(true);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).toBe(requestIds[0]);
});

test('login reconciliation rereads a local write that lands while the server response is pending', async ({ page }) => {
  let release!: () => void, arrived!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), requestArrived = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/saves/current', async route => {
    if (route.request().method() === 'GET') { arrived(); await gate; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: 5, save: save('remote', '2030-01-01T00:00:00.000Z') }) }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: 6 }) });
  });
  await page.goto('/data/connectome.json');
  await page.evaluate(() => {
    const modulePath = '/src/game/storage.ts';
    (window as typeof window & { activation?: Promise<unknown> }).activation = import(/* @vite-ignore */ modulePath).then(storage => storage.activateSaveProfile({ id: 'login-race' }));
  });
  await requestArrived;
  await page.evaluate(async payload => { const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath); await storage.writeSave(payload as never); }, save('local-during-fetch', '2025-01-01T00:00:00.000Z'));
  release();
  const result = await page.evaluate(async () => await (window as typeof window & { activation?: Promise<unknown> }).activation);
  expect((result as { game: { marker: string } }).game.marker).toBe('local-during-fetch');
});

test('an old profile request stops after a profile switch and carries the expected-profile header', async ({ page }) => {
  let release!: () => void, arrived!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), requestArrived = new Promise<void>(resolve => { arrived = resolve; });
  const putProfiles: string[] = [];
  await page.route('**/api/saves/current', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    putProfiles.push(route.request().headers()['x-choketmon-profile']);
    if (putProfiles.length === 1) { arrived(); await gate; }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: 1 }) });
  });
  await page.goto('/data/connectome.json');
  await page.evaluate(async payload => {
    const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath);
    await storage.activateSaveProfile({ id: 'profile-a' }); await storage.writeSave(payload as never);
    (window as typeof window & { oldCheckpoint?: Promise<unknown> }).oldCheckpoint = storage.checkpointSave('manual');
  }, save('profile-a'));
  await requestArrived;
  await page.evaluate(async () => { const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath); await storage.activateSaveProfile({ id: 'profile-b' }); });
  release();
  await page.evaluate(async () => await (window as typeof window & { oldCheckpoint?: Promise<unknown> }).oldCheckpoint);
  await page.evaluate(async payload => { const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath); await storage.writeSave(payload as never); await storage.checkpointSave('manual'); }, save('profile-b'));
  expect(putProfiles).toEqual(['profile-a', 'profile-b']);
});

test('login reconciliation returns the account-local save when its checkpoint is rejected', async ({ page }) => {
  await page.route('**/api/saves/current', route => route.request().method() === 'GET'
    ? route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
    : route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'save rejected' }) }));
  await page.goto('/data/connectome.json');
  const result = await page.evaluate(async payload => {
    const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath);
    await storage.activateSaveProfile({ id: 'sync-failure-user' });
    await storage.writeSave(payload as never);
    await storage.activateSaveProfile(null);
    let rejected = false, restored: unknown;
    try { restored = await storage.activateSaveProfile({ id: 'sync-failure-user' }); } catch { rejected = true; }
    return { rejected, restored, profile: storage.currentSaveProfile(), status: storage.getSaveStorageStatus() };
  }, save('safe-account-local'));
  expect(result.rejected).toBe(false);
  expect((result.restored as { game: { marker: string } }).game.marker).toBe('safe-account-local');
  expect(result.profile).toMatchObject({ id: 'sync-failure-user' });
  expect(result.status).toMatchObject({ state: 'error', profileId: 'sync-failure-user', message: 'save rejected' });
});

test('account panel serializes login and logout lifecycle callbacks', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: null }) }));
  await page.route('**/api/auth/login', route => { requests.push('login'); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 'ui-user-1', username: 'trainer' } }) }); });
  await page.route('**/api/auth/logout', route => { requests.push('logout'); return route.fulfill({ status: 204, body: '' }); });
  await page.route('**/api/saves/current', route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    throw new Error(`unexpected save request: ${route.request().method()}`);
  });
  await page.goto('/data/connectome.json');
  await page.evaluate(async () => {
    document.body.innerHTML = '<main id="account-host"></main>';
    const modulePath = '/src/game/account-panel.ts', panelModule = await import(/* @vite-ignore */ modulePath);
    const events: string[] = [];
    const panel = panelModule.mountAccountPanel({ container: document.querySelector<HTMLElement>('#account-host')!, checkpointIntervalMs: 600_000,
      beforeSwitch: (change: { reason: string }) => { events.push(`before-${change.reason}`); }, afterSwitch: (change: { reason: string }) => { events.push(`after-${change.reason}`); } });
    (window as typeof window & { accountPanel?: typeof panel }).accountPanel = panel;
    (window as typeof window & { accountEvents?: string[] }).accountEvents = events;
    await panel.ready;
  });
  await page.locator('[data-open-auth]').click();
  await page.locator('.account-dialog input[name="username"]').fill('trainer');
  await page.locator('.account-dialog input[name="password"]').fill('correct-password');
  await page.locator('.account-dialog button[value="login"]').click();
  await expect(page.locator('.account-name')).toContainText('trainer');
  await expect(page.locator('.account-dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { accountEvents?: string[] }).accountEvents)).toContain('after-login');
  await page.locator('.logout-button').click();
  await expect(page.locator('[data-open-auth]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { accountEvents?: string[] }).accountEvents)).toContain('after-logout');
  expect(requests).toEqual(['login', 'logout']);
  expect(await page.evaluate(() => (window as typeof window & { accountEvents?: string[] }).accountEvents)).toEqual(['after-initialize', 'before-login', 'after-login', 'before-logout', 'after-logout']);
});
