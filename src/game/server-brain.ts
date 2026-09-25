import { automatedMoveMask, availableMoveMask, ConnectomeController, type NeuralMonster, type BattleSenseContext } from './connectome';
export type ServerDecision = { action: number; updates: number; activity: number; elapsedMs: number; graphId: string; nodes: number; edges: number };
export type ServerBrainReceipt = ServerDecision & { turn: number; learning: boolean };
export type ServerBrainChoice = { self: NeuralMonster; foe: NeuralMonster; turn: number; reward: number | null; learning: boolean; battleId: string; terminal?: boolean; context?: BattleSenseContext };
type ReplayStep = { requestId: string; episodeId: string; inputs: number[]; available: boolean[]; reward: number | null; learning: boolean; terminal: boolean };
type LocalBrain = { checkpoint?: string; checkpointId?: string; history: ReplayStep[]; lastRequestId: string; lastChoiceId?: string; decision: ServerDecision };
export type TransferableServerBrain = { schema: 1; graphId: string; gameScope: string; state: LocalBrain };
const lastReceipts = new Map<string, ServerBrainReceipt>();
/** Display hints for recent battlers; every wild opponent adds one, so keep the newest only. */
const RECEIPT_LIMIT = 256;
function rememberReceipt(id: string, receipt: ServerBrainReceipt) {
  lastReceipts.delete(id); lastReceipts.set(id, receipt);
  while (lastReceipts.size > RECEIPT_LIMIT) lastReceipts.delete(lastReceipts.keys().next().value!);
}
// Hints only: IndexedDB still owns the full durable checkpoint and replay log.
const remoteHeads = new Map<string, string>();
export const lastServerDecision = (id: string) => lastReceipts.get(id);
let enabled = false, graphId = '', scope = 'default';
export type ServerConnectomeInfo = { available: boolean; graphId?: string; kind?: string; nodes?: number; edges?: number; activeEdges?: number };
let connectomeInfo: ServerConnectomeInfo | null = null;
export const getServerConnectomeInfo = () => connectomeInfo;
let connection: Promise<IDBDatabase> | undefined;
let operationQueue: Promise<unknown> = Promise.resolve();
export function setServerBrainScope(gameSeed: string) { scope = gameSeed; lastReceipts.clear(); }
export async function initializeServerBrain() {
  connectomeInfo = null;
  try {
    const response = await fetch('/api/connectome', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const info = await response.json(); enabled = response.ok && info.available === true;
    graphId = enabled ? info.graphId : '';
    if (response.ok) connectomeInfo = info;
  } catch { enabled = false; graphId = ''; }
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
/** A small last-use stamp beside each checkpoint lets the cache be trimmed without reading the large records. */
const touchKey = (key: string) => `touch:${key}`;
async function saveBrains(entries: { key: string; previous?: string; state: LocalBrain }[]) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('brains', 'readwrite'), store = tx.objectStore('brains'); let conflict = false;
    for (const entry of entries) {
      const read = store.get(entry.key);
      read.onsuccess = () => {
        if ((read.result as LocalBrain | undefined)?.lastRequestId !== entry.previous) { conflict = true; tx.abort(); }
        else { store.put(entry.state, entry.key); store.put(Date.now(), touchKey(entry.key)); }
      };
    }
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(conflict ? new Error('다른 탭에서 이 개체가 진행됐습니다. 새로고침해 최신 기억을 불러오세요.') : tx.error);
  });
}
const HASH = /^[a-f0-9]{64}$/;
/** How long one neural batch keeps retrying through a busy server, timeouts and gateway errors before it fails. */
const BATCH_RETRY_MS = 60_000;
/** The server allows one neural computation per address at a time and answers 429 while busy. */
const retryableStatus = (status: number) => status === 429 || status === 502 || status === 503 || status === 504;
const retryPause = (attempt: number) => new Promise(resolve => setTimeout(resolve, Math.min(4000, 250 * 2 ** attempt)));
/** Building a checkpoint is a pure computation from the sent lineage, so it is safe to resend while the server is busy. */
async function postCheckpoint(payload: string) {
  const deadline = Date.now() + BATCH_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch('/api/local-brains/checkpoint', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' },
        body: payload, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      if (Date.now() < deadline) { await retryPause(attempt); continue; }
      throw error;
    }
    const body = await response.json().catch(() => ({})) as { checkpoint?: unknown; checkpointId?: unknown; message?: string };
    if (retryableStatus(response.status) && Date.now() < deadline) { await retryPause(attempt); continue; }
    return { response, body };
  }
}
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
    || typeof state.lastRequestId !== 'string' || !HASH.test(state.lastRequestId)
    || (state.lastChoiceId !== undefined && (typeof state.lastChoiceId !== 'string' || !HASH.test(state.lastChoiceId))) || !validDecision(state.decision)
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
    checkpoint: state.checkpoint, checkpointId: state.checkpointId, lastRequestId: state.lastRequestId, lastChoiceId: state.lastChoiceId,
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
      const { response, body } = await postCheckpoint(JSON.stringify({ clientId, creatureId: instanceId, lastRequestId: state.lastRequestId, checkpoint: state.checkpoint,
        checkpointId: state.checkpointId, history: state.history }));
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
        // Stamp it now: the received individual joins the save only after the trade result is adopted.
        store.put(Date.now(), touchKey(key));
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
  // The server answers a repeated requestId with its committed response, so waiting and resending is safe.
  // A batch the client stopped waiting for keeps running there and makes this client busy (429) until it ends.
  const deadline = Date.now() + BATCH_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch('/api/local-brains/step-batch', { method: 'POST', credentials: 'omit',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (Date.now() < deadline) { await retryPause(attempt); continue; }
      throw error;
    }
    const value = await response.json().catch(() => ({}));
    if (response.status === 428 && !restored && fullBody.steps.some(step => step.checkpoint)) {
      body = fullBody; restored = true; continue;
    }
    if (retryableStatus(response.status) && Date.now() < deadline) { await retryPause(attempt); continue; }
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
    const requests = await Promise.all(choices.map(async (choice, index) => {
      const episodeId = await digest(choice.battleId);
      const inputs = controller.observe(choice.self, choice.foe, choice.turn, choice.context);
      const available = choice.context?.automatic ? automatedMoveMask(choice.self, choice.foe, choice.turn, choice.context) : availableMoveMask(choice.self);
      const identity = JSON.stringify({ battleId: choice.battleId, creatureId: choice.self.instanceId, turn: choice.turn,
        terminal: choice.terminal ?? false, inputs, available, reward: choice.reward, learning: choice.learning });
      const choiceId = await digest(clientId + ':' + identity);
      // Reusing a battle/turn tuple later must create a new replay node. Tying the
      // request to its durable parent keeps the node unique, while lastChoiceId
      // makes an immediate retry resolve to the already committed response.
      const previous = saved[index];
      const requestId = previous?.lastChoiceId === choiceId || (!previous?.lastChoiceId && previous?.lastRequestId === choiceId)
        ? previous.lastRequestId
        : previous ? await digest(choiceId + ':' + previous.lastRequestId) : choiceId;
      return {
        requestId, choiceId, episodeId, inputs, available,
        reward: choice.reward, learning: choice.learning, terminal: choice.terminal ?? false,
      };
    }));
    const missing = choices.map((_, index) => index).filter(index => saved[index]?.lastRequestId !== requests[index].requestId);
    if (missing.length) {
      saved.forEach(assertCompleteLineage);
      const response = await sendBatch({ clientId, steps: missing.map(index => ({
        creatureId: choices[index].self.instanceId, requestId: requests[index].requestId, episodeId: requests[index].episodeId,
        inputs: requests[index].inputs, available: requests[index].available, reward: requests[index].reward,
        learning: requests[index].learning, terminal: requests[index].terminal, checkpoint: saved[index]?.checkpoint,
        checkpointId: saved[index]?.checkpointId, history: saved[index]?.history ?? [],
        returnCheckpoint: requests[index].terminal || (saved[index]?.history.length ?? 0) >= 7,
      })) });
      if (!Array.isArray(response.decisions) || response.decisions.length !== missing.length) throw new Error('서버 회로 응답 개수가 다릅니다.');
      const entries = missing.map(index => {
        const row = response.decisions.find(row => row.creatureId === choices[index].self.instanceId && row.requestId === requests[index].requestId), decision = row?.decision;
        if (!decision || !Number.isInteger(decision.action) || decision.action < 0 || decision.action > 4 || !Number.isFinite(decision.activity) || decision.graphId !== graphId || (!requests[index].terminal && !requests[index].available[decision.action])) throw new Error('서버 회로 응답을 확인할 수 없습니다.');
        const previous = saved[index];
        const state: LocalBrain = row?.checkpoint
          ? { checkpoint: row.checkpoint, checkpointId: requests[index].requestId, history: [], lastRequestId: requests[index].requestId, lastChoiceId: requests[index].choiceId, decision }
          : { checkpoint: previous?.checkpoint, checkpointId: previous?.checkpointId,
            history: [...(previous?.history ?? []), {
              requestId: requests[index].requestId, episodeId: requests[index].episodeId, inputs: requests[index].inputs,
              available: requests[index].available, reward: requests[index].reward, learning: requests[index].learning, terminal: requests[index].terminal,
            }], lastRequestId: requests[index].requestId, lastChoiceId: requests[index].choiceId, decision };
        if (state.history.length > 7) throw new Error('전체 회로 체크포인트가 누락됐습니다.');
        return { key: keys[index], previous: previous?.lastRequestId, state };
      });
      await saveBrains(entries);
      for (const entry of entries) saved[keys.indexOf(entry.key)] = entry.state;
    }
    return choices.map((choice, index) => {
      const decision = saved[index]!.decision;
      rememberReceipt(choice.self.instanceId, { ...decision, turn: choice.turn, learning: choice.learning });
      return decision;
    });
  });
  operationQueue = operation; return operation;
}
export function chooseServerBrain(controller: ConnectomeController, self: NeuralMonster, foe: NeuralMonster, turn: number,
  reward: number | null, learning: boolean, battleId: string, terminal = false, context?: BattleSenseContext): Promise<ServerDecision> {
  return chooseServerBrains(controller, [{ self, foe, turn, reward, learning, battleId, terminal, context }]).then(decisions => decisions[0]);
}

/** Checkpoint records are keyed `clientId:instanceId`; trade receipts and stamps have other shapes. */
const BRAIN_RECORD = /^[a-f0-9]{64}:[^:]+$/;
/** Records touched this recently are kept even when the save does not list them yet, such as a brain received by trade. */
const BRAIN_GRACE_MS = 10 * 60_000;
const MAX_BRAIN_RECORDS = 256;
/**
 * Removes checkpoints of individuals the current save no longer holds, such as wild opponents after their battle,
 * then trims the least recently used records of other saves while the cache is over its cap.
 * Individuals the save holds are never removed.
 */
export function pruneServerBrains(expectedScope: string, liveInstanceIds: Iterable<string>): Promise<number> {
  const live = new Set(liveInstanceIds);
  const operation = operationQueue.catch(() => {}).then(async () => {
    if (!usesServerBrain() || !graphId || expectedScope !== scope) return 0;
    for (const id of [...lastReceipts.keys()]) if (!live.has(id)) lastReceipts.delete(id);
    const prefix = await digest(await deviceId() + ':' + scope + ':' + graphId) + ':', db = await database(), now = Date.now();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction('brains', 'readwrite'), store = tx.objectStore('brains'), stamps = IDBKeyRange.bound('touch:', 'touch:\uffff');
      const keysRequest = store.getAllKeys(), stampKeysRequest = store.getAllKeys(stamps), stampsRequest = store.getAll(stamps);
      let removed = 0;
      const decide = () => {
        if ([keysRequest, stampKeysRequest, stampsRequest].some(request => request.readyState !== 'done')) return;
        const touched = new Map((stampKeysRequest.result as string[]).map((key, index) => [key.slice('touch:'.length), Number(stampsRequest.result[index]) || 0]));
        const records = (keysRequest.result as IDBValidKey[]).filter((key): key is string => typeof key === 'string' && BRAIN_RECORD.test(key));
        const held = (key: string) => key.startsWith(prefix) && live.has(key.slice(prefix.length));
        const idle = (key: string) => now - (touched.get(key) ?? 0) > BRAIN_GRACE_MS;
        const doomed = new Set(records.filter(key => key.startsWith(prefix) && !held(key) && idle(key)));
        const kept = records.filter(key => !doomed.has(key));
        if (kept.length > MAX_BRAIN_RECORDS) {
          const oldest = kept.filter(key => !held(key) && idle(key)).sort((a, b) => (touched.get(a) ?? 0) - (touched.get(b) ?? 0) || a.localeCompare(b));
          for (const key of oldest.slice(0, kept.length - MAX_BRAIN_RECORDS)) doomed.add(key);
        }
        for (const key of doomed) { store.delete(key); store.delete(touchKey(key)); }
        const present = new Set(records);
        for (const key of touched.keys()) if (!present.has(key)) store.delete(touchKey(key));
        removed = doomed.size;
      };
      keysRequest.onsuccess = decide; stampKeysRequest.onsuccess = decide; stampsRequest.onsuccess = decide;
      tx.oncomplete = () => resolve(removed); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  });
  operationQueue = operation; return operation;
}
