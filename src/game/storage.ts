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
  if (view.openWorld !== undefined) new OpenWorldSimulation(graph, game, view.openWorld.seed, view.openWorld);
  return { game, graph, view: view.learningDefaultsVersion === undefined ? { ...view, learning: true, learningDefaultsVersion: 1 } : view };
}

const DATABASE = 'choketmon-151', STORE = 'saves', SYNC_STORE = 'server-sync';
export type SaveStorageStatus = { state: 'local'; profileId: 'device'; message?: string };
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
let legacyMigration: Promise<unknown | undefined> | undefined;
async function migrateActiveAccountSave(key: string): Promise<unknown | undefined> {
  if (key !== 'current') return undefined;
  legacyMigration ??= (async () => {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(2000) });
      if (!response.ok) return undefined;
      const body = await response.json() as { user?: { id?: string } | null }, id = body.user?.id;
      if (!id) return undefined;
      const legacy = await readLocal(`account:${id}:current`);
      if (legacy !== undefined && await readLocal('current') === undefined) await writeLocal('current', legacy);
      return legacy;
    } catch { return undefined; }
  })();
  return legacyMigration;
}
export async function readSave(key = 'current'): Promise<unknown | undefined> {
  const local = await readLocal(key);
  if (local !== undefined) { announceStorage({ state: 'local', profileId: 'device' }); return local; }
  const migrated = await migrateActiveAccountSave(key);
  announceStorage({ state: 'local', profileId: 'device', message: migrated === undefined ? undefined : '이 기기의 기존 모험을 이어받았습니다.' });
  return migrated;
}
let localWriteQueue: Promise<void> = Promise.resolve();
export function writeSave(save: SaveEnvelope, key = 'current'): Promise<void> {
  const snapshot = structuredClone(save), slot = key === 'current' || /-\d{13}$/.test(key) ? key : `${key}-${Date.now()}`;
  const operation = localWriteQueue.catch(() => {}).then(async () => {
    await writeLocal(slot, snapshot);
    announceStorage({ state: 'local', profileId: 'device' });
  });
  localWriteQueue = operation; return operation;
}
export const defaultView = (): ViewState => ({ position: startPosition(), learning: true, learningDefaultsVersion: 1, rewards: {} });
