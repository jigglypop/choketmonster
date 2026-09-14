import type { Graph } from '../core/brain';
import { getSpecies } from '../data/pokemon';
import type { User } from './account';
import type { GameState, Monster } from './engine';
import { exportTransferableServerBrain, importTransferableServerBrain } from './server-brain';
import { adoptTradeResult, checkpointTradeSave, unpackSave, type SaveEnvelope, type TradeCheckpoint } from './storage';
import './trade.css';

type TradeStatus = 'waiting' | 'active' | 'completed' | 'cancelled' | 'expired';
type TradeOffer = { monster: null | { instanceId: string; speciesId: number; nickname: string; level: number }; money: number };
type Participant = { side: 'creator' | 'joiner'; user: User; confirmed: boolean; offer: TradeOffer };
type TradeResult = { revision: number; tradeEpoch: number; save: SaveEnvelope; incomingNeural: null | { instanceId: string; neural: unknown } };
type TradeRoom = { id: string; code?: string; status: TradeStatus; version: number; expiresAt: string; participants: Participant[]; result?: TradeResult };

export type TradePanelOptions = {
  container: HTMLElement;
  game: () => GameState;
  graph: () => Graph;
  currentAccount: () => User | null;
  /** Pause and settle simulations, then write the exact current save. */
  prepare: () => Promise<void>;
  applied: (save: SaveEnvelope) => void | Promise<void>;
  notify?: (message: string, error?: boolean) => void;
  openAccount?: () => void;
  /** Called only when no commit is uncertain and the paused game may safely resume. */
  closed?: (outcome: 'no-trade' | 'cancelled' | 'completed') => void;
};

const jsonRequest = async <T>(path: string, user: User, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000), ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), 'x-choketmon-profile': user.id, ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({})) as T & { message?: string; code?: string };
  if (!response.ok) {
    const error = new Error(body.message || (response.status === 410 ? '거래 시간이 만료되었습니다.' : `거래 서버 오류 (${response.status})`));
    error.name = body.code || `HTTP_${response.status}`; throw error;
  }
  return body;
};
const validRoom = (value: unknown): TradeRoom => {
  const room = value as TradeRoom;
  if (!room || typeof room.id !== 'string' || !room.id || !['waiting', 'active', 'completed', 'cancelled', 'expired'].includes(room.status)
    || !Number.isSafeInteger(room.version) || room.version < 0 || typeof room.expiresAt !== 'string' || !Array.isArray(room.participants) || room.participants.length > 2) throw new Error('거래 서버 응답이 올바르지 않습니다.');
  for (const participant of room.participants) {
    if (!participant?.user || typeof participant.user.id !== 'string' || typeof participant.user.username !== 'string' || typeof participant.confirmed !== 'boolean'
      || !participant.offer || !Number.isSafeInteger(participant.offer.money) || participant.offer.money < 0) throw new Error('거래 참가자 정보가 올바르지 않습니다.');
    const monster = participant.offer.monster;
    if (monster && (typeof monster.instanceId !== 'string' || !Number.isSafeInteger(monster.speciesId) || typeof monster.nickname !== 'string' || !Number.isInteger(monster.level))) throw new Error('거래 포켓몬 정보가 올바르지 않습니다.');
  }
  return room;
};
const responseRoom = (body: unknown) => validRoom((body as { trade?: unknown })?.trade);
const money = (value: number) => `₩${value.toLocaleString('ko-KR')}`;
const optionLabel = (monster: Monster) => `${monster.nickname} · ${getSpecies(monster.speciesId).name} · Lv.${monster.level} · ${monster.instanceId}`;

export function mountTradePanel(options: TradePanelOptions) {
  const host = options.container;
  host.insertAdjacentHTML('beforeend', `<dialog class="trade-dialog"><div class="trade-card">
    <div class="trade-heading"><div><span class="kicker">TRAINER TRADE</span><h2>포켓몬·용돈 교환</h2></div><button type="button" class="trade-close" aria-label="닫기">×</button></div>
    <p class="trade-guide">박스의 포켓몬 한 마리와 게임 안 용돈을 교환합니다. 두 사람이 같은 내용을 확인해야 거래가 완료됩니다.</p>
    <section class="trade-login" hidden><strong>계정 연결이 필요합니다.</strong><p>거래 상대를 확인하고 저장을 안전하게 바꾸기 위해 로그인해 주세요.</p><button type="button" data-login>계정 연결 열기</button></section>
    <section class="trade-lobby"><button type="button" class="primary" data-create>초대 코드 만들기</button><form data-join><label>초대 코드<input name="code" autocomplete="off" maxlength="12" spellcheck="false" required></label><button type="submit">코드로 참가</button></form></section>
    <section class="trade-room" hidden><div class="trade-code" hidden><span>초대 코드</span><strong data-code></strong><button type="button" data-copy>복사</button></div><p class="trade-state" aria-live="polite"></p>
      <div class="trade-previews"><article data-own></article><article data-other></article></div>
      <form class="trade-offer"><label>박스 포켓몬<select name="monster"><option value="">포켓몬 없이 용돈만</option></select></label><label>보낼 용돈<input name="money" type="number" min="0" step="1" value="0"></label><button type="submit">제안 저장</button></form>
      <div class="trade-actions"><button type="button" class="primary" data-confirm>이 내용으로 확인</button><button type="button" data-cancel>거래 취소</button><button type="button" data-retry hidden>상태 다시 확인</button></div>
    </section><p class="trade-error" role="alert" hidden></p>
  </div></dialog>`);
  const dialog = host.querySelector<HTMLDialogElement>('.trade-dialog')!, login = dialog.querySelector<HTMLElement>('.trade-login')!, lobby = dialog.querySelector<HTMLElement>('.trade-lobby')!, roomSection = dialog.querySelector<HTMLElement>('.trade-room')!;
  const error = dialog.querySelector<HTMLElement>('.trade-error')!, stateText = dialog.querySelector<HTMLElement>('.trade-state')!, codeBox = dialog.querySelector<HTMLElement>('.trade-code')!, codeText = dialog.querySelector<HTMLElement>('[data-code]')!;
  const offerForm = dialog.querySelector<HTMLFormElement>('.trade-offer')!, monsterSelect = offerForm.elements.namedItem('monster') as HTMLSelectElement, moneyInput = offerForm.elements.namedItem('money') as HTMLInputElement;
  const confirmButton = dialog.querySelector<HTMLButtonElement>('[data-confirm]')!, cancelButton = dialog.querySelector<HTMLButtonElement>('[data-cancel]')!, retryButton = dialog.querySelector<HTMLButtonElement>('[data-retry]')!;
  let trade: TradeRoom | undefined, checkpoint: TradeCheckpoint | undefined, ignoredTerminalId: string | undefined,
    pollTimer = 0, reconnectTimer = 0, reconnectDelay = 1_000, socket: WebSocket | undefined,
    disposed = false, busy = false, applyingResult = false, polling = false, pollAgain = false, sessionId = 0;
  const account = () => options.currentAccount();
  const setError = (failure?: unknown) => { error.hidden = !failure; error.textContent = failure ? (failure instanceof Error ? failure.message : String(failure)) : ''; if (failure) options.notify?.(error.textContent, true); };
  const setBusy = (value: boolean) => { busy = value; for (const button of dialog.querySelectorAll<HTMLButtonElement>('button')) button.disabled = value; monsterSelect.disabled = value; moneyInput.disabled = value; };
  const stopLive = () => { if (pollTimer) window.clearTimeout(pollTimer); if (reconnectTimer) window.clearTimeout(reconnectTimer); pollTimer = 0; reconnectTimer = 0; if (socket) { const current = socket; socket = undefined; current.close(); } };
  const terminal = (status: TradeStatus) => ['completed', 'cancelled', 'expired'].includes(status);
  const acceptRoom = (next: TradeRoom) => {
    if (trade?.id === next.id && (next.version < trade.version || (terminal(trade.status) && !terminal(next.status)))) return trade;
    trade = next; return trade;
  };
  const finish = (outcome: 'no-trade' | 'cancelled' | 'completed') => {
    sessionId++; trade = undefined; checkpoint = undefined; stopLive(); dialog.close(); options.closed?.(outcome);
  };
  const participantCard = (element: HTMLElement, title: string, participant?: Participant) => {
    element.replaceChildren(); const heading = document.createElement('h3'); heading.textContent = title; element.append(heading);
    if (!participant) { const p = document.createElement('p'); p.textContent = '상대를 기다리는 중입니다.'; element.append(p); return; }
    const name = document.createElement('strong'); name.textContent = participant.user.username; element.append(name);
    const mon = document.createElement('p'); mon.textContent = participant.offer.monster
      ? `${participant.offer.monster.nickname} · ${getSpecies(participant.offer.monster.speciesId).name} · Lv.${participant.offer.monster.level} · ${participant.offer.monster.instanceId}` : '포켓몬 없음'; element.append(mon);
    const cash = document.createElement('p'); cash.textContent = `용돈 ${money(participant.offer.money)}`; element.append(cash);
    const confirmed = document.createElement('span'); confirmed.className = participant.confirmed ? 'is-confirmed' : ''; confirmed.textContent = participant.confirmed ? '확인 완료' : '확인 전'; element.append(confirmed);
  };
  const render = () => {
    const user = account(), own = trade?.participants.find(item => item.user.id === user?.id), other = trade?.participants.find(item => item.user.id !== user?.id);
    login.hidden = Boolean(user); lobby.hidden = !user || Boolean(trade); roomSection.hidden = !trade;
    if (!trade) return;
    codeBox.hidden = !trade.code; codeText.textContent = trade.code ?? '';
    participantCard(dialog.querySelector('[data-own]')!, '내 제안', own); participantCard(dialog.querySelector('[data-other]')!, '상대 제안', other);
    const labels: Record<TradeStatus, string> = { waiting: '상대가 초대 코드로 들어오기를 기다립니다.', active: '제안을 고른 뒤 두 사람이 확인해 주세요.', completed: '거래가 완료되었습니다. 결과를 안전하게 적용하는 중입니다.', cancelled: '취소된 거래입니다.', expired: '시간이 만료된 거래입니다.' };
    stateText.textContent = `${labels[trade.status]} · ${new Date(trade.expiresAt).toLocaleTimeString('ko-KR')}까지`;
    const editable = trade.status === 'active' || trade.status === 'waiting'; offerForm.hidden = !editable; confirmButton.hidden = trade.status !== 'active'; cancelButton.hidden = !editable; retryButton.hidden = !['completed'].includes(trade.status);
    if (own) confirmButton.textContent = own.confirmed ? '확인 취소는 제안을 바꾸세요' : '이 내용으로 확인';
  };
  const fillBox = () => {
    monsterSelect.replaceChildren(new Option('포켓몬 없이 용돈만', ''));
    for (const monster of options.game().player.box) monsterSelect.add(new Option(optionLabel(monster), monster.instanceId));
    moneyInput.max = String(options.game().player.money);
  };
  const applyCompleted = async (room: TradeRoom) => {
    if (applyingResult || !checkpoint) return;
    applyingResult = true;
    try {
      const user = account(); if (!user) throw new Error('거래 결과를 받을 계정 연결이 끊겼습니다.');
      const result = room.result ?? (await jsonRequest<{ result: TradeResult }>(`/api/trades/${encodeURIComponent(room.id)}/result`, user)).result;
      if (!result?.save) throw new Error('완료된 거래 결과가 아직 준비되지 않았습니다.');
      const decoded = unpackSave(result.save, options.graph(), { allowTradeEpochAdvance: true });
      if (result.incomingNeural && ![...decoded.game.player.team, ...decoded.game.player.box].some(monster => monster.instanceId === result.incomingNeural!.instanceId)) throw new Error('받은 회로 기억에 대응하는 포켓몬이 거래 결과에 없습니다.');
      const adoption = await adoptTradeResult(result, checkpoint, room.id);
      if (result.incomingNeural) await importTransferableServerBrain(result.incomingNeural.instanceId, result.incomingNeural.neural, room.id);
      if (adoption.newlyApplied) {
        await options.applied(adoption.save); options.notify?.('거래가 완료되어 새 포켓몬과 용돈을 적용했습니다.'); finish('completed');
      } else {
        ignoredTerminalId = room.id; trade = undefined; setError(); render();
      }
    } finally { applyingResult = false; }
  };
  const pollOnce = async () => {
    stopPollingOnly(); if (disposed || !dialog.open || !account() || !checkpoint) return;
    const expectedSession = sessionId, user = account()!;
    try {
      const body = await jsonRequest<{ trade?: TradeRoom | null }>('/api/trades/current', user);
      if (expectedSession !== sessionId || disposed || !dialog.open) return;
      if (!body.trade) { if (trade && !['cancelled', 'expired'].includes(trade.status)) throw new Error('진행 중인 거래를 서버에서 찾지 못했습니다. 다시 확인해 주세요.'); trade = undefined; render(); return; }
      const next = validRoom(body.trade);
      if (next.id === ignoredTerminalId) { trade = undefined; render(); return; }
      if (!trade && (next.status === 'cancelled' || next.status === 'expired')) { ignoredTerminalId = next.id; render(); return; }
      const current = acceptRoom(next); setError(); render();
      if (current.status === 'completed') await applyCompleted(current);
    } catch (failure) {
      if (expectedSession !== sessionId || disposed || !dialog.open) return;
      if (failure instanceof Error && failure.name === 'TRADE_EXPIRED' && trade) { trade.status = 'expired'; render(); }
      setError(failure); retryButton.hidden = false;
    }
    if (!disposed && dialog.open && trade && !terminal(trade.status) && socket?.readyState !== WebSocket.OPEN) pollTimer = window.setTimeout(() => void poll(), 5_000);
  };
  const poll = async () => {
    if (polling) { pollAgain = true; return; }
    polling = true;
    try { await pollOnce(); }
    finally {
      polling = false;
      if (pollAgain && !disposed && dialog.open) { pollAgain = false; void poll(); }
    }
  };
  const connectLive = () => {
    const user = account(); if (!user || disposed || !dialog.open) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    const expectedSession = sessionId, protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/api/trades/live?profile=${encodeURIComponent(user.id)}`); socket = ws;
    ws.onmessage = event => {
      if (expectedSession !== sessionId || socket !== ws) return;
      try {
        const message = JSON.parse(String(event.data)) as { type?: string };
        if (message.type === 'trade-changed') void poll();
      } catch { /* Ignore unknown events; polling remains the recovery path. */ }
    };
    ws.onopen = () => { if (socket === ws) { reconnectDelay = 1_000; stopPollingOnly(); void poll(); } };
    ws.onerror = () => { /* close starts fallback polling */ };
    ws.onclose = () => { if (socket === ws) {
      socket = undefined;
      if (expectedSession === sessionId && dialog.open) {
        void poll(); const delay = reconnectDelay; reconnectDelay = Math.min(10_000, reconnectDelay * 2);
        reconnectTimer = window.setTimeout(() => { reconnectTimer = 0; connectLive(); }, delay);
      }
    } };
  };
  const stopPollingOnly = () => { if (pollTimer) window.clearTimeout(pollTimer); pollTimer = 0; };
  const mutate = async (path: string, body: unknown) => {
    const user = account(); if (!user) throw new Error('계정 연결이 필요합니다.');
    const response = await jsonRequest<unknown>(path, user, { method: 'POST', body: JSON.stringify(body) });
    acceptRoom(responseRoom(response)); render(); return trade!;
  };
  const start = async (action: 'create' | 'join', code?: string) => {
    if (!checkpoint) throw new Error('거래용 저장 체크포인트가 없습니다. 창을 다시 열어 주세요.');
    trade = await mutate('/api/trades', action === 'create' ? { action } : { action, code }); setError(); fillBox(); render(); connectLive(); void poll();
  };
  dialog.querySelector<HTMLButtonElement>('[data-create]')!.onclick = () => void (async () => { if (busy) return; setBusy(true); try { await start('create'); } catch (failure) { setError(failure); } finally { setBusy(false); render(); } })();
  dialog.querySelector<HTMLFormElement>('[data-join]')!.onsubmit = event => { event.preventDefault(); void (async () => { if (busy) return; setBusy(true); try { const code = String(new FormData(event.currentTarget as HTMLFormElement).get('code') ?? '').trim().toUpperCase(); await start('join', code); } catch (failure) { setError(failure); } finally { setBusy(false); render(); } })(); };
  offerForm.onsubmit = event => { event.preventDefault(); void (async () => { if (busy || !trade || !checkpoint) return; setBusy(true); try {
    const monsterId = monsterSelect.value || null, amount = Number(moneyInput.value);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > options.game().player.money) throw new Error('보낼 용돈을 현재 보유액 안에서 입력해 주세요.');
    const monster = monsterId ? options.game().player.box.find(item => item.instanceId === monsterId) : undefined;
    if (monsterId && !monster) throw new Error('선택한 포켓몬이 현재 박스에 없습니다.');
    const neural = monster ? await exportTransferableServerBrain(monster.instanceId) : null;
    await mutate(`/api/trades/${encodeURIComponent(trade.id)}/offer`, { version: trade.version, revision: checkpoint.revision, monsterId, money: amount, neural }); setError();
  } catch (failure) { setError(failure); void poll(); } finally { setBusy(false); render(); } })(); };
  confirmButton.onclick = () => void (async () => { if (busy || !trade) return; setBusy(true); try { await mutate(`/api/trades/${encodeURIComponent(trade.id)}/confirm`, { version: trade.version }); setError(); if (trade.status === 'completed') await applyCompleted(trade); else void poll(); } catch (failure) { setError(failure); void poll(); } finally { setBusy(false); render(); } })();
  const cancelTrade = async () => { if (!trade || !['waiting', 'active'].includes(trade.status)) return terminal(trade?.status ?? 'cancelled'); try {
    const updated = await mutate(`/api/trades/${encodeURIComponent(trade.id)}/cancel`, { version: trade.version });
    if (updated.status === 'completed') { await applyCompleted(updated); return false; }
    if (!['cancelled', 'expired'].includes(updated.status)) throw new Error('서버가 거래 취소를 확정하지 않았습니다. 상태를 다시 확인합니다.');
    return true;
  } catch (failure) { setError(failure); retryButton.hidden = false; void poll(); return false; } };
  cancelButton.onclick = () => void (async () => { if (busy) return; setBusy(true); const closed = await cancelTrade(); setBusy(false); if (closed) finish('cancelled'); })();
  const close = dialog.querySelector<HTMLButtonElement>('.trade-close')!;
  close.onclick = () => void (async () => {
    if (busy) return;
    if (trade?.status === 'completed') { setBusy(true); try { await applyCompleted(trade); } catch (failure) { setError(failure); retryButton.hidden = false; } finally { setBusy(false); } return; }
    let outcome: 'no-trade' | 'cancelled' = 'no-trade';
    if (trade && ['waiting', 'active'].includes(trade.status)) { setBusy(true); const closed = await cancelTrade(); setBusy(false); if (!closed) return; outcome = 'cancelled'; }
    else if (trade?.status === 'cancelled' || trade?.status === 'expired') outcome = 'cancelled';
    finish(outcome);
  })();
  dialog.addEventListener('cancel', event => { event.preventDefault(); close.click(); });
  retryButton.onclick = () => void poll();
  dialog.querySelector<HTMLButtonElement>('[data-copy]')!.onclick = () => void navigator.clipboard.writeText(codeText.textContent ?? '').then(() => options.notify?.('초대 코드를 복사했습니다.')).catch(failure => setError(failure));
  dialog.querySelector<HTMLButtonElement>('[data-login]')!.onclick = () => { finish('no-trade'); options.openAccount?.(); };
  return {
    async open() {
      if (disposed || busy || dialog.open) return;
      sessionId++; trade = undefined; checkpoint = undefined; ignoredTerminalId = undefined; reconnectDelay = 1_000; setError(); dialog.showModal(); render(); setBusy(true);
      try {
        await options.prepare();
        if (!account()) { render(); return; }
        checkpoint = await checkpointTradeSave(); fillBox(); render(); connectLive(); await poll();
      } catch (failure) { setError(failure); retryButton.hidden = false; }
      finally { setBusy(false); render(); }
    },
    isActive: () => Boolean(dialog.open && (trade || checkpoint)),
    destroy() { disposed = true; sessionId++; stopLive(); dialog.remove(); },
  };
}
