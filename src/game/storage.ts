import { validateGraph, type Graph } from '../core/brain';
import { parseJson } from '../core/json';
import { validateGame, type GameState } from './engine';
import { BRAIN_MODEL } from './connectome';
import { startPosition, tileAt, type MapPosition } from './map';
import { FieldSimulation, type FieldSnapshot } from './field';
import { OpenWorldSimulation, type OpenWorldSnapshot } from '../openworld/simulation';

export type ViewState = { position: MapPosition; learning: boolean; learningDefaultsVersion?: 1; rewards?: Record<string, number>; field?: FieldSnapshot; fieldPreferences?: { paused: boolean; learning: boolean; selectedId: string }; openWorld?: OpenWorldSnapshot; openWorldPaused?: boolean; tradeTransferProvenance?: Record<string, { sourceInstanceId: string; tradeId?: string }> };
export type SaveEnvelope = { format: 'choketmon'; version: 2; model: string; savedAt: string; graph: Graph; game: unknown; view: ViewState; tradeEpoch?: number };
const decodedTradeEpoch = new WeakMap<object, number>();
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
  return { format: 'choketmon', version: 2, model: BRAIN_MODEL, savedAt: new Date().toISOString(), graph: structuredClone(graph), game: packed, view: structuredClone(view), tradeEpoch: decodedTradeEpoch.get(game) ?? activeTradeEpoch };
}
export function unpackSave(input: unknown, expectedGraph?: Graph, internal?: { allowTradeEpochAdvance?: boolean }): { game: GameState; graph: Graph; view: ViewState } {
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
  if (view.tradeTransferProvenance !== undefined && (!view.tradeTransferProvenance || typeof view.tradeTransferProvenance !== 'object' || Array.isArray(view.tradeTransferProvenance)
    || Object.entries(view.tradeTransferProvenance).length > 10_000 || Object.entries(view.tradeTransferProvenance).some(([id, record]) => !/^mon-[1-9]\d*$/.test(id)
      || !record || typeof record.sourceInstanceId !== 'string' || !/^mon-[1-9]\d*$/.test(record.sourceInstanceId) || (record.tradeId !== undefined && (typeof record.tradeId !== 'string' || !record.tradeId || record.tradeId.length > 100))))) throw new Error('거래 개체 출처 기록이 올바르지 않습니다.');
  // Validation may run a map migration. Keep the decoded save untouched so the
  // caller can back up its original version and progress before applying it.
  if (view.openWorld !== undefined) new OpenWorldSimulation(graph, structuredClone(game), view.openWorld.seed, view.openWorld);
  const tradeEpoch = normalizeTradeEpoch(value.tradeEpoch);
  if (tradeEpochReady && tradeEpoch !== activeTradeEpoch && !internal?.allowTradeEpochAdvance) throw new StaleTradeEpochError();
  decodedTradeEpoch.set(game, tradeEpoch);
  return { game, graph, view: view.learningDefaultsVersion === undefined ? { ...view, learning: true, learningDefaultsVersion: 1 } : view };
}

const DATABASE = 'choketmon-151', STORE = 'saves', SYNC_STORE = 'server-sync';
export type SaveProfile = { id: string; username?: string } | null;
export type SaveConflictSummary = { deviceSavedAt: string; serverSavedAt: string; serverRevision: number };
export type SaveStorageStatus = { state: 'local' | 'synced' | 'error' | 'conflict'; profileId: string; message?: string; conflict?: SaveConflictSummary };
// The save itself already lives in the account's current slot. Keeping another
// full copy in sync metadata made every checkpoint write and then delete a
// second ~1MB IndexedDB value. `save` remains optional for legacy outboxes.
type SyncOutbox = { save?: SaveEnvelope; revision: number; requestId: string; localVersion: number };
type SyncConflict = { remote: SaveEnvelope; remoteRevision: number };
type SyncRecord = { profileId: string; serverRevision: number; localVersion: number; dirty: boolean; outbox?: SyncOutbox; conflict?: SyncConflict };
type TradeReceipt = { profileId: string; tradeId: string; revision: number; tradeEpoch: number };
let storageStatus: SaveStorageStatus | undefined;
let activeTradeEpoch = 0, tradeEpochReady = false;
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
  if (key === 'current') { activeTradeEpoch = validRemote(local) ? normalizeTradeEpoch(local.tradeEpoch) : 0; tradeEpochReady = true; }
  if (activeProfile && key === 'current') {
    const sync = await readSync(syncKey(activeProfile.id));
    if (sync?.conflict) announceConflict(activeProfile.id, local, sync.conflict);
    else announceStorage({ state: sync && !sync.dirty ? 'synced' : 'local', profileId: activeProfile.id });
    return local;
  }
  if (local !== undefined) { announceStorage({ state: 'local', profileId: activeProfile?.id ?? 'device' }); return local; }
  announceStorage({ state: 'local', profileId: activeProfile?.id ?? 'device' });
  return undefined;
}
let localWriteQueue: Promise<void> = Promise.resolve();
export class StaleTradeEpochError extends Error {
  constructor() { super('거래로 갱신된 저장보다 오래된 진행은 저장할 수 없습니다. 최신 거래 결과를 다시 불러와 주세요.'); this.name = 'StaleTradeEpochError'; }
}
const normalizeTradeEpoch = (value: unknown) => value === undefined ? 0
  : Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value)
    : (() => { throw new Error('저장의 거래 버전이 올바르지 않습니다.'); })();
export function writeSave(save: SaveEnvelope, key = 'current'): Promise<void> {
  const snapshot = structuredClone(save), profile = activeProfile, generation = profileGeneration,
    baseSlot = key === 'current' || /-\d{13}$/.test(key) ? key : `${key}-${Date.now()}`, slot = profileSlot(baseSlot, profile);
  snapshot.tradeEpoch = normalizeTradeEpoch(snapshot.tradeEpoch);
  const operation = localWriteQueue.catch(() => {}).then(async () => {
    if (generation !== profileGeneration || profile?.id !== activeProfile?.id) throw new Error('계정이 바뀌어 이전 저장 작업을 중단했습니다.');
    const db = await database(); let retainedConflict: SyncConflict | undefined;
    await new Promise<void>((resolve, reject) => {
      const stores = profile ? [STORE, SYNC_STORE] : [STORE], tx = db.transaction(stores, 'readwrite');
      const saves = tx.objectStore(STORE), currentRequest = baseSlot === 'current' ? saves.get(slot) : undefined;
      const apply = () => {
        const storedEpoch = validRemote(currentRequest?.result) ? normalizeTradeEpoch(currentRequest!.result.tradeEpoch) : 0;
        if (baseSlot === 'current' && normalizeTradeEpoch(snapshot.tradeEpoch) < storedEpoch) { tx.abort(); return; }
        saves.put(snapshot, slot);
      };
      if (currentRequest) currentRequest.onsuccess = apply; else apply();
      if (profile && baseSlot === 'current') {
        const syncStore = tx.objectStore(SYNC_STORE), request = syncStore.get(syncKey(profile.id));
        request.onsuccess = () => {
          const prior = request.result as SyncRecord | undefined;
          retainedConflict = prior?.conflict;
          syncStore.put({ profileId: profile.id, serverRevision: prior?.serverRevision ?? 0, localVersion: (prior?.localVersion ?? 0) + 1, dirty: true, conflict: prior?.conflict } satisfies SyncRecord, syncKey(profile.id));
        };
      }
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => {
        const storedEpoch = validRemote(currentRequest?.result) ? normalizeTradeEpoch(currentRequest!.result.tradeEpoch) : 0;
        reject(normalizeTradeEpoch(snapshot.tradeEpoch) < storedEpoch ? new StaleTradeEpochError() : tx.error);
      };
    });
    if (baseSlot === 'current') { activeTradeEpoch = normalizeTradeEpoch(snapshot.tradeEpoch); tradeEpochReady = true; }
    if (profile && retainedConflict) announceConflict(profile.id, snapshot, retainedConflict);
    else announceStorage({ state: 'local', profileId: profile?.id ?? 'device', message: profile ? '이 기기에 저장됨 · 서버 체크포인트 대기' : undefined });
  });
  localWriteQueue = operation; return operation;
}

let activeProfile: SaveProfile = null, profileGeneration = 0, checkpointQueue: Promise<CheckpointResult> = Promise.resolve({ uploaded: false, reason: 'manual' });
const profileSlot = (slot: string, profile: SaveProfile = activeProfile) => profile ? `account:${profile.id}:${slot}` : slot;
const syncKey = (profileId: string) => `account:${profileId}:current`;
const requestId = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `save_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const validRemote = (value: unknown): value is SaveEnvelope => Boolean(value && typeof value === 'object' && (value as SaveEnvelope).format === 'choketmon' && (value as SaveEnvelope).version === 2);
const equivalentSave = (left: unknown, right: unknown) => validRemote(left) && validRemote(right)
  && canonicalJson({ ...left, savedAt: undefined, tradeEpoch: normalizeTradeEpoch(left.tradeEpoch) })
    === canonicalJson({ ...right, savedAt: undefined, tradeEpoch: normalizeTradeEpoch(right.tradeEpoch) });
export function currentSaveProfile() { return activeProfile ? { ...activeProfile } : null; }
export function currentTradeEpoch() { return activeTradeEpoch; }

type RemoteSave = { save: SaveEnvelope; revision: number };
const profileHeaders = (profileId: string) => ({ 'x-choketmon-profile': profileId });
async function readSync(key: string): Promise<SyncRecord | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE, 'readonly'), request = tx.objectStore(SYNC_STORE).get(key);
    tx.oncomplete = () => resolve(request.result as SyncRecord | undefined); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
const conflictSummary = (local: unknown, conflict: SyncConflict): SaveConflictSummary => ({
  deviceSavedAt: validRemote(local) ? local.savedAt : '', serverSavedAt: conflict.remote.savedAt, serverRevision: conflict.remoteRevision,
});
const announceConflict = (profileId: string, local: unknown, conflict: SyncConflict) => announceStorage({
  state: 'conflict', profileId, conflict: conflictSummary(local, conflict),
  message: '이 기기와 서버에 서로 다른 진행이 있습니다. 사용할 진행을 선택해 주세요.',
});
export class SaveConflictError extends Error {
  constructor() { super('이 기기와 서버의 진행이 달라 자동 동기화를 멈췄습니다. 사용할 진행을 선택해 주세요.'); this.name = 'SaveConflictError'; }
}
async function loadRemote(profileId: string): Promise<RemoteSave | undefined> {
  const response = await fetch('/api/saves/current', { credentials: 'same-origin', cache: 'no-store', headers: profileHeaders(profileId), signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return undefined;
  const body = await response.json().catch(() => ({})) as Partial<RemoteSave> & { message?: string };
  if (!response.ok) throw new Error(body.message ?? '서버 저장을 불러오지 못했습니다.');
  if (!validRemote(body.save) || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new Error('서버 저장 응답이 올바르지 않습니다.');
  normalizeTradeEpoch(body.save.tradeEpoch);
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
      if (local !== undefined && remote && equivalentSave(local, remote.save)) {
        saves.put(structuredClone(remote.save), localKey);
        syncs.put({ profileId: profile.id, serverRevision: remoteRevision, localVersion: prior?.localVersion ?? 1, dirty: false } satisfies SyncRecord, key);
        result = { save: remote.save, upload: false }; return;
      }
      if (local !== undefined && remote && !equivalentSave(local, remote.save)
        && (prior?.conflict || !prior || (prior.dirty && remoteRevision > prior.serverRevision))) {
        const conflict = prior?.conflict?.remoteRevision === remoteRevision ? prior.conflict : { remote: structuredClone(remote.save), remoteRevision };
        if (!prior?.conflict || prior.conflict.remoteRevision !== remoteRevision) {
          const suffix = `${Date.now()}-${requestId()}`;
          saves.put(structuredClone(local), profileSlot(`backup-conflict-device-${suffix}`, profile));
          saves.put(structuredClone(remote.save), profileSlot(`backup-conflict-server-${suffix}`, profile));
        }
        syncs.put({ profileId: profile.id, serverRevision: prior?.serverRevision ?? 0, localVersion: prior?.localVersion ?? 1, dirty: true, conflict } satisfies SyncRecord, key);
        result = { save: local, upload: false }; return;
      }
      if (local !== undefined && (!remote || prior?.dirty)) {
        const outbox = prior?.outbox?.revision === remoteRevision ? prior.outbox : undefined;
        syncs.put({ profileId: profile.id, serverRevision: remoteRevision, localVersion: prior?.localVersion ?? 1, dirty: true, outbox } satisfies SyncRecord, key);
        result = { save: local, upload: true }; return;
      }
      if (remote) {
        if (validRemote(local) && normalizeTradeEpoch(remote.save.tradeEpoch) > normalizeTradeEpoch(local.tradeEpoch)) saves.put(structuredClone(local), profileSlot(`backup-before-trade-recovery-${Date.now()}-${requestId()}`, profile));
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

/** Explicit logout handoff. Never search unrelated account slots on guest startup. */
async function copyAccountToDevice(profile: NonNullable<SaveProfile>): Promise<unknown | undefined> {
  const db = await database(), backupKey = `backup-before-logout-${requestId()}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite'), saves = tx.objectStore(STORE);
    const account = saves.get(profileSlot('current', profile)), device = saves.get('current');
    let result: unknown;
    const copy = () => {
      if (account.readyState !== 'done' || device.readyState !== 'done') return;
      result = account.result ?? device.result;
      if (account.result === undefined) return;
      // Backup and replacement commit together. The account save and sync outbox
      // stay untouched, so neither a failed transaction nor logout loses progress.
      if (device.result !== undefined) saves.put(device.result, backupKey);
      saves.put(account.result, 'current');
    };
    account.onsuccess = copy; device.onsuccess = copy;
    tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}

/** Switches the IndexedDB namespace and reconciles that account with PostgreSQL. */
export async function activateSaveProfile(profile: SaveProfile, options: { continueLocally?: boolean } = {}): Promise<unknown | undefined> {
  await localWriteQueue.catch(() => {});
  const generation = ++profileGeneration;
  if (!profile && options.continueLocally && activeProfile) {
    const save = await copyAccountToDevice(activeProfile);
    if (generation !== profileGeneration) return undefined;
    activeProfile = null; activeTradeEpoch = validRemote(save) ? normalizeTradeEpoch(save.tradeEpoch) : 0; tradeEpochReady = true;
    announceStorage({ state: 'local', profileId: 'device' });
    return save;
  }
  activeProfile = profile ? { ...profile } : null; activeTradeEpoch = 0; tradeEpochReady = false;
  if (!profile) { announceStorage({ state: 'local', profileId: 'device' }); const local = await readLocal('current'); activeTradeEpoch = validRemote(local) ? normalizeTradeEpoch(local.tradeEpoch) : 0; tradeEpochReady = true; return local; }
  let remote: RemoteSave | undefined;
  try { remote = await loadRemote(profile.id); }
  catch (error) {
    if (generation !== profileGeneration || activeProfile?.id !== profile.id) return undefined;
    if (generation === profileGeneration && activeProfile?.id === profile.id) announceStorage({ state: 'error', profileId: profile.id, message: error instanceof Error ? error.message : String(error) });
    const local = await readLocal(profileSlot('current', profile));
    if (local === undefined) throw error;
    activeTradeEpoch = validRemote(local) ? normalizeTradeEpoch(local.tradeEpoch) : 0; tradeEpochReady = true;
    return local;
  }
  if (generation !== profileGeneration || activeProfile?.id !== profile.id) return undefined;
  const reconciled = await reconcileRemote(profile, remote);
  if (generation !== profileGeneration || activeProfile?.id !== profile.id) return undefined;
  const reconciledSync = await readSync(syncKey(profile.id));
  if (reconciledSync?.conflict) announceConflict(profile.id, reconciled.save, reconciledSync.conflict);
  else if (reconciled.upload) {
    try { await checkpointSave('login'); }
    catch (error) {
      if (!(error instanceof SaveConflictError) && generation === profileGeneration && activeProfile?.id === profile.id) announceStorage({ state: 'error', profileId: profile.id, message: error instanceof Error ? error.message : String(error) });
      // Authentication already changed scope. Keep rendering this account's
      // IndexedDB copy and leave its outbox dirty for the next checkpoint.
    }
  } else announceStorage({ state: 'synced', profileId: profile.id, message: remote ? '계정 저장을 불러왔습니다.' : '새 계정 저장 공간이 준비됐습니다.' });
  activeTradeEpoch = validRemote(reconciled.save) ? normalizeTradeEpoch(reconciled.save.tradeEpoch) : 0; tradeEpochReady = true;
  return reconciled.save;
}

export type CheckpointReason = 'login' | 'logout' | 'auto' | 'manual';
export type CheckpointResult = { uploaded: boolean; reason: CheckpointReason; revision?: number };
async function prepareOutbox(profile: NonNullable<SaveProfile>): Promise<{ sync: SyncRecord; save: SaveEnvelope } | undefined> {
  const db = await database(), key = syncKey(profile.id), localKey = profileSlot('current', profile), proposedId = requestId();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, SYNC_STORE], 'readwrite'), saves = tx.objectStore(STORE), syncs = tx.objectStore(SYNC_STORE);
    const localRequest = saves.get(localKey), syncRequest = syncs.get(key); let result: { sync: SyncRecord; save: SaveEnvelope } | undefined;
    const decide = () => {
      if (localRequest.readyState !== 'done' || syncRequest.readyState !== 'done') return;
      const local = localRequest.result as SaveEnvelope | undefined;
      if (!local) return;
      const current = (syncRequest.result as SyncRecord | undefined) ?? { profileId: profile.id, serverRevision: 0, localVersion: 1, dirty: true };
      const next = current.outbox || !current.dirty ? current : { ...current, dirty: true, outbox: { revision: current.serverRevision, requestId: proposedId, localVersion: current.localVersion } };
      result = { sync: next, save: next.outbox?.save ?? local };
      if (next !== current || !syncRequest.result) syncs.put(next, key);
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
    const prepared = await prepareOutbox(profile), sync = prepared?.sync;
    if (!scopeValid()) return { uploaded: false, reason };
    if (!sync) return { uploaded: false, reason };
    if (sync.conflict) { announceConflict(profile.id, await readLocal(profileSlot('current', profile)), sync.conflict); throw new SaveConflictError(); }
    if (!sync.dirty && !sync.outbox) { announceStorage({ state: 'synced', profileId: profile.id }); return { uploaded: false, reason, revision: sync.serverRevision }; }
    const pending = sync.outbox!;
    try {
      if (!scopeValid()) return { uploaded: false, reason };
      const response = await fetch('/api/saves/current', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...profileHeaders(profile.id) }, body: JSON.stringify({ save: prepared!.save, revision: pending.revision, requestId: pending.requestId }), signal: AbortSignal.timeout(20000) });
      const body = await response.json().catch(() => ({})) as { revision?: number; message?: string };
      if (!scopeValid()) return { uploaded: false, reason };
      if (response.status === 409) {
        const remote = await loadRemote(profile.id);
        if (!scopeValid()) return { uploaded: false, reason };
        if (!remote) throw new Error('서버 저장 충돌을 확인했지만 서버 저장을 다시 읽지 못했습니다.');
        const db = await database(), local = await readLocal(profileSlot('current', profile));
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction([STORE, SYNC_STORE], 'readwrite'), saves = tx.objectStore(STORE), syncs = tx.objectStore(SYNC_STORE);
          const request = syncs.get(key);
          request.onsuccess = () => {
            const latest = request.result as SyncRecord | undefined;
            if (!latest) return;
            const conflict = { remote: structuredClone(remote.save), remoteRevision: remote.revision };
            const suffix = `${Date.now()}-${requestId()}`;
            if (local !== undefined) saves.put(structuredClone(local), profileSlot(`backup-conflict-device-${suffix}`, profile));
            saves.put(structuredClone(remote.save), profileSlot(`backup-conflict-server-${suffix}`, profile));
            syncs.put({ ...latest, dirty: true, outbox: undefined, conflict }, key);
          };
          tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
        announceConflict(profile.id, local, { remote: remote.save, remoteRevision: remote.revision });
        throw new SaveConflictError();
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
      if (!(error instanceof SaveConflictError) && generation === profileGeneration && activeProfile?.id === profile.id) announceStorage({ state: 'error', profileId: profile.id, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  throw new Error('다른 기기의 저장과 충돌했습니다. 이 기기의 최신 진행은 보존되어 있습니다.');
}

/** Resolves a preserved device/server conflict only after an explicit UI choice. */
export async function resolveSaveConflict(choice: 'device' | 'server'): Promise<SaveEnvelope> {
  await localWriteQueue.catch(() => {});
  const profile = activeProfile, generation = profileGeneration;
  if (!profile) throw new Error('계정 저장 충돌이 없습니다.');
  const db = await database(), key = syncKey(profile.id), localKey = profileSlot('current', profile);
  const selected = await new Promise<SaveEnvelope>((resolve, reject) => {
    const tx = db.transaction([STORE, SYNC_STORE], 'readwrite'), saves = tx.objectStore(STORE), syncs = tx.objectStore(SYNC_STORE);
    const localRequest = saves.get(localKey), syncRequest = syncs.get(key); let result: SaveEnvelope | undefined;
    const apply = () => {
      if (localRequest.readyState !== 'done' || syncRequest.readyState !== 'done') return;
      const local = localRequest.result as SaveEnvelope | undefined, sync = syncRequest.result as SyncRecord | undefined;
      if (!local || !sync || (!sync.conflict && !(choice === 'device' && sync.dirty))) { tx.abort(); return; }
      if (!sync.conflict) { result = structuredClone(local); return; }
      if (choice === 'server') {
        result = structuredClone(sync.conflict.remote); saves.put(result, localKey);
        syncs.put({ profileId: profile.id, serverRevision: sync.conflict.remoteRevision, localVersion: sync.localVersion + 1, dirty: false } satisfies SyncRecord, key);
      } else {
        result = structuredClone(local);
        syncs.put({ ...sync, serverRevision: sync.conflict.remoteRevision, dirty: true, outbox: undefined, conflict: undefined } satisfies SyncRecord, key);
      }
    };
    localRequest.onsuccess = apply; syncRequest.onsuccess = apply;
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('계정 저장 충돌이 없습니다.'));
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('계정 저장 충돌이 없습니다.'));
  });
  if (generation !== profileGeneration || activeProfile?.id !== profile.id) throw new Error('계정이 바뀌어 저장 충돌 처리를 중단했습니다.');
  if (choice === 'device') await checkpointSave('manual');
  else announceStorage({ state: 'synced', profileId: profile.id, message: '서버 진행을 이 기기에 불러왔습니다.' });
  activeTradeEpoch = normalizeTradeEpoch(selected.tradeEpoch); tradeEpochReady = true;
  return selected;
}
export function checkpointSave(reason: CheckpointReason = 'manual'): Promise<CheckpointResult> {
  const expectedProfile = activeProfile ? { ...activeProfile } : null, expectedGeneration = profileGeneration;
  const operation = checkpointQueue.catch(() => ({ uploaded: false, reason })).then(() => performCheckpoint(reason, expectedProfile, expectedGeneration));
  checkpointQueue = operation; return operation;
}

export type TradeCheckpoint = { profileId: string; generation: number; revision: number; localVersion: number; tradeEpoch: number; savedAt: string; graphIdentity: string };
export type TradeSaveResult = { save: SaveEnvelope; revision: number; tradeEpoch: number };
export type TradeAdoption = { save: SaveEnvelope; newlyApplied: boolean };

/** Freezes the exact clean account save a trade offer is based on. */
export async function checkpointTradeSave(): Promise<TradeCheckpoint> {
  await localWriteQueue.catch(() => {}); await checkpointQueue.catch(() => ({ uploaded: false, reason: 'manual' as const }));
  const profile = activeProfile, generation = profileGeneration;
  if (!profile) throw new Error('포켓몬 거래는 계정에 로그인한 뒤 이용할 수 있습니다.');
  await checkpointSave('manual');
  if (generation !== profileGeneration || activeProfile?.id !== profile.id) throw new Error('계정이 바뀌어 거래 준비를 중단했습니다.');
  const [save, sync] = await Promise.all([readLocal(profileSlot('current', profile)), readSync(syncKey(profile.id))]);
  if (!validRemote(save) || !sync || sync.dirty || sync.outbox || sync.conflict) throw new Error('거래 전에 계정 저장을 서버와 동기화해 주세요.');
  const tradeEpoch = normalizeTradeEpoch(save.tradeEpoch);
  activeTradeEpoch = tradeEpoch;
  return { profileId: profile.id, generation, revision: sync.serverRevision, localVersion: sync.localVersion, tradeEpoch, savedAt: save.savedAt, graphIdentity: computationalGraph(save.graph) };
}

/** Adopts one authoritative completed-trade result exactly once, preserving the prior save. */
export async function adoptTradeResult(result: TradeSaveResult, checkpoint: TradeCheckpoint, tradeId?: string): Promise<TradeAdoption> {
  await localWriteQueue.catch(() => {}); await checkpointQueue.catch(() => ({ uploaded: false, reason: 'manual' as const }));
  const profile = activeProfile;
  if (!profile || profile.id !== checkpoint.profileId || profileGeneration !== checkpoint.generation) throw new Error('거래를 시작한 계정이 더 이상 활성 상태가 아닙니다.');
  if (!validRemote(result.save) || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('거래 결과 저장이 올바르지 않습니다.');
  const resultEpoch = normalizeTradeEpoch(result.tradeEpoch), envelopeEpoch = normalizeTradeEpoch(result.save.tradeEpoch);
  if (resultEpoch !== envelopeEpoch || ![checkpoint.tradeEpoch, checkpoint.tradeEpoch + 1].includes(resultEpoch) || computationalGraph(result.save.graph) !== checkpoint.graphIdentity) throw new Error('거래 결과의 저장 버전 또는 커넥톰이 올바르지 않습니다.');
  const adopted = structuredClone(result.save); unpackSave(adopted, adopted.graph, { allowTradeEpochAdvance: true });
  if (tradeId !== undefined && (!tradeId || tradeId.length > 100)) throw new Error('거래 결과 ID가 올바르지 않습니다.');
  const db = await database(), localKey = profileSlot('current', profile), key = syncKey(profile.id), receiptKey = tradeId ? `account:${profile.id}:trade:${tradeId}` : undefined;
  const adoption = await new Promise<TradeAdoption>((resolve, reject) => {
    const tx = db.transaction([STORE, SYNC_STORE], 'readwrite'), saves = tx.objectStore(STORE), syncs = tx.objectStore(SYNC_STORE);
    const localRequest = saves.get(localKey), syncRequest = syncs.get(key), receiptRequest = receiptKey ? syncs.get(receiptKey) : undefined;
    let chosen: TradeAdoption | undefined;
    const apply = () => {
      if (localRequest.readyState !== 'done' || syncRequest.readyState !== 'done' || (receiptRequest && receiptRequest.readyState !== 'done')) return;
      const local = localRequest.result, sync = syncRequest.result as SyncRecord | undefined;
      const receipt = receiptRequest?.result as TradeReceipt | undefined;
      const localEpoch = validRemote(local) ? normalizeTradeEpoch(local.tradeEpoch) : 0;
      if (receipt) {
        if (!validRemote(local) || localEpoch < resultEpoch || receipt.profileId !== profile.id || receipt.tradeId !== tradeId || receipt.revision !== result.revision || receipt.tradeEpoch !== resultEpoch) { tx.abort(); return; }
        chosen = { save: structuredClone(local), newlyApplied: false }; return;
      }
      if (validRemote(local) && localEpoch === resultEpoch && equivalentSave(local, adopted) && sync?.serverRevision === result.revision && !sync.dirty) {
        chosen = { save: structuredClone(local), newlyApplied: false }; if (receiptKey) syncs.put({ profileId: profile.id, tradeId: tradeId!, revision: result.revision, tradeEpoch: resultEpoch } satisfies TradeReceipt, receiptKey); return;
      }
      if (resultEpoch !== checkpoint.tradeEpoch + 1) { tx.abort(); return; }
      if (!validRemote(local) || !sync || sync.localVersion !== checkpoint.localVersion || sync.serverRevision !== checkpoint.revision
        || sync.dirty || sync.outbox || sync.conflict || localEpoch !== checkpoint.tradeEpoch || local.savedAt !== checkpoint.savedAt) { tx.abort(); return; }
      saves.put(structuredClone(local), profileSlot(`backup-before-trade-${Date.now()}-${requestId()}`, profile));
      saves.put(adopted, localKey);
      syncs.put({ profileId: profile.id, serverRevision: result.revision, localVersion: sync.localVersion + 1, dirty: false } satisfies SyncRecord, key);
      if (receiptKey) syncs.put({ profileId: profile.id, tradeId: tradeId!, revision: result.revision, tradeEpoch: resultEpoch } satisfies TradeReceipt, receiptKey);
      chosen = { save: adopted, newlyApplied: true };
    };
    localRequest.onsuccess = apply; syncRequest.onsuccess = apply; if (receiptRequest) receiptRequest.onsuccess = apply;
    tx.oncomplete = () => chosen ? resolve(chosen) : reject(new Error('거래 결과 저장을 선택하지 못했습니다.'));
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(new Error('거래 준비 뒤 저장이 변경되어 결과를 자동 적용하지 않았습니다. 새로고침하면 서버의 거래 결과를 복구할 수 있습니다.'));
  });
  if (profileGeneration !== checkpoint.generation || activeProfile?.id !== profile.id) throw new Error('계정이 바뀌어 거래 결과 적용을 중단했습니다.');
  activeTradeEpoch = normalizeTradeEpoch(adoption.save.tradeEpoch); tradeEpochReady = true;
  announceStorage({ state: 'synced', profileId: profile.id, message: '거래 결과를 서버 저장과 이 기기에 적용했습니다.' });
  return adoption;
}
export function startCheckpointAutosave(intervalMs = 60_000) {
  const timer = window.setInterval(() => { void checkpointSave('auto').catch(() => {}); }, Math.max(10_000, intervalMs));
  return () => window.clearInterval(timer);
}
export const defaultView = (): ViewState => ({ position: startPosition(), learning: true, learningDefaultsVersion: 1, rewards: {} });
