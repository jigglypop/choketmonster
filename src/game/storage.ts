import { validateGraph, type Graph } from '../core/brain';
import { parseJson } from '../core/json';
import { validateGame, type GameState } from './engine';
import { BRAIN_MODEL } from './connectome';
import { startPosition, tileAt, type MapPosition } from './map';
import { FieldSimulation, type FieldSnapshot } from './field';

export type ViewState = { position: MapPosition; learning: boolean; rewards?: Record<string, number>; field?: FieldSnapshot; fieldPreferences?: { paused: boolean; learning: boolean; selectedId: string } };
export type SaveEnvelope = { format: 'choketmon'; version: 2; model: string; savedAt: string; graph: Graph; game: unknown; view: ViewState };
const monsters = (game: GameState) => [...game.player.team, ...game.player.box, ...(game.battle?.enemy.team ?? []), ...(game.battle?.player.team ?? [])];
const computationalGraph = (graph: Graph) => JSON.stringify({ kind: graph.kind, id: graph.id, nodes: graph.nodes,
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
  if (!view || typeof view.learning !== 'boolean' || !view.position || ![view.position.x, view.position.y, view.position.steps].every(Number.isSafeInteger) || view.position.x < 1 || view.position.x > 22 || view.position.y < 1 || view.position.y > 13 || view.position.steps < 0) throw new Error('탐험 위치가 올바르지 않습니다.');
  if (['tree', 'water', 'building'].includes(tileAt(view.position.x, view.position.y))) throw new Error('탐험할 수 없는 위치입니다.');
  if (view.rewards !== undefined && (!view.rewards || typeof view.rewards !== 'object' || Array.isArray(view.rewards) || Object.entries(view.rewards).some(([id, reward]) => !monsters(game).some(mon => mon.instanceId === id) || !Number.isFinite(reward) || Math.abs(reward) > 100))) throw new Error('신경 학습의 보상 기록이 올바르지 않습니다.');
  if (view.field !== undefined) {
    const field = view.field;
    if (!field || !Array.isArray(field.entities)) throw new Error('들판 기억이 올바르지 않습니다.');
    new FieldSimulation(graph, field.seed, field.entities.map(({ id, speciesId }) => ({ id, speciesId })), field);
  }
  const preferences = view.fieldPreferences;
  if (preferences !== undefined && (!preferences || typeof preferences.paused !== 'boolean' || typeof preferences.learning !== 'boolean' || typeof preferences.selectedId !== 'string')) throw new Error('들판 설정이 올바르지 않습니다.');
  return { game, graph, view };
}

const DATABASE = 'choketmon-151', STORE = 'saves';
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function readSave(): Promise<unknown | undefined> {
  const db = await database();
  try { return await new Promise((resolve, reject) => { const tx = db.transaction(STORE, 'readonly'), request = tx.objectStore(STORE).get('current'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
  finally { db.close(); }
}
let writeQueue: Promise<void> = Promise.resolve();
export function writeSave(save: SaveEnvelope, key = 'current'): Promise<void> {
  const snapshot = structuredClone(save);
  const operation = writeQueue.catch(() => {}).then(async () => {
    const db = await database();
    try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(snapshot, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('저장이 중단되었습니다.')); }); }
    finally { db.close(); }
  });
  writeQueue = operation; return operation;
}
export const defaultView = (): ViewState => ({ position: startPosition(), learning: false, rewards: {} });
