import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

test.skip(!process.env.CHOKETMON_LIVE_AUTH, 'Requires the local Rust/PostgreSQL server.');

test('profiles local and server checkpoint stages without the 3D renderer', async ({ page }) => {
  test.setTimeout(90000);
  const username = `save_profile_${Date.now().toString(36)}`, password = `Test-${crypto.randomUUID()}-pass`;
  await page.goto('/data/connectome.json');
  const metrics = await page.evaluate(async ({ username, password }) => {
    const enginePath = '/src/game/engine.ts', connectomePath = '/src/game/connectome.ts';
    const storagePath = '/src/game/storage.ts', simulationPath = '/src/openworld/simulation.ts';
    const [{ createGame }, { ConnectomeController }, storage, { OpenWorldSimulation }] = await Promise.all([
      import(/* @vite-ignore */ enginePath), import(/* @vite-ignore */ connectomePath),
      import(/* @vite-ignore */ storagePath), import(/* @vite-ignore */ simulationPath),
    ]);
    const graph = await fetch('/data/connectome.json').then(response => response.json());
    const game = createGame(4, `profile-${Date.now()}`); new ConnectomeController(graph).ensure(game.player.team[0]);
    const world = new OpenWorldSimulation(graph, game, 123456).snapshot();
    const save = storage.packSave(game, graph, { ...storage.defaultView(), openWorld: world, openWorldPaused: true });
    const stringifyStarted = performance.now(), serialized = JSON.stringify(save), stringifyMs = performance.now() - stringifyStarted;
    const cloneStarted = performance.now(); structuredClone(save); const structuredCloneMs = performance.now() - cloneStarted;

    const openStarted = performance.now();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('choketmon-151', 2);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('saves')) request.result.createObjectStore('saves'); if (!request.result.objectStoreNames.contains('server-sync')) request.result.createObjectStore('server-sync'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const databaseOpenMs = performance.now() - openStarted;
    const put = (key: string, value: unknown) => new Promise<{ requestSuccessMs: number; transactionCompleteMs: number }>((resolve, reject) => {
      const started = performance.now(), tx = db.transaction('saves', 'readwrite'), request = tx.objectStore('saves').put(value, key);
      let requestSuccessMs = 0;
      request.onsuccess = () => { requestSuccessMs = performance.now() - started; };
      tx.oncomplete = () => resolve({ requestSuccessMs, transactionCompleteMs: performance.now() - started });
      tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    const smallPut = await put('profile-small', { revision: 1, requestId: crypto.randomUUID(), localVersion: 1 });
    const largePut = await put('profile-large', save); db.close();

    const register = await fetch('/api/auth/register', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (!register.ok) throw new Error(`register failed: ${register.status}`);
    const user = (await register.json()).user;
    await storage.activateSaveProfile(user);

    const writeStarted = performance.now(); await storage.writeSave(save); const writeSaveMs = performance.now() - writeStarted;
    const originalFetch = window.fetch.bind(window), fetchTiming: { calledAt?: number; responseAt?: number; bodyBytes?: number } = {};
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT' && String(input).includes('/api/saves/current')) {
        fetchTiming.calledAt = performance.now(); fetchTiming.bodyBytes = typeof init.body === 'string' ? init.body.length : undefined;
        const response = await originalFetch(input, init); fetchTiming.responseAt = performance.now(); return response;
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const checkpointStarted = performance.now();
    const checkpoint = await storage.checkpointSave('manual');
    const checkpointComplete = performance.now(); window.fetch = originalFetch;
    return {
      payloadBytes: serialized.length, stringifyMs, structuredCloneMs, databaseOpenMs, smallPut, largePut, writeSaveMs,
      checkpointPrepareMs: fetchTiming.calledAt! - checkpointStarted,
      fetchResponseMs: fetchTiming.responseAt! - fetchTiming.calledAt!,
      checkpointFinalizeMs: checkpointComplete - fetchTiming.responseAt!,
      checkpointTotalMs: checkpointComplete - checkpointStarted,
      requestBodyBytes: fetchTiming.bodyBytes, revision: checkpoint.revision,
    };
  }, { username, password });
  expect(metrics.payloadBytes).toBeGreaterThan(900_000);
  expect(metrics.requestBodyBytes).toBeGreaterThan(metrics.payloadBytes);
  expect(metrics.revision).toBe(1);
  const output = process.env.CHOKETMON_SAVE_PROFILE_ARTIFACTS ?? 'artifacts/save-performance';
  mkdirSync(output, { recursive: true }); writeFileSync(`${output}/stages.json`, JSON.stringify(metrics, null, 2));
});
