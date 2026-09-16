import { automatedMoveMask, availableMoveMask, ConnectomeController, type NeuralMonster, type BattleSenseContext } from './connectome';
export type ServerDecision = { action: number; updates: number; activity: number; elapsedMs: number; graphId: string; nodes: number; edges: number };
export type ServerBrainReceipt = ServerDecision & { turn: number; learning: boolean };
export type ServerBrainChoice = { self: NeuralMonster; foe: NeuralMonster; turn: number; reward: number | null; learning: boolean; battleId: string; terminal?: boolean; context?: BattleSenseContext };
type ReplayStep = { requestId: string; episodeId: string; inputs: number[]; available: boolean[]; reward: number | null; learning: boolean; terminal: boolean };
type LocalBrain = { checkpoint?: string; checkpointId?: string; history: ReplayStep[]; lastRequestId: string; decision: ServerDecision };
export type TransferableServerBrain = { schema: 1; graphId: string; gameScope: string; state: LocalBrain };
const lastReceipts = new Map<string, ServerBrainReceipt>();
// Hints only: IndexedDB still owns the full durable checkpoint and replay log.
const remoteHeads = new Map<string, string>();
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
const HASH = /^[a-f0-9]{64}$/;
const scopeSeed = (value: string) => value.startsWith('account:') ? value.split(':').slice(2).join(':') : value;
const validDecision = (value: unknown): value is ServerDecision => {
  const row = value as ServerDecision;
  return Boolean(row && Number.isInteger(row.action) && row.action >= 0 && row.action <= 4
    && Number.isSafeInteger(row.updates) && row.updates >= 0 && row.updates <= 1e9
    && Number.isFinite(row.activity) && Math.abs(row.activity) <= 1e9
    && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= 3_600_000
    && typeof row.graphId === 'string' && row.graphId.length <= 200
    && Number.isSafeInteger(row.nodes) && row.nodes >= 2 && row.nodes <= 1_000_000
    && Number.isSafeInteger(row.edges) && row.edges >= 1 && row.edges <= 100_000_000);
};
const validateLocalBrain = (value: unknown): LocalBrain => {
  const state = value as LocalBrain;
  if (!state || typeof state !== 'object' || !Array.isArray(state.history) || state.history.length > 7
    || typeof state.lastRequestId !== 'string' || !HASH.test(state.lastRequestId) || !validDecision(state.decision)
    || (state.checkpoint !== undefined && (typeof state.checkpoint !== 'string' || state.checkpoint.length > 2_100_000))
    || (state.checkpointId !== undefined && (typeof state.checkpointId !== 'string' || !HASH.test(state.checkpointId)))) throw new Error('전송된 포켓몬 회로 기억이 올바르지 않습니다.');
  for (const step of state.history) {
    if (!step || typeof step !== 'object' || !HASH.test(step.requestId) || !HASH.test(step.episodeId)
      || !Array.isArray(step.inputs) || step.inputs.length !== 12 || step.inputs.some(input => !Number.isFinite(input) || Math.abs(input) > 1e9)
      || !Array.isArray(step.available) || step.available.length !== 5 || step.available.some(flag => typeof flag !== 'boolean')
      || (step.reward !== null && (!Number.isFinite(step.reward) || Math.abs(step.reward) > 1e9))
      || typeof step.learning !== 'boolean' || typeof step.terminal !== 'boolean') throw new Error('전송된 포켓몬 회로 재생 기록이 올바르지 않습니다.');
  }
  return {
    checkpoint: state.checkpoint, checkpointId: state.checkpointId, lastRequestId: state.lastRequestId,
    decision: { action: state.decision.action, updates: state.decision.updates, activity: state.decision.activity, elapsedMs: state.decision.elapsedMs,
      graphId: state.decision.graphId, nodes: state.decision.nodes, edges: state.decision.edges },
    history: state.history.map(step => ({ requestId: step.requestId, episodeId: step.episodeId, inputs: step.inputs.slice(), available: step.available.slice(),
      reward: step.reward, learning: step.learning, terminal: step.terminal })),
  };
};

/** A checkpoint and its head ID are one atomic durable lineage. */
function assertCompleteLineage(state: LocalBrain | undefined): void {
  if (state && (state.checkpoint === undefined) !== (state.checkpointId === undefined)) {
    throw new Error('개체의 회로 체크포인트 기록이 불완전합니다. 기존 기억을 보존했으며 자동으로 초기화하지 않았습니다.');
  }
}

/** Exports this device's complete checkpoint and bounded replay history for one individual. */
export function exportTransferableServerBrain(instanceId: string): Promise<TransferableServerBrain | null> {
  const selectedScope = scope, selectedGraph = graphId;
  if (!instanceId || instanceId.length > 100) return Promise.reject(new Error('포켓몬 개체 ID가 올바르지 않습니다.'));
  const operation = operationQueue.catch(() => {}).then(async () => {
    if (!usesServerBrain() || !selectedGraph) return null;
    const clientId = await digest(await deviceId() + ':' + selectedScope + ':' + selectedGraph);
    const key = clientId + ':' + instanceId, saved = (await readBrains([key]))[0];
    if (!saved) return null;
    let state = validateLocalBrain(saved);
    assertCompleteLineage(state);
    if (!state.checkpoint || state.history.length) {
      const response = await fetch('/api/local-brains/checkpoint', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, creatureId: instanceId, lastRequestId: state.lastRequestId, checkpoint: state.checkpoint,
          checkpointId: state.checkpointId, history: state.history }), signal: AbortSignal.timeout(20_000) });
      const body = await response.json().catch(() => ({})) as { checkpoint?: unknown; checkpointId?: unknown; message?: string };
      if (!response.ok) throw new Error(body.message ?? `회로 기억 체크포인트를 만들지 못했습니다. (${response.status})`);
      if (typeof body.checkpoint !== 'string' || body.checkpoint.length > 2_100_000 || body.checkpointId !== state.lastRequestId) throw new Error('회로 기억 체크포인트 응답이 올바르지 않습니다.');
      const compacted = validateLocalBrain({ ...state, checkpoint: body.checkpoint, checkpointId: body.checkpointId, history: [] });
      await saveBrains([{ key, previous: saved.lastRequestId, state: compacted }]); state = compacted;
    }
    return { schema: 1 as const, graphId: selectedGraph, gameScope: selectedScope, state };
  });
  operationQueue = operation; return operation;
}

/** Imports a received brain into the current game/device scope without overwriting unrelated memory. */
export function importTransferableServerBrain(instanceId: string, value: unknown, receiptId?: string): Promise<void> {
  const selectedScope = scope, selectedGraph = graphId;
  if (!instanceId || instanceId.length > 100) return Promise.reject(new Error('포켓몬 개체 ID가 올바르지 않습니다.'));
  if (receiptId !== undefined && (!receiptId || receiptId.length > 100)) return Promise.reject(new Error('거래 회로 영수증 ID가 올바르지 않습니다.'));
  const operation = operationQueue.catch(() => {}).then(async () => {
    if (!usesServerBrain() || !selectedGraph) throw new Error('전체 커넥톰 회로 저장소에 연결되지 않았습니다.');
    const transfer = value as Partial<TransferableServerBrain>;
    if (!transfer || transfer.schema !== 1 || transfer.graphId !== selectedGraph || typeof transfer.gameScope !== 'string' || transfer.gameScope.length > 300
      || !scopeSeed(transfer.gameScope) || (!receiptId && scopeSeed(transfer.gameScope) !== scopeSeed(selectedScope))) throw new Error('현재 모험 범위와 맞지 않는 회로 기억입니다.');
    const state = validateLocalBrain(transfer.state), clientId = await digest(await deviceId() + ':' + selectedScope + ':' + selectedGraph), key = clientId + ':' + instanceId;
    assertCompleteLineage(state);
    if (state.decision.graphId !== selectedGraph) throw new Error('현재 커넥톰과 맞지 않는 회로 기억입니다.');
    const db = await database(), receiptKey = receiptId ? `${clientId}:trade-receipt:${receiptId}` : undefined;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('brains', 'readwrite'), store = tx.objectStore('brains'), brainRequest = store.get(key), receiptRequest = receiptKey ? store.get(receiptKey) : undefined;
      let conflict = false;
      const apply = () => {
        if (brainRequest.readyState !== 'done' || (receiptRequest && receiptRequest.readyState !== 'done')) return;
        const receipt = receiptRequest?.result as { instanceId?: string } | undefined;
        if (receipt) { if (receipt.instanceId !== instanceId) { conflict = true; tx.abort(); } return; }
        const existing = brainRequest.result as LocalBrain | undefined;
        if (existing && JSON.stringify(existing) !== JSON.stringify(state)) { conflict = true; tx.abort(); return; }
        if (!existing) store.put(state, key);
        if (receiptKey) store.put({ instanceId }, receiptKey);
      };
      brainRequest.onsuccess = apply; if (receiptRequest) receiptRequest.onsuccess = apply;
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(conflict ? new Error('받은 포켓몬 ID에 이미 다른 회로 기억이 있습니다. 저장을 덮어쓰지 않았습니다.') : tx.error);
    });
  });
  operationQueue = operation; return operation;
}
async function sendBatch(fullBody: { clientId: string; steps: (ReplayStep & { creatureId: string; checkpoint?: string; checkpointId?: string; history: ReplayStep[]; returnCheckpoint: boolean })[] }) {
  // A reload cannot assume the server still owns this device's checkpoint.
  // Send it on the first turn, then omit it only for an acknowledged warm head.
  let body = { ...fullBody, steps: fullBody.steps.map(({ checkpoint, ...step }) => {
    const head = step.history.at(-1)?.requestId ?? step.checkpointId;
    return checkpoint && remoteHeads.get(fullBody.clientId + ':' + step.creatureId) !== head
      ? { ...step, checkpoint } : step;
  }) };
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
    for (const step of fullBody.steps) {
      const key = fullBody.clientId + ':' + step.creatureId;
      remoteHeads.delete(key); remoteHeads.set(key, step.requestId);
    }
    while (remoteHeads.size > 256) remoteHeads.delete(remoteHeads.keys().next().value!);
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
      saved.forEach(assertCompleteLineage);
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
