import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Graph } from '../src/core/brain';
import { createGame } from '../src/game/engine';

// A minimal in-memory IndexedDB: requests run in order, transactions run one at a time and roll back on abort.
type Row = Map<string, unknown>;
class FakeRequest {
  result: unknown; error: unknown = null; readyState: 'pending' | 'done' = 'pending';
  onsuccess: ((event: unknown) => void) | null = null; onerror: ((event: unknown) => void) | null = null;
  onupgradeneeded: ((event: unknown) => void) | null = null;
}
class FakeRange {
  constructor(readonly lower: string, readonly upper: string) {}
  includes(key: string) { return key >= this.lower && key <= this.upper; }
}
class FakeTransaction {
  private queue: { request: FakeRequest; run: () => unknown }[] = [];
  private finished = false;
  private restore = () => {};
  error: unknown = null;
  oncomplete: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
  constructor(private db: FakeDatabase, private names: string[]) {}
  objectStore(name: string) {
    if (!this.names.includes(name)) throw new Error(`NotFoundError: ${name}`);
    return new FakeStore(this, this.db.stores.get(name)!);
  }
  enqueue(run: () => unknown) {
    if (this.finished) throw new Error('TransactionInactiveError');
    const request = new FakeRequest(); this.queue.push({ request, run }); return request;
  }
  abort() {
    if (this.finished) throw new Error('InvalidStateError');
    this.finished = true; this.restore(); queueMicrotask(() => this.onabort?.());
  }
  async run() {
    const copies = this.names.map(name => [name, new Map(this.db.stores.get(name))] as const);
    this.restore = () => { for (const [name, copy] of copies) { const rows = this.db.stores.get(name)!; rows.clear(); for (const [key, value] of copy) rows.set(key, value); } };
    while (!this.finished && this.queue.length) {
      await Promise.resolve();
      const next = this.queue.shift()!;
      try {
        next.request.result = next.run(); next.request.readyState = 'done';
        next.request.onsuccess?.({ target: next.request });
      } catch (error) { if (!this.finished) { this.error = error; this.abort(); } }
    }
    if (!this.finished) { this.finished = true; await Promise.resolve(); this.oncomplete?.(); }
  }
}
class FakeStore {
  constructor(private tx: FakeTransaction, private rows: Row) {}
  private keys(range?: FakeRange) { return [...this.rows.keys()].filter(key => !range || range.includes(key)).sort(); }
  get(key: string) { return this.tx.enqueue(() => structuredClone(this.rows.get(key))); }
  put(value: unknown, key: string) { const copy = structuredClone(value); return this.tx.enqueue(() => { this.rows.set(key, copy); return key; }); }
  delete(key: string) { return this.tx.enqueue(() => { this.rows.delete(key); }); }
  getAllKeys(range?: FakeRange) { return this.tx.enqueue(() => this.keys(range)); }
  getAll(range?: FakeRange) { return this.tx.enqueue(() => this.keys(range).map(key => structuredClone(this.rows.get(key)))); }
}
class FakeDatabase {
  version = 0; stores = new Map<string, Row>(); onversionchange: (() => void) | null = null;
  private chain = Promise.resolve();
  objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string) { this.stores.set(name, new Map()); }
  transaction(names: string | string[], _mode?: string) {
    const tx = new FakeTransaction(this, Array.isArray(names) ? names : [names]);
    this.chain = this.chain.then(() => tx.run());
    return tx;
  }
  close() {}
}
function installFakeIndexedDb() {
  const databases = new Map<string, FakeDatabase>();
  vi.stubGlobal('IDBKeyRange', { bound: (lower: string, upper: string) => new FakeRange(lower, upper) });
  vi.stubGlobal('indexedDB', {
    open(name: string, version: number) {
      const request = new FakeRequest();
      setTimeout(() => {
        const db = databases.get(name) ?? new FakeDatabase(); databases.set(name, db);
        request.result = db;
        if (version > db.version) { const oldVersion = db.version; db.version = version; request.onupgradeneeded?.({ oldVersion, newVersion: version }); }
        request.readyState = 'done'; request.onsuccess?.({});
      });
      return request;
    },
  });
  return (name: string, store: string) => databases.get(name)?.stores.get(store) ?? new Map();
}

/** Web Locks shared by every "tab" (module instance) in one test; `unload` drops them as closing a page does. */
function installFakeLocks() {
  const held = new Set<string>();
  vi.stubGlobal('navigator', { locks: {
    async request(name: string, options: { ifAvailable?: boolean }, callback: (lock: object | null) => unknown) {
      if (held.has(name) && options.ifAvailable) return callback(null);
      held.add(name);
      try { return await callback({ name }); } finally { held.delete(name); }
    },
  } });
  return { unload: () => held.clear() };
}

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
type Storage = typeof import('../src/game/storage');
async function freshStorage(): Promise<Storage> { vi.resetModules(); return import('../src/game/storage'); }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** One account slot on a fake save server with request receipts, as the Rust API keeps them. */
function fakeSaveServer() {
  const server = { save: undefined as unknown, revision: 0, receipts: new Map<string, { body: string; revision: number }>(), loseNextReply: false, puts: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== '/api/saves/current') throw new Error(`unexpected ${url}`);
    if (!init?.method || init.method === 'GET') return server.save ? json({ save: server.save, revision: server.revision }) : json({ message: 'none' }, 404);
    server.puts++;
    const body = JSON.parse(String(init.body)) as { save: unknown; revision: number; requestId: string }, content = JSON.stringify(body.save);
    const receipt = server.receipts.get(body.requestId);
    if (receipt) return receipt.body === content ? json({ revision: receipt.revision }) : json({ message: 'same id, other content' }, 409);
    if (body.revision !== server.revision) return json({ message: 'stale revision' }, 409);
    server.save = body.save; server.revision++; server.receipts.set(body.requestId, { body: content, revision: server.revision });
    if (server.loseNextReply) { server.loseNextReply = false; throw new TypeError('Failed to fetch'); }
    return json({ revision: server.revision });
  }));
  return server;
}

let readStore: ReturnType<typeof installFakeIndexedDb>, locks: ReturnType<typeof installFakeLocks>;
let clock = 1_750_000_000_000;
beforeEach(() => {
  readStore = installFakeIndexedDb(); locks = installFakeLocks();
  vi.spyOn(Date, 'now').mockImplementation(() => clock += 1000);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('save backups', () => {
  it('keeps the newest three full backups of each kind per profile', { timeout: 60_000 }, async () => {
    const storage = await freshStorage();
    await storage.activateSaveProfile(null);
    const save = storage.packSave(createGame(1, 'backups'), graph, storage.defaultView());
    for (let index = 0; index < 7; index++) await storage.writeSave(save, 'backup-before-move-change');
    await storage.writeSave(save, 'backup-before-release');
    await storage.writeSave(save, `backup-before-map-${Date.now()}`);
    const keys = [...readStore('choketmon-151', 'saves').keys()];
    const moves = keys.filter(key => key.startsWith('backup-before-move-change-')).sort();
    expect(moves).toHaveLength(3);
    expect(keys.filter(key => key.startsWith('backup-before-release-'))).toHaveLength(1);
    expect(keys.filter(key => key.startsWith('backup-before-map-'))).toHaveLength(1);
    await storage.writeSave(save, 'backup-before-move-change');
    const after = [...readStore('choketmon-151', 'saves').keys()].filter(key => key.startsWith('backup-before-move-change-')).sort();
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(moves.slice(1));
  });
});

describe('account checkpoints', () => {
  it('recognizes its own committed upload after a lost reply instead of reporting a conflict', { timeout: 60_000 }, async () => {
    const server = fakeSaveServer(), storage = await freshStorage(), statuses: string[] = [];
    storage.onSaveStorageStatus(status => statuses.push(status.state));
    await storage.activateSaveProfile({ id: 'player-1' });
    const game = createGame(1, 'lost-reply');
    await storage.writeSave(storage.packSave(game, graph, storage.defaultView()));
    server.loseNextReply = true;
    await expect(storage.checkpointSave('auto')).rejects.toThrow();
    expect(server.revision).toBe(1);

    game.player.money += 500;
    await storage.writeSave(storage.packSave(game, graph, storage.defaultView()));
    const result = await storage.checkpointSave('auto');
    expect(result).toMatchObject({ uploaded: true, revision: 2 });
    expect((server.save as { game: { player: { money: number } } }).game.player.money).toBe(game.player.money);
    expect(statuses).not.toContain('conflict');
    expect(storage.getSaveStorageStatus()?.state).toBe('synced');
  });

  it('recognizes that upload again after a reload', { timeout: 60_000 }, async () => {
    const server = fakeSaveServer();
    let storage = await freshStorage();
    await storage.activateSaveProfile({ id: 'player-2' });
    const game = createGame(1, 'lost-reply-reload');
    await storage.writeSave(storage.packSave(game, graph, storage.defaultView()));
    server.loseNextReply = true;
    await expect(storage.checkpointSave('auto')).rejects.toThrow();
    game.player.money += 900;
    await storage.writeSave(storage.packSave(game, graph, storage.defaultView()));

    locks.unload(); storage = await freshStorage();
    const loaded = await storage.activateSaveProfile({ id: 'player-2' }) as { game: { player: { money: number } } };
    expect(loaded.game.player.money).toBe(game.player.money);
    expect(storage.getSaveStorageStatus()).toMatchObject({ state: 'synced' });
    expect(server.revision).toBe(2);
    expect((server.save as { game: { player: { money: number } } }).game.player.money).toBe(game.player.money);
  });

  it('still reports a real conflict with another device', { timeout: 60_000 }, async () => {
    const server = fakeSaveServer(), storage = await freshStorage();
    await storage.activateSaveProfile({ id: 'player-3' });
    const game = createGame(1, 'real-conflict');
    await storage.writeSave(storage.packSave(game, graph, storage.defaultView()));
    await storage.checkpointSave('auto');
    const other = storage.packSave(createGame(4, 'other-device'), graph, storage.defaultView());
    server.save = JSON.parse(JSON.stringify(other)); server.revision++;
    game.player.money += 1;
    await storage.writeSave(storage.packSave(game, graph, storage.defaultView()));
    await expect(storage.checkpointSave('auto')).rejects.toThrow(storage.SaveConflictError);
    expect(storage.getSaveStorageStatus()?.state).toBe('conflict');
  });
});

describe('one writer per profile', () => {
  it('keeps a second tab from overwriting the first tab and reports it', { timeout: 60_000 }, async () => {
    const first = await freshStorage();
    await first.activateSaveProfile(null);
    const kept = first.packSave(createGame(1, 'first-tab'), graph, first.defaultView());
    await first.writeSave(kept);

    const second = await freshStorage();
    await second.activateSaveProfile(null);
    expect(second.getSaveStorageStatus()).toMatchObject({ state: 'error' });
    await expect(second.writeSave(second.packSave(createGame(4, 'second-tab'), graph, second.defaultView()))).rejects.toThrow(second.SaveWriterLockedError);
    expect((readStore('choketmon-151', 'saves').get('current') as { savedAt: string }).savedAt).toBe(kept.savedAt);
    await expect(first.writeSave(kept)).resolves.toBeUndefined();
  });
});

describe('server brain cache', () => {
  const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('');
  const decision = { action: 0, updates: 1, activity: .5, elapsedMs: 1, graphId: 'graph-1', nodes: 2, edges: 1 };
  async function brains(scope: string) {
    vi.resetModules();
    const module = await import('../src/game/server-brain');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/connectome') return json({ available: true, graphId: 'graph-1' });
      if (url === '/api/local-brains/step-batch') {
        const body = JSON.parse(String(init!.body)) as { steps: { creatureId: string; requestId: string }[] };
        return json({ decisions: body.steps.map(step => ({ creatureId: step.creatureId, requestId: step.requestId, decision })) });
      }
      throw new Error(`unexpected ${url}`);
    }));
    expect(await module.initializeServerBrain()).toBe(true);
    module.setServerBrainScope(scope);
    return module;
  }
  const record = (id: string) => ({ history: [], lastRequestId: 'a'.repeat(64), decision: { ...decision }, checkpoint: `checkpoint-${id}`, checkpointId: 'a'.repeat(64) });

  it('drops departed individuals and caps other saves oldest first, never touching held ones', { timeout: 60_000 }, async () => {
    const module = await brains('seed-1');
    const rows = () => readStore('choketmon-neural-cache', 'brains');
    const seedRows = new Map<string, unknown>([['device-id', 'device-1']]);
    const client = await digest('device-1:seed-1:graph-1'), other = await digest('device-1:seed-0:graph-1'), now = Date.now();
    seedRows.set(`${client}:mon-1`, record('1')); seedRows.set(`touch:${client}:mon-1`, now - 3_600_000);
    seedRows.set(`${client}:mon-2`, record('2')); seedRows.set(`touch:${client}:mon-2`, now - 3_600_000);
    seedRows.set(`${client}:mon-3`, record('3')); seedRows.set(`touch:${client}:mon-3`, now);
    seedRows.set(`${client}:mon-4`, record('4'));
    for (let index = 0; index < 300; index++) { seedRows.set(`${other}:mon-${index}`, record(`o${index}`)); seedRows.set(`touch:${other}:mon-${index}`, now - 7_200_000 + index); }
    // Looking up an unknown individual opens the cache; the rows stand for earlier sessions.
    expect(await module.exportTransferableServerBrain('mon-0')).toBeNull();
    for (const [key, value] of seedRows) rows().set(key, value);

    const removed = await module.pruneServerBrains('seed-1', ['mon-1']);
    const keys = [...rows().keys()];
    expect(keys).toContain(`${client}:mon-1`);
    expect(keys).not.toContain(`${client}:mon-2`); expect(keys).not.toContain(`touch:${client}:mon-2`);
    expect(keys).toContain(`${client}:mon-3`);
    expect(keys).not.toContain(`${client}:mon-4`);
    expect(keys).toContain('device-id');
    const others = keys.filter(key => key.startsWith(`${other}:`));
    expect(others.length + 2).toBe(256);
    expect(others).toContain(`${other}:mon-299`); expect(others).not.toContain(`${other}:mon-0`);
    expect(removed).toBe(2 + 300 - others.length);
  });

  it('forgets display receipts of individuals the save no longer holds', { timeout: 60_000 }, async () => {
    const module = await brains('seed-2');
    const { ConnectomeController } = await import('../src/game/connectome');
    const controller = new ConnectomeController(graph);
    const monster = (instanceId: string) => ({ instanceId, speciesId: 7, level: 20, hp: 50, stats: { hp: 100, speed: 50 }, moves: [{ moveId: 33, pp: 35 }] });
    await module.chooseServerBrains(controller, [{ self: monster('mon-7'), foe: monster('mon-8'), turn: 1, reward: null, learning: false, battleId: 'b1' }]);
    expect(module.lastServerDecision('mon-7')).toBeDefined();
    await module.pruneServerBrains('seed-2', ['mon-1']);
    expect(module.lastServerDecision('mon-7')).toBeUndefined();
  });

  it('retries a busy checkpoint request while exporting a traded brain', { timeout: 60_000 }, async () => {
    const module = await brains('seed-3');
    const { ConnectomeController } = await import('../src/game/connectome');
    const controller = new ConnectomeController(graph);
    const monster = (instanceId: string) => ({ instanceId, speciesId: 7, level: 20, hp: 50, stats: { hp: 100, speed: 50 }, moves: [{ moveId: 33, pp: 35 }] });
    await module.chooseServerBrains(controller, [{ self: monster('mon-5'), foe: monster('mon-6'), turn: 1, reward: null, learning: false, battleId: 'b2' }]);
    let attempts = 0;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url !== '/api/local-brains/checkpoint') return base(url, init);
      attempts++;
      if (attempts === 1) return json({ message: 'Neural computation is busy. Please retry shortly.' }, 429);
      if (attempts === 2) throw new TypeError('Failed to fetch');
      const body = JSON.parse(String(init!.body)) as { lastRequestId: string };
      return json({ checkpoint: 'compacted', checkpointId: body.lastRequestId });
    });
    const exported = await module.exportTransferableServerBrain('mon-5');
    expect(attempts).toBe(3);
    expect(exported?.state).toMatchObject({ checkpoint: 'compacted', history: [] });
  });
});
