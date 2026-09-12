import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGame } from '../src/game/engine';
import { defaultView, packSave } from '../src/game/storage';
import type { Graph } from '../src/core/brain';
import { SaveStore } from '../server/save-store';
import { createSaveApi } from '../server/save-api';
import graph from '../public/data/connectome.json';

const roots: string[] = []; const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => packSave(createGame(1, 42), graph as Graph, defaultView());
async function serve(store: SaveStore) {
  const api = createSaveApi(store), server = createServer((request, response) => { void api(request, response).then(handled => { if (!handled) response.writeHead(404).end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}/api/storage/v1/profiles/test_profile/saves/current`;
}

describe('local SQLite save API', () => {
  it('keeps a validated save after the database is closed and reopened', async () => {
    const root = mkdtempSync(join(tmpdir(), 'choketmon-save-')); roots.push(root); const path = join(root, 'save.sqlite');
    let store = new SaveStore(path), url = await serve(store); const save = fixture();
    const put = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ save, revision: 1, requestId: 'request_0001' }) });
    expect(put.status).toBe(200); await new Promise<void>(resolve => servers.pop()!.close(() => resolve())); store.close();
    store = new SaveStore(path); url = await serve(store); const loaded = await fetch(url).then(response => response.json());
    expect(loaded.save.game).toEqual(save.game); expect(loaded.revision).toBe(1); store.close();
  });

  it('preserves newer writes, backup slots, and idempotent retries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'choketmon-save-')); roots.push(root); const store = new SaveStore(join(root, 'save.sqlite')), current = fixture();
    store.put('test_profile', 'backup-before-new-game', current, 1, 'request_backup');
    const newer = structuredClone(current); newer.savedAt = '2026-09-12T01:00:00.000Z';
    store.put('test_profile', 'current', newer, 3, 'request_newer');
    store.put('test_profile', 'current', current, 2, 'request_stale');
    store.put('test_profile', 'current', current, 3, 'request_retry_same_revision');
    expect(store.get('test_profile', 'current')?.save).toEqual(newer);
    expect(store.get('test_profile', 'backup-before-new-game')?.save).toEqual(current); store.close();
  });

  it('returns clear errors for malformed saves and oversized bodies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'choketmon-save-')); roots.push(root); const store = new SaveStore(join(root, 'save.sqlite')), url = await serve(store);
    const invalid = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ save: {}, revision: 1, requestId: 'request_bad1' }) });
    expect(invalid.status).toBe(422); expect(await invalid.json()).toEqual({ error: 'invalid_save' });
    const oversized = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(20_000_001) }) });
    expect(oversized.status).toBe(413); store.close();
  });
});
