import { automatedMoveMask, availableMoveMask, ConnectomeController, type NeuralMonster, type BattleSenseContext } from './connectome';
export type ServerDecision = { action: number; updates: number; activity: number; elapsedMs: number; graphId: string; nodes: number; edges: number };
export type ServerBrainReceipt = ServerDecision & { turn: number; learning: boolean };
export type ServerBrainChoice = { self: NeuralMonster; foe: NeuralMonster; turn: number; reward: number | null; learning: boolean; battleId: string; terminal?: boolean; context?: BattleSenseContext };
type ReplayStep = { requestId: string; episodeId: string; inputs: number[]; available: boolean[]; reward: number | null; learning: boolean; terminal: boolean };
type LocalBrain = { checkpoint?: string; checkpointId?: string; history: ReplayStep[]; lastRequestId: string; decision: ServerDecision };
const lastReceipts = new Map<string, ServerBrainReceipt>();
export const lastServerDecision = (id: string) => lastReceipts.get(id);
let enabled = false, graphId = '', scope = 'default';
let connection: Promise<IDBDatabase> | undefined;
let operationQueue: Promise<unknown> = Promise.resolve();
export function setServerBrainScope(gameSeed: string) { scope = gameSeed; lastReceipts.clear(); }
export async function initializeServerBrain() {
  try {
    const response = await fetch('/api/connectome', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const info = await response.json(); enabled = response.ok && info.available === true;
    graphId = enabled ? info.graphId : '';
  } catch { enabled = false; }
  return enabled;
}
export function usesServerBrain() { return enabled; }
function database(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('choketmon-neural-cache', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('brains');
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); connection = undefined; }; resolve(db); };
  });
  return connection;
}
async function deviceId(): Promise<string> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('brains', 'readwrite'), store = tx.objectStore('brains'), request = store.get('device-id');
    let id: string;
    request.onsuccess = () => { id = request.result ?? crypto.randomUUID(); if (!request.result) store.put(id, 'device-id'); };
    tx.oncomplete = () => resolve(id); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
async function digest(key: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map(v => v.toString(16).padStart(2, '0')).join('');
}
async function readBrains(keys: string[]): Promise<(LocalBrain | undefined)[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('brains', 'readonly'), store = tx.objectStore('brains'), requests = keys.map(key => store.get(key));
    tx.oncomplete = () => resolve(requests.map(request => request.result)); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
async function saveBrains(entries: { key: string; previous?: string; state: LocalBrain }[]) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('brains', 'readwrite'), store = tx.objectStore('brains'); let conflict = false;
    for (const entry of entries) {
      const read = store.get(entry.key);
      read.onsuccess = () => {
        if ((read.result as LocalBrain | undefined)?.lastRequestId !== entry.previous) { conflict = true; tx.abort(); }
        else store.put(entry.state, entry.key);
      };
    }
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(conflict ? new Error('다른 탭에서 이 개체가 진행됐습니다. 새로고침해 최신 기억을 불러오세요.') : tx.error);
  });
}
async function sendBatch(fullBody: { clientId: string; steps: ({ checkpoint?: string } & Record<string, unknown>)[] }) {
  // Warm-cache turns send only the checkpoint ID and short replay log. Restore the
  // large checkpoint once only when the server explicitly reports an evicted cache.
  let body = { ...fullBody, steps: fullBody.steps.map(({ checkpoint: _checkpoint, ...step }) => step) };
  let restored = false;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('/api/local-brains/step-batch', { method: 'POST', credentials: 'omit',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const value = await response.json().catch(() => ({}));
    if (response.status === 428 && !restored && fullBody.steps.some(step => step.checkpoint)) {
      body = fullBody; restored = true; continue;
    }
    if (response.status === 429 && attempt < 3) { await new Promise(resolve => setTimeout(resolve, 120 * (attempt + 1))); continue; }
    if (!response.ok) throw new Error(value.message ?? '서버 회로 오류 (' + response.status + ')');
    return value as { decisions: { creatureId: string; requestId: string; decision: ServerDecision; checkpoint?: string }[] };
  }
}
/** IndexedDB checkpoints plus bounded exact replay logs own the durable neural state. */
export function chooseServerBrains(controller: ConnectomeController, choices: ServerBrainChoice[]): Promise<ServerDecision[]> {
  const selectedScope = scope;
  const operation = operationQueue.catch(() => {}).then(async () => {
    if (!usesServerBrain()) throw new Error('전체 회로 서버에 연결하지 못했습니다.');
    if (!choices.length || choices.length > 2) throw new Error('한 번에 1~2개 회로를 요청할 수 있습니다.');
    const clientId = await digest(await deviceId() + ':' + selectedScope + ':' + graphId);
    const keys = choices.map(choice => clientId + ':' + choice.self.instanceId), saved = await readBrains(keys);
    const requests = await Promise.all(choices.map(async choice => ({
      requestId: await digest(clientId + ':' + choice.battleId + ':' + choice.self.instanceId + ':' + choice.turn + ':' + (choice.terminal ? 'finish' : 'act')),
      episodeId: await digest(choice.battleId), inputs: controller.observe(choice.self, choice.foe, choice.turn, choice.context),
      available: choice.context?.automatic ? automatedMoveMask(choice.self, choice.foe, choice.turn, choice.context) : availableMoveMask(choice.self),
      reward: choice.reward, learning: choice.learning, terminal: choice.terminal ?? false,
    })));
    const missing = choices.map((_, index) => index).filter(index => saved[index]?.lastRequestId !== requests[index].requestId);
    if (missing.length) {
      const response = await sendBatch({ clientId, steps: missing.map(index => ({
        creatureId: choices[index].self.instanceId, ...requests[index], checkpoint: saved[index]?.checkpoint,
        checkpointId: saved[index]?.checkpointId, history: saved[index]?.history ?? [],
        returnCheckpoint: requests[index].terminal || (saved[index]?.history.length ?? 0) >= 7,
      })) });
      if (!Array.isArray(response.decisions) || response.decisions.length !== missing.length) throw new Error('서버 회로 응답 개수가 다릅니다.');
      const entries = missing.map(index => {
        const row = response.decisions.find(row => row.creatureId === choices[index].self.instanceId && row.requestId === requests[index].requestId), decision = row?.decision;
        if (!decision || !Number.isInteger(decision.action) || decision.action < 0 || decision.action > 4 || !Number.isFinite(decision.activity) || decision.graphId !== graphId || (!requests[index].terminal && !requests[index].available[decision.action])) throw new Error('서버 회로 응답을 확인할 수 없습니다.');
        const previous = saved[index];
        const state: LocalBrain = row?.checkpoint
          ? { checkpoint: row.checkpoint, checkpointId: requests[index].requestId, history: [], lastRequestId: requests[index].requestId, decision }
          : { checkpoint: previous?.checkpoint, checkpointId: previous?.checkpointId, history: [...(previous?.history ?? []), requests[index]], lastRequestId: requests[index].requestId, decision };
        if (state.history.length > 7) throw new Error('전체 회로 체크포인트가 누락됐습니다.');
        return { key: keys[index], previous: previous?.lastRequestId, state };
      });
      await saveBrains(entries);
      for (const entry of entries) saved[keys.indexOf(entry.key)] = entry.state;
    }
    return choices.map((choice, index) => {
      const decision = saved[index]!.decision;
      lastReceipts.set(choice.self.instanceId, { ...decision, turn: choice.turn, learning: choice.learning });
      return decision;
    });
  });
  operationQueue = operation; return operation;
}
export function chooseServerBrain(controller: ConnectomeController, self: NeuralMonster, foe: NeuralMonster, turn: number,
  reward: number | null, learning: boolean, battleId: string, terminal = false, context?: BattleSenseContext): Promise<ServerDecision> {
  return chooseServerBrains(controller, [{ self, foe, turn, reward, learning, battleId, terminal, context }]).then(decisions => decisions[0]);
}
