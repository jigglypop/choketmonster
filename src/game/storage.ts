import { validateGraph, type Graph } from '../core/brain';
import { parseJson } from '../core/json';
import { validateGame, type GameState } from './engine';
import { BRAIN_MODEL } from './connectome';
import { startPosition, tileAt, type MapPosition } from './map';
import { FieldSimulation, type FieldSnapshot } from './field';
import { OpenWorldSimulation, type OpenWorldSnapshot } from '../openworld/simulation';

export type ViewState = { position: MapPosition; learning: boolean; learningDefaultsVersion?: 1; rewards?: Record<string, number>; field?: FieldSnapshot; fieldPreferences?: { paused: boolean; learning: boolean; selectedId: string }; openWorld?: OpenWorldSnapshot; openWorldPaused?: boolean };
export type SaveEnvelope = { format: 'choketmon'; version: 2; model: string; savedAt: string; graph: Graph; game: unknown; view: ViewState };
const monsters = (game: GameState) => [...game.player.team, ...game.player.box, ...(game.battle?.enemy.team ?? []), ...(game.battle?.player.team ?? []), ...(game.captureOffer ? [game.captureOffer] : [])];
// PostgreSQL/Rust JSON serializers may reorder object keys without changing a graph.
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const computationalGraph = (graph: Graph) => canonicalJson({ kind: graph.kind, id: graph.id, nodes: graph.nodes,
  edges: graph.edges.map(({ source, target, weight }) => ({ source, target, weight })),
  source: graph.provenance.source, version: graph.provenance.version, sha256: graph.provenance.sha256 });

export function packSave(game: GameState, graph: Graph, view: ViewState): SaveEnvelope {
  // Store the immutable topology once, even when hundreds of monsters have memories.
  const packed = JSON.parse(JSON.stringify(game, (key, value) => key === 'graph' ? undefined : value));
  return { format: 'choketmon', version: 2, model: BRAIN_MODEL, savedAt: new Date().toISOString(), graph: structuredClone(graph), game: packed, view: structuredClone(view) };
}
export function unpackSave(input: unknown, expectedGraph?: Graph): { game: GameState; graph: Graph; view: ViewState } {
  const value = (typeof input === 'string' ? parseJson(input) : structuredClone(input)) as SaveEnvelope;
  if (!value || value.format !== 'choketmon' || value.version !== 2 || value.model !== BRAIN_MODEL) throw new Error('초켓몬스터 151종 저장 파일이 아닙니다.');
  validateGraph(value.graph);
  if (value.graph.kind !== 'connectome-subset') throw new Error('실제 커넥톰 저장만 불러올 수 있습니다.');
  if (expectedGraph && computationalGraph(value.graph) !== computationalGraph(expectedGraph)) throw new Error('이 저장 파일은 현재 설치된 커넥톰과 다릅니다. 원래 데이터로 실행해 주세요.');
  const graph = expectedGraph ?? value.graph;
  const candidate = value.game as GameState;
  if (!candidate?.player || !Array.isArray(candidate.player.team) || !Array.isArray(candidate.player.box)) throw new Error('포켓몬 저장 목록이 올바르지 않습니다.');
  if (candidate.battle && (!Array.isArray(candidate.battle.enemy?.team) || !Array.isArray(candidate.battle.player?.team))) throw new Error('배틀 저장이 손상되었습니다.');
  for (const monster of monsters(candidate)) if (monster.brain) {
    monster.brain.graph = structuredClone(graph);
    if (monster.brain.sensoryBypass !== false) throw new Error('저장된 신경 모델이 맞지 않습니다.');
  }
  const game = validateGame(candidate);
  const view = value.view;
  if (!view || typeof view.learning !== 'boolean' || (view.learningDefaultsVersion !== undefined && view.learningDefaultsVersion !== 1) || !view.position || ![view.position.x, view.position.y, view.position.steps].every(Number.isSafeInteger) || view.position.x < 1 || view.position.x > 22 || view.position.y < 1 || view.position.y > 13 || view.position.steps < 0) throw new Error('탐험 위치가 올바르지 않습니다.');
  if (['tree', 'water', 'building'].includes(tileAt(view.position.x, view.position.y))) throw new Error('탐험할 수 없는 위치입니다.');
  if (view.rewards !== undefined && (!view.rewards || typeof view.rewards !== 'object' || Array.isArray(view.rewards) || Object.entries(view.rewards).some(([id, reward]) => !monsters(game).some(mon => mon.instanceId === id) || !Number.isFinite(reward) || Math.abs(reward) > 100))) throw new Error('신경 학습의 보상 기록이 올바르지 않습니다.');
  if (view.field !== undefined) {
    const field = view.field;
    if (!field || !Array.isArray(field.entities)) throw new Error('들판 기억이 올바르지 않습니다.');
    new FieldSimulation(graph, field.seed, field.entities.map(({ id, speciesId }) => ({ id, speciesId })), field);
  }
  const preferences = view.fieldPreferences;
  if (preferences !== undefined && (!preferences || typeof preferences.paused !== 'boolean' || typeof preferences.learning !== 'boolean' || typeof preferences.selectedId !== 'string')) throw new Error('들판 설정이 올바르지 않습니다.');
  if (view.openWorldPaused !== undefined && typeof view.openWorldPaused !== 'boolean') throw new Error('월드 정지 설정이 올바르지 않습니다.');
  // Validation may run a map migration. Keep the decoded save untouched so the
  // caller can back up its original version and progress before applying it.
  if (view.openWorld !== undefined) new OpenWorldSimulation(graph, structuredClone(game), view.openWorld.seed, view.openWorld);
  return { game, graph, view: view.learningDefaultsVersion === undefined ? { ...view, learning: true, learningDefaultsVersion: 1 } : view };
}

const DATABASE = 'choketmon-151', STORE = 'saves', SYNC_STORE = 'server-sync';
export type SaveProfile = { id: string; username?: string } | null;
export type SaveStorageStatus = { state: 'local' | 'synced' | 'error'; profileId: string; message?: string };
type SyncOutbox = { save: SaveEnvelope; revision: number; requestId: string; localVersion: number };
type SyncRecord = { profileId: string; serverRevision: number; localVersion: number; dirty: boolean; outbox?: SyncOutbox };
let storageStatus: SaveStorageStatus | undefined;
const storageListeners = new Set<(status: SaveStorageStatus) => void>();
export function getSaveStorageStatus() { return storageStatus; }
export function onSaveStorageStatus(listener: (status: SaveStorageStatus) => void) { storageListeners.add(listener); if (storageStatus) listener(storageStatus); return () => { storageListeners.delete(listener); }; }
const announceStorage = (status: SaveStorageStatus) => { storageStatus = status; for (const listener of storageListeners) listener(status); };
let databasePromise: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      if (!request.result.objectStoreNames.contains(SYNC_STORE)) request.result.createObjectStore(SYNC_STORE);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); databasePromise = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { databasePromise = undefined; reject(request.error); };
  });
  return databasePromise;
}
async function readLocal(key: string): Promise<unknown | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly'), request = tx.objectStore(STORE).get(key);
    tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
async function writeLocal(key: string, save: unknown) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(structuredClone(save), key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
async function updateSync(key: string, update: (value: SyncRecord | undefined) => SyncRecord | undefined): Promise<SyncRecord | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE, 'readwrite'), store = tx.objectStore(SYNC_STORE), request = store.get(key);
    let result: SyncRecord | undefined;
    request.onsuccess = () => { result = update(request.result as SyncRecord | undefined); if (result) store.put(structuredClone(result), key); };
    tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export async function readSave(key = 'current'): Promise<unknown | undefined> {
  const slot = profileSlot(key), local = await readLocal(slot);
  if (local !== undefined) { announceStorage({ state: 'local', profileId: activeProfile?.id ?? 'device' }); return local; }
  announceStorage({ state: 'local', profileId: activeProfile?.id ?? 'device' });
  return undefined;
}
let localWriteQueue: Promise<void> = Promise.resolve();
export function writeSave(save: SaveEnvelope, key = 'current'): Promise<void> {
  const snapshot = structuredClone(save), profile = activeProfile, baseSlot = key === 'current' || /-\d{13}$/.test(key) ? key : `${key}-${Date.now()}`, slot = profileSlot(baseSlot, profile);
  const operation = localWriteQueue.catch(() => {}).then(async () => {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const stores = profile ? [STORE, SYNC_STORE] : [STORE], tx = db.transaction(stores, 'readwrite');
      tx.objectStore(STORE).put(snapshot, slot);
      if (profile && baseSlot === 'current') {
        const syncStore = tx.objectStore(SYNC_STORE), request = syncStore.get(syncKey(profile.id));
        request.onsuccess = () => {
          const prior = request.result as SyncRecord | undefined;
          syncStore.put({ profileId: profile.id, serverRevision: prior?.serverRevision ?? 0, localVersion: (prior?.localVersion ?? 0) + 1, dirty: true } satisfies SyncRecord, syncKey(profile.id));
        };
      }
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    announceStorage({ state: 'local', profileId: profile?.id ?? 'device', message: profile ? '이 기기에 저장됨 · 서버 체크포인트 대기' : undefined });
  });
  localWriteQueue = operation; return operation;
}

let activeProfile: SaveProfile = null, profileGeneration = 0, checkpointQueue: Promise<CheckpointResult> = Promise.resolve({ uploaded: false, reason: 'manual' });
const profileSlot = (slot: string, profile: SaveProfile = activeProfile) => profile ? `account:${profile.id}:${slot}` : slot;
const syncKey = (profileId: string) => `account:${profileId}:current`;
const requestId = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `save_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const validRemote = (value: unknown): value is SaveEnvelope => Boolean(value && typeof value === 'object' && (value as SaveEnvelope).format === 'choketmon' && (value as SaveEnvelope).version === 2);
const timestamp = (save: unknown) => validRemote(save) && Number.isFinite(Date.parse(save.savedAt)) ? Date.parse(save.savedAt) : 0;
export function currentSaveProfile() { return activeProfile ? { ...activeProfile } : null; }

type RemoteSave = { save: SaveEnvelope; revision: number };
const profileHeaders = (profileId: string) => ({ 'x-choketmon-profile': profileId });
async function loadRemote(profileId: string): Promise<RemoteSave | undefined> {
  const response = await fetch('/api/saves/current', { credentials: 'same-origin', cache: 'no-store', headers: profileHeaders(profileId), signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return undefined;
  const body = await response.json().catch(() => ({})) as Partial<RemoteSave> & { message?: string };
  if (!response.ok) throw new Error(body.message ?? '서버 저장을 불러오지 못했습니다.');
  if (!validRemote(body.save) || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new Error('서버 저장 응답이 올바르지 않습니다.');
  return { save: body.save, revision: Number(body.revision) };
}

async function reconcileRemote(profile: NonNullable<SaveProfile>, remote: RemoteSave | undefined): Promise<{ save?: unknown; upload: boolean }> {
  const db = await database(), key = syncKey(profile.id), localKey = profileSlot('current', profile), remoteRevision = remote?.revision ?? 0;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, SYNC_STORE], 'readwrite'), saves = tx.objectStore(STORE), syncs = tx.objectStore(SYNC_STORE);
    const localRequest = saves.get(localKey), syncRequest = syncs.get(key); let result: { save?: unknown; upload: boolean } = { upload: false };
    const decide = () => {
      if (localRequest.readyState !== 'done' || syncRequest.readyState !== 'done') return;
      const local = localRequest.result, prior = syncRequest.result as SyncRecord | undefined;
      if (local !== undefined && (prior?.dirty || timestamp(local) > timestamp(remote?.save))) {
        const outbox = prior?.outbox?.revision === remoteRevision ? prior.outbox : undefined;
        syncs.put({ profileId: profile.id, serverRevision: remoteRevision, localVersion: prior?.localVersion ?? 1, dirty: true, outbox } satisfies SyncRecord, key);
        result = { save: local, upload: true }; return;
      }
      if (remote) {
        saves.put(structuredClone(remote.save), localKey);
        syncs.put({ profileId: profile.id, serverRevision: remoteRevision, localVersion: (prior?.localVersion ?? 0) + 1, dirty: false } satisfies SyncRecord, key);
        result = { save: remote.save, upload: false }; return;
      }
      syncs.put({ profileId: profile.id, serverRevision: 0, localVersion: prior?.localVersion ?? 0, dirty: local !== undefined } satisfies SyncRecord, key);
      result = { save: local, upload: local !== undefined };
    };
    localRequest.onsuccess = decide; syncRequest.onsuccess = decide;
    tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}

/** Switches the IndexedDB namespace and reconciles that account with PostgreSQL. */
export async function activateSaveProfile(profile: SaveProfile): Promise<unknown | undefined> {
  await localWriteQueue.catch(() => {});
  const generation = ++profileGeneration;
  activeProfile = profile ? { ...profile } : null;
  if (!profile) { announceStorage({ state: 'local', profileId: 'device' }); return readLocal('current'); }
  let remote: RemoteSave | undefined;
  try { remote = await loadRemote(profile.id); }
  catch (error) {
    if (generation !== profileGeneration || activeProfile?.id !== profile.id) return undefined;
    if (generation === profileGeneration && activeProfile?.id === profile.id) announceStorage({ state: 'error', profileId: profile.id, message: error instanceof Error ? error.message : String(error) });
    return readLocal(profileSlot('current', profile));
  }
  if (generation !== profileGeneration || activeProfile?.id !== profile.id) return undefined;
  const reconciled = await reconcileRemote(profile, remote);
  if (generation !== profileGeneration || activeProfile?.id !== profile.id) return undefined;
  if (reconciled.upload) {
    try { await checkpointSave('login'); }
    catch (error) {
      if (generation === profileGeneration && activeProfile?.id === profile.id) announceStorage({ state: 'error', profileId: profile.id, message: error instanceof Error ? error.message : String(error) });
      // Authentication already changed scope. Keep rendering this account's
      // IndexedDB copy and leave its outbox dirty for the next checkpoint.
    }
  } else announceStorage({ state: 'synced', profileId: profile.id, message: remote ? '계정 저장을 불러왔습니다.' : '새 계정 저장 공간이 준비됐습니다.' });
  return reconciled.save;
}

export type CheckpointReason = 'login' | 'logout' | 'auto' | 'manual';
export type CheckpointResult = { uploaded: boolean; reason: CheckpointReason; revision?: number };
async function prepareOutbox(profile: NonNullable<SaveProfile>): Promise<SyncRecord | undefined> {
  const db = await database(), key = syncKey(profile.id), localKey = profileSlot('current', profile), proposedId = requestId();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, SYNC_STORE], 'readwrite'), saves = tx.objectStore(STORE), syncs = tx.objectStore(SYNC_STORE);
    const localRequest = saves.get(localKey), syncRequest = syncs.get(key); let result: SyncRecord | undefined;
    const decide = () => {
      if (localRequest.readyState !== 'done' || syncRequest.readyState !== 'done') return;
      const local = localRequest.result as SaveEnvelope | undefined;
      if (!local) return;
      const current = (syncRequest.result as SyncRecord | undefined) ?? { profileId: profile.id, serverRevision: 0, localVersion: 1, dirty: true };
      result = current.outbox || !current.dirty ? current : { ...current, dirty: true, outbox: { save: structuredClone(local), revision: current.serverRevision, requestId: proposedId, localVersion: current.localVersion } };
      if (result !== current || !syncRequest.result) syncs.put(structuredClone(result), key);
    };
    localRequest.onsuccess = decide; syncRequest.onsuccess = decide;
    tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
async function performCheckpoint(reason: CheckpointReason, expectedProfile: SaveProfile, expectedGeneration: number): Promise<CheckpointResult> {
  await localWriteQueue.catch(() => {});
  const profile = activeProfile, generation = profileGeneration;
  if (generation !== expectedGeneration || profile?.id !== expectedProfile?.id) return { uploaded: false, reason };
  if (!profile) return { uploaded: false, reason };
  const key = syncKey(profile.id), scopeValid = () => generation === profileGeneration && activeProfile?.id === profile.id;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!scopeValid()) return { uploaded: false, reason };
    const sync = await prepareOutbox(profile);
    if (!scopeValid()) return { uploaded: false, reason };
    if (!sync) return { uploaded: false, reason };
    if (!sync.dirty && !sync.outbox) { announceStorage({ state: 'synced', profileId: profile.id }); return { uploaded: false, reason, revision: sync.serverRevision }; }
    const pending = sync.outbox!;
    try {
      if (!scopeValid()) return { uploaded: false, reason };
      const response = await fetch('/api/saves/current', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...profileHeaders(profile.id) }, body: JSON.stringify({ save: pending.save, revision: pending.revision, requestId: pending.requestId }), signal: AbortSignal.timeout(20000) });
      const body = await response.json().catch(() => ({})) as { revision?: number; message?: string };
      if (!scopeValid()) return { uploaded: false, reason };
      if (response.status === 409) {
        const remote = await loadRemote(profile.id);
        if (!scopeValid()) return { uploaded: false, reason };
        await updateSync(key, latest => {
          if (!latest) return latest;
          const remoteRevision = remote?.revision ?? latest.serverRevision;
          if (latest.outbox?.requestId === pending.requestId || remoteRevision > latest.serverRevision) return { ...latest, serverRevision: remoteRevision, dirty: true, outbox: undefined };
          return latest;
        });
        continue;
      }
      if (!response.ok || !Number.isSafeInteger(body.revision)) throw new Error(body.message ?? '서버 체크포인트 저장에 실패했습니다.');
      const latest = await updateSync(key, latest => {
        if (!latest) return latest;
        if (latest.outbox?.requestId === pending.requestId) return { ...latest, serverRevision: body.revision!, dirty: latest.localVersion !== pending.localVersion, outbox: undefined };
        // A newer local write may have replaced this outbox while the request was in flight.
        // Keep that write dirty, but advance its base revision and rebuild its request body.
        return body.revision! > latest.serverRevision ? { ...latest, serverRevision: body.revision!, dirty: true, outbox: undefined } : latest;
      });
      if (latest?.dirty) continue;
      if (scopeValid()) announceStorage({ state: 'synced', profileId: profile.id, message: 'PostgreSQL 체크포인트 저장됨' });
      return { uploaded: true, reason, revision: body.revision };
    } catch (error) {
      if (!scopeValid()) return { uploaded: false, reason };
      if (generation === profileGeneration && activeProfile?.id === profile.id) announceStorage({ state: 'error', profileId: profile.id, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  throw new Error('다른 기기의 저장과 충돌했습니다. 이 기기의 최신 진행은 보존되어 있습니다.');
}
export function checkpointSave(reason: CheckpointReason = 'manual'): Promise<CheckpointResult> {
  const expectedProfile = activeProfile ? { ...activeProfile } : null, expectedGeneration = profileGeneration;
  const operation = checkpointQueue.catch(() => ({ uploaded: false, reason })).then(() => performCheckpoint(reason, expectedProfile, expectedGeneration));
  checkpointQueue = operation; return operation;
}
export function startCheckpointAutosave(intervalMs = 60_000) {
  const timer = window.setInterval(() => { void checkpointSave('auto').catch(() => {}); }, Math.max(10_000, intervalMs));
  return () => window.clearInterval(timer);
}
export const defaultView = (): ViewState => ({ position: startPosition(), learning: true, learningDefaultsVersion: 1, rewards: {} });
