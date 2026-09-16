import { expect, test, type Page } from '@playwright/test';

async function choose(page: Page, turn: number, terminal = false) {
  return page.evaluate(async ({ turn, terminal }) => {
    const path = '/src/game/server-brain.ts';
    const brain = await import(/* @vite-ignore */ path);
    await brain.initializeServerBrain(); brain.setServerBrainScope('cache-recovery-fixture');
    const self = { instanceId: 'kept-brain', speciesId: 1, level: 5, hp: 20, stats: { hp: 20, speed: 10 }, moves: [{ moveId: 33, pp: 35 }] };
    return brain.chooseServerBrains({ observe: () => Array(12).fill(.1) }, [{ self, foe: { ...self, instanceId: 'foe' }, turn, reward: null, learning: false, battleId: 'same-battle', terminal }]);
  }, { turn, terminal });
}

test('cold cache restores the saved checkpoint and 428 retries preserve replay history', async ({ page }) => {
  await page.route('**/neural-cache-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: true, graphId: 'checkpoint-fixture' } }));
  const batches: Array<{ steps: Array<{ creatureId: string; requestId: string; checkpoint?: string; history: unknown[] }> }> = [];
  await page.route('**/api/local-brains/step-batch', route => {
    const body = route.request().postDataJSON() as typeof batches[number]; batches.push(body);
    if (batches.length === 3) return route.fulfill({ status: 428, json: { message: 'cache evicted' } });
    return route.fulfill({ json: { decisions: body.steps.map(step => ({ creatureId: step.creatureId, requestId: step.requestId,
      decision: { action: 0, updates: 12, activity: .2, elapsedMs: 1, graphId: 'checkpoint-fixture', nodes: 128, edges: 512 },
      ...(batches.length === 1 ? { checkpoint: 'durable-learned-memory' } : {}),
    })) } });
  });
  await page.goto('/neural-cache-fixture');
  await choose(page, 0, true);
  await page.reload();
  await choose(page, 1);
  expect(batches[1].steps[0].checkpoint).toBe('durable-learned-memory');
  await choose(page, 2);
  expect(batches).toHaveLength(4);
  expect(batches[2].steps[0].checkpoint).toBeUndefined();
  expect(batches[3].steps[0]).toEqual({ ...batches[2].steps[0], checkpoint: 'durable-learned-memory' });
  expect(batches[3].steps[0].history).toHaveLength(1);

  const retained = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('choketmon-neural-cache', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return new Promise<{ checkpoint: string; history: unknown[] }>((resolve, reject) => {
      const tx = db.transaction('brains', 'readwrite'), store = tx.objectStore('brains'), keys = store.getAllKeys();
      let saved: { checkpoint: string; checkpointId?: string; history: unknown[] };
      keys.onsuccess = () => {
        const key = keys.result.find(key => String(key).endsWith(':kept-brain'))!;
        const request = store.get(key);
        request.onsuccess = () => { saved = request.result; delete saved.checkpointId; store.put(saved, key); };
      };
      tx.oncomplete = () => { db.close(); resolve(saved); }; tx.onerror = () => reject(tx.error);
    });
  });
  await expect(choose(page, 3)).rejects.toThrow('기존 기억을 보존');
  expect(batches).toHaveLength(4);
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('choketmon-neural-cache', 1); request.onsuccess = () => resolve(request.result); });
    return new Promise(resolve => { const tx = db.transaction('brains', 'readonly'), request = tx.objectStore('brains').getAll(); tx.oncomplete = () => { db.close(); resolve(request.result.find(value => typeof value === 'object' && value.checkpoint)); }; });
  });
  expect(stored).toEqual(retained);
});
