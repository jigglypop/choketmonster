import { test, expect } from '@playwright/test';

test('two tabs keep the newest device save without deleting legacy account records', async ({ page, context }) => {
  const saveRequests: string[] = [];
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/saves/')) saveRequests.push(request.url()); });
  await context.route('**/api/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: null }) }));
  const second = await context.newPage();
  await Promise.all([page.goto('/'), second.goto('/')]);

  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('choketmon-151', 2);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('saves')) request.result.createObjectStore('saves'); if (!request.result.objectStoreNames.contains('server-sync')) request.result.createObjectStore('server-sync'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('saves', 'readwrite');
      tx.objectStore('saves').put({ marker: 'legacy-account-copy' }, 'account:former-user:current');
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    db.close();
  });

  await page.evaluate(async () => {
    const modulePath = '/src/game/storage.ts', module = await import(/* @vite-ignore */ modulePath);
    await module.writeSave({ marker: 'tab-A' } as never);
  });
  await second.evaluate(async () => {
    const modulePath = '/src/game/storage.ts', module = await import(/* @vite-ignore */ modulePath);
    await module.writeSave({ marker: 'tab-B-newest' } as never);
  });

  const result = await page.evaluate(async () => {
    const modulePath = '/src/game/storage.ts', module = await import(/* @vite-ignore */ modulePath);
    const current = await module.readSave();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('choketmon-151', 2);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = db.transaction('saves', 'readonly').objectStore('saves').getAllKeys();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close(); return { current, keys };
  });

  expect(result.current).toEqual({ marker: 'tab-B-newest' });
  expect(result.keys).toContain('account:former-user:current');
  expect(saveRequests).toEqual([]);
});

test('a missing device slot copies the active legacy account save once without cloud save access', async ({ page }) => {
  let accountReads = 0; const saveRequests: string[] = [];
  page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/saves/')) saveRequests.push(path); });
  await page.route('**/api/auth/me', route => { accountReads++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 'legacy-user', username: 'unused' } }) }); });
  await page.goto('/data/source-manifest.json');
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('choketmon-151', 2);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('saves')) request.result.createObjectStore('saves'); if (!request.result.objectStoreNames.contains('server-sync')) request.result.createObjectStore('server-sync'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('saves', 'readwrite'); tx.objectStore('saves').put({ marker: 'legacy-local' }, 'account:legacy-user:current');
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    }); db.close();
  });
  const readsBeforeMigration = accountReads;
  const first = await page.evaluate(async () => {
    const modulePath = '/src/game/storage.ts', module = await import(/* @vite-ignore */ modulePath);
    return module.readSave();
  });
  const readsAfterMigration = accountReads;
  const second = await page.evaluate(async () => {
    const modulePath = '/src/game/storage.ts', module = await import(/* @vite-ignore */ modulePath);
    return module.readSave();
  });
  expect([first, second]).toEqual([{ marker: 'legacy-local' }, { marker: 'legacy-local' }]);
  expect(readsAfterMigration).toBeGreaterThan(readsBeforeMigration);
  expect(accountReads).toBe(readsAfterMigration);
  expect(saveRequests).toEqual([]);
});
