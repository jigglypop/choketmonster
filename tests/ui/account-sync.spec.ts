import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import type { Graph } from '../../src/core/brain';
const graph = JSON.parse(readFileSync(new URL('../../public/data/connectome.json', import.meta.url), 'utf8')) as Graph;

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

test('a clean local clock skew never replaces a newer server revision', async ({ page }) => {
  let reads = 0; const puts: unknown[] = [];
  await page.route('**/api/saves/current', route => {
    if (route.request().method() !== 'GET') { puts.push(route.request().postDataJSON()); return route.fulfill({ json: { revision: 4 } }); }
    reads++;
    return route.fulfill({ json: { revision: reads === 1 ? 2 : 3, save: save(reads === 1 ? 'server-base' : 'server-newer', `202${reads}-01-01T00:00:00.000Z`) } });
  });
  await page.goto('/data/connectome.json');
  const result = await page.evaluate(async clockAhead => {
    const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath);
    const profile = { id: 'clean-clock-skew' };
    await storage.activateSaveProfile(profile);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('choketmon-151', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('saves', 'readwrite'); tx.objectStore('saves').put(clockAhead, `account:${profile.id}:current`); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    await storage.activateSaveProfile(null);
    const loaded = await storage.activateSaveProfile(profile);
    return { loaded, local: await storage.readSave(), status: storage.getSaveStorageStatus() };
  }, save('clock-ahead-clean-local', '2099-01-01T00:00:00.000Z'));
  expect((result.loaded as { game: { marker: string } }).game.marker).toBe('server-newer');
  expect((result.local as { game: { marker: string } }).game.marker).toBe('server-newer');
  expect(result.status).toMatchObject({ state: 'synced', profileId: 'clean-clock-skew' });
  expect(puts).toEqual([]);
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
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('choketmon-151', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const sync = await new Promise<any>((resolve, reject) => { const tx = db.transaction('server-sync', 'readonly'), request = tx.objectStore('server-sync').get('account:retry-user:current'); tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); }); db.close();
    await storage.checkpointSave('manual'); return { failed, outboxHasSave: Object.hasOwn(sync.outbox, 'save') };
  }, save('retry'));
  expect(result.failed).toBe(true);
  expect(result.outboxHasSave).toBe(false);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).toBe(requestIds[0]);
});

test('a 409 keeps both snapshots and waits for an explicit server-save choice', async ({ page }) => {
  let reads = 0; const puts: Array<{ save: { game: { marker: string } }; revision: number }> = [];
  await page.route('**/api/auth/me', route => route.fulfill({ status: 200, json: { user: { id: 'conflict-server-choice', username: 'recovery-test' } } }));
  await page.route('**/api/saves/current', route => {
    if (route.request().method() === 'GET') {
      reads++;
      return reads === 1 ? route.fulfill({ status: 404, json: {} }) : route.fulfill({ json: { revision: 7, save: save('server-newer', '2030-01-01T00:00:00.000Z') } });
    }
    puts.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { message: 'conflict' } });
  });
  await page.goto('/data/connectome.json');
  const beforeChoice = await page.evaluate(async payload => {
    const modulePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ modulePath);
    await storage.activateSaveProfile({ id: 'conflict-server-choice' }); await storage.writeSave(payload as never);
    try { await storage.checkpointSave('manual'); } catch { /* Expected choice gate. */ }
    try { await storage.checkpointSave('auto'); } catch { /* It must remain gated. */ }
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('choketmon-151', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const keys = await new Promise<string[]>((resolve, reject) => { const tx = db.transaction('saves', 'readonly'), request = tx.objectStore('saves').getAllKeys(); tx.oncomplete = () => resolve(request.result.map(String)); tx.onerror = () => reject(tx.error); }); db.close();
    document.body.innerHTML = '<main id="account-host"></main>';
    const panelPath = '/src/game/account-panel.ts', panelModule = await import(/* @vite-ignore */ panelPath);
    const recovered: unknown[] = [];
    const panel = panelModule.mountAccountPanel({ container: document.querySelector<HTMLElement>('#account-host')!, checkpointIntervalMs: 600_000, afterSwitch: (change: { reason: string; save?: unknown }) => { if (change.reason === 'recovery') recovered.push(change.save); } });
    await panel.ready;
    (window as typeof window & { recoveryPanel?: typeof panel; recovered?: unknown[] }).recoveryPanel = panel;
    (window as typeof window & { recovered?: unknown[] }).recovered = recovered;
    return { status: storage.getSaveStorageStatus(), keys };
  }, save('device-local', '2029-01-01T00:00:00.000Z'));
  expect(beforeChoice.status).toMatchObject({ state: 'conflict', conflict: { serverRevision: 7 } });
  expect(beforeChoice.keys.some(key => key.includes('backup-conflict-device-'))).toBe(true);
  expect(beforeChoice.keys.some(key => key.includes('backup-conflict-server-'))).toBe(true);
  expect(puts).toHaveLength(1);
  await expect(page.locator('.save-recovery-dialog')).toBeVisible();
  await page.locator('.save-recovery-dialog button[value="server"]').click();
  await expect(page.locator('.save-recovery-dialog')).toBeHidden();
  const result = await page.evaluate(async () => {
    const storagePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ storagePath);
    return { local: await storage.readSave(), status: storage.getSaveStorageStatus(), recovered: (window as typeof window & { recovered?: unknown[] }).recovered };
  });
  expect((result.local as { game: { marker: string } }).game.marker).toBe('server-newer');
  expect((result.recovered?.[0] as { game: { marker: string } }).game.marker).toBe('server-newer');
  expect(result.status).toMatchObject({ state: 'synced', profileId: 'conflict-server-choice' });
  expect(puts).toHaveLength(1);
});

test('choosing the device snapshot uploads it once with the acknowledged server revision', async ({ page }) => {
  let reads = 0; const puts: Array<{ save: { game: { marker: string } }; revision: number }> = [];
  await page.route('**/api/saves/current', route => {
    if (route.request().method() === 'GET') {
      reads++;
      return reads === 1 ? route.fulfill({ status: 404, json: {} }) : route.fulfill({ json: { revision: 4, save: save('server') } });
    }
    const body = route.request().postDataJSON() as typeof puts[number]; puts.push(body);
    return puts.length === 1 ? route.fulfill({ status: 409, json: { message: 'conflict' } }) : route.fulfill({ json: { revision: 5 } });
  });
  await page.goto('/data/connectome.json');
  const result = await page.evaluate(async payload => {
    const storagePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ storagePath);
    await storage.activateSaveProfile({ id: 'conflict-device-choice' }); await storage.writeSave(payload as never);
    try { await storage.checkpointSave('manual'); } catch { /* Expected choice gate. */ }
    const selected = await storage.resolveSaveConflict('device');
    return { selected, local: await storage.readSave(), status: storage.getSaveStorageStatus() };
  }, save('device'));
  expect(puts.map(body => body.save.game.marker)).toEqual(['device', 'device']);
  expect(puts[1].revision).toBe(4);
  expect((result.selected as { game: { marker: string } }).game.marker).toBe('device');
  expect((result.local as { game: { marker: string } }).game.marker).toBe('device');
  expect(result.status).toMatchObject({ state: 'synced', profileId: 'conflict-device-choice' });
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
  await page.locator('.account-submit').click();
  await expect(page.locator('.account-name')).toContainText('trainer');
  await expect(page.locator('.account-dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { accountEvents?: string[] }).accountEvents)).toContain('after-login');
  await page.locator('.logout-button').click();
  await expect(page.locator('[data-open-auth]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { accountEvents?: string[] }).accountEvents)).toContain('after-logout');
  expect(requests).toEqual(['login', 'logout']);
  expect(await page.evaluate(() => (window as typeof window & { accountEvents?: string[] }).accountEvents)).toEqual(['after-initialize', 'before-login', 'after-login', 'before-logout', 'after-logout']);
});

test('same-account re-login authenticates before checkpoint and preserves the device outbox', async ({ page }) => {
  const profile = { id: 'expired-session-user', username: 'trainer' }, order: string[] = [];
  let authenticated = false;
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: profile } }));
  await page.route('**/api/auth/login', route => {
    order.push('login'); authenticated = true;
    return route.fulfill({ json: { user: profile } });
  });
  await page.route('**/api/saves/current', route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404, json: {} });
    order.push('checkpoint');
    return authenticated
      ? route.fulfill({ json: { revision: 1 } })
      : route.fulfill({ status: 401, json: { message: 'session expired' } });
  });
  await page.goto('/data/connectome.json');
  await page.evaluate(async payload => {
    document.body.innerHTML = '<main id="account-host"></main>';
    const panelPath = '/src/game/account-panel.ts', storagePath = '/src/game/storage.ts';
    const panelModule = await import(/* @vite-ignore */ panelPath), storage = await import(/* @vite-ignore */ storagePath);
    const panel = panelModule.mountAccountPanel({
      container: document.querySelector<HTMLElement>('#account-host')!, checkpointIntervalMs: 600_000,
      beforeSwitch: async (change: { reason: string }) => { if (change.reason === 'login') await storage.writeSave(payload as never); },
    });
    (window as typeof window & { accountPanel?: typeof panel }).accountPanel = panel;
    await panel.ready;
    panel.open();
  }, save('preserved-after-expiry'));
  await page.locator('.account-dialog input[name="username"]').fill('TRAINER');
  await page.locator('.account-dialog input[name="password"]').fill('correct-password');
  await page.locator('.account-submit').click();
  await expect(page.locator('.account-dialog')).toBeHidden();
  await expect(page.locator('.account-name')).toContainText('trainer');
  const preserved = await page.evaluate(async () => {
    const storagePath = '/src/game/storage.ts', storage = await import(/* @vite-ignore */ storagePath);
    const current = await storage.readSave() as { game: { marker: string } };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('choketmon-151', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const sync = await new Promise<{ dirty: boolean }>((resolve, reject) => { const tx = db.transaction('server-sync', 'readonly'), request = tx.objectStore('server-sync').get('account:expired-session-user:current'); tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); });
    db.close();
    return { marker: current.game.marker, dirty: sync.dirty };
  });
  expect(order[0]).toBe('login');
  expect(preserved.marker).toBe('preserved-after-expiry');
  expect(typeof preserved.dirty).toBe('boolean');
});

test('an account-status outage does not silently open the guest save namespace', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ status: 503, json: { message: 'maintenance' } }));
  await page.goto('/data/connectome.json');
  const result = await page.evaluate(async () => {
    document.body.innerHTML = '<main id="account-host"></main>';
    const panelPath = '/src/game/account-panel.ts', storagePath = '/src/game/storage.ts';
    const panelModule = await import(/* @vite-ignore */ panelPath);
    const storage = await import(/* @vite-ignore */ storagePath);
    const panel = panelModule.mountAccountPanel({ container: document.querySelector<HTMLElement>('#account-host')!, checkpointIntervalMs: 600_000 });
    let rejected = false; try { await panel.ready; } catch { rejected = true; }
    return { rejected, profile: storage.currentSaveProfile(), error: document.querySelector<HTMLElement>('.account-error')?.textContent };
  });
  expect(result).toEqual({ rejected: true, profile: null, error: 'maintenance' });
});

test('the running game pauses on login conflict and applies the selected server snapshot', async ({ page }) => {
  const profile = { id: 'main-recovery-user', username: 'recovery' };
  const localGame = createGame(1, 'main-recovery-local'), remoteGame = createGame(1, 'main-recovery-server');
  localGame.player.money = 1111; remoteGame.player.money = 2222;
  const local = packSave(localGame, graph, defaultView()), remote = packSave(remoteGame, graph, defaultView());
  local.savedAt = '2029-01-01T00:00:00.000Z'; remote.savedAt = '2030-01-01T00:00:00.000Z';
  await page.addInitScript(({ profileId, localSave }) => new Promise<void>((resolve, reject) => {
    if (sessionStorage.getItem('main-recovery-seeded')) { resolve(); return; }
    sessionStorage.setItem('main-recovery-seeded', '1');
    const request = indexedDB.open('choketmon-151', 2);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('saves')) request.result.createObjectStore('saves'); if (!request.result.objectStoreNames.contains('server-sync')) request.result.createObjectStore('server-sync'); };
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['saves', 'server-sync'], 'readwrite');
      tx.objectStore('saves').put(localSave, `account:${profileId}:current`);
      tx.objectStore('server-sync').put({ profileId, serverRevision: 1, localVersion: 2, dirty: true }, `account:${profileId}:current`);
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  }), { profileId: profile.id, localSave: local });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: profile } }));
  await page.route('**/api/saves/current', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { save: remote, revision: 3 } })
    : route.fulfill({ status: 500, json: { message: 'unexpected upload' } }));
  await page.goto('/');
  await expect(page.locator('.save-recovery-dialog')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#save-state')).toContainText('저장 선택 필요');
  await expect(page.locator('#money')).toContainText('1,111');
  await page.locator('.save-recovery-dialog button[value="server"]').click();
  await expect(page.locator('.save-recovery-dialog')).toBeHidden();
  await expect(page.locator('#money')).toContainText('2,222');
  await expect(page.locator('#save-state')).toContainText('서버 동기화 완료');
  const storedBeforeReload = await page.evaluate(async profileId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('choketmon-151', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return new Promise<number>((resolve, reject) => { const tx = db.transaction('saves', 'readonly'), request = tx.objectStore('saves').get(`account:${profileId}:current`); tx.oncomplete = () => { const money = request.result.game.player.money; db.close(); resolve(money); }; tx.onerror = () => reject(tx.error); });
  }, profile.id);
  expect(storedBeforeReload).toBe(2222);
  await page.reload();
  await expect(page.locator('#money')).toContainText('2,222', { timeout: 30_000 });
});

test('login conflict never captures the previous guest adventure into the account slot', async ({ page }) => {
  const profile = { id: 'login-divergence-user', username: 'divergence' };
  const guestGame = createGame(1, 'guest-before-login'), localGame = createGame(4, 'account-device'), remoteGame = createGame(7, 'account-server');
  guestGame.player.money = 3333; localGame.player.money = 1111; remoteGame.player.money = 2222;
  const guest = packSave(guestGame, graph, defaultView()), local = packSave(localGame, graph, defaultView()), remote = packSave(remoteGame, graph, defaultView());
  local.savedAt = '2029-01-01T00:00:00.000Z'; remote.savedAt = '2030-01-01T00:00:00.000Z';
  await page.addInitScript(({ profileId, guestSave, localSave }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('choketmon-151', 2);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('saves')) request.result.createObjectStore('saves'); if (!request.result.objectStoreNames.contains('server-sync')) request.result.createObjectStore('server-sync'); };
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['saves', 'server-sync'], 'readwrite');
      tx.objectStore('saves').put(guestSave, 'current');
      tx.objectStore('saves').put(localSave, `account:${profileId}:current`);
      tx.objectStore('server-sync').put({ profileId, serverRevision: 1, localVersion: 2, dirty: true }, `account:${profileId}:current`);
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  }), { profileId: profile.id, guestSave: guest, localSave: local });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/auth/login', route => route.fulfill({ json: { user: profile } }));
  await page.route('**/api/saves/current', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { save: remote, revision: 3 } })
    : route.fulfill({ status: 500, json: { message: 'unexpected upload' } }));
  await page.goto('/');
  await expect(page.locator('#money')).toContainText('3,333', { timeout: 30_000 });
  await page.locator('[data-open-auth]').click();
  await page.locator('.account-dialog input[name="username"]').fill(profile.username);
  await page.locator('.account-dialog input[name="password"]').fill('correct-password');
  await page.locator('.account-submit').click();
  await expect(page.locator('.save-recovery-dialog')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#money')).toContainText('1,111');
  const accountSnapshots = await page.evaluate(async profileId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('choketmon-151', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return new Promise<Array<{ key: string; money: number }>>((resolve, reject) => {
      const tx = db.transaction('saves', 'readonly'), store = tx.objectStore('saves'), keys = store.getAllKeys(), values = store.getAll();
      tx.oncomplete = () => { const rows = keys.result.map((key, index) => ({ key: String(key), money: values.result[index]?.game?.player?.money })).filter(row => row.key.startsWith(`account:${profileId}:`)); db.close(); resolve(rows); }; tx.onerror = () => reject(tx.error);
    });
  }, profile.id);
  expect(accountSnapshots.find(row => row.key === `account:${profile.id}:current`)?.money).toBe(1111);
  expect(accountSnapshots.some(row => row.key.includes('backup-conflict-device-') && row.money === 1111)).toBe(true);
  expect(accountSnapshots.every(row => row.money !== 3333)).toBe(true);
});
