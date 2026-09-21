import type { Graph } from '../core/brain';
import fieldItemsJson from '../data/field-items.json' with { type: 'json' };
import { getSpecies } from '../data/pokemon';
import type { User } from './account';
import type { GameState, Monster } from './engine';
import { exportTransferableServerBrain, importTransferableServerBrain } from './server-brain';
import { adoptTradeResult, checkpointTradeSave, unpackSave, type SaveEnvelope, type TradeCheckpoint } from './storage';
import './trade.css';

type TradeStatus = 'waiting' | 'active' | 'completed' | 'cancelled' | 'expired';
type FieldItem = { id: string; name: string; kind: 'held-tool' | 'mega-stone'; formIdentifier?: string; speciesId?: number };
type TradeItem = { itemId: string; quantity: number };
type TradeOffer = { monster: null | { instanceId: string; speciesId: number; nickname: string; level: number }; money: number; items: TradeItem[] };
type Participant = { side: 'creator' | 'joiner'; user: User; confirmed: boolean; offer: TradeOffer };
type TradeResult = { revision: number; tradeEpoch: number; save: SaveEnvelope; incomingNeural: null | { instanceId: string; neural: unknown } };
type TradeRoom = { id: string; code?: string; status: TradeStatus; version: number; expiresAt: string; participants: Participant[]; result?: TradeResult };

const fieldItems = fieldItemsJson as readonly FieldItem[];
const fieldItemById = new Map(fieldItems.map(item => [item.id, item]));

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
    participant.offer.items ??= [];
    if (!Array.isArray(participant.offer.items) || participant.offer.items.length > 8) throw new Error('거래 물품 정보가 올바르지 않습니다.');
    const itemIds = new Set<string>();
    for (const item of participant.offer.items) {
      if (!item || typeof item.itemId !== 'string' || !fieldItemById.has(item.itemId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 999 || itemIds.has(item.itemId)) throw new Error('거래 물품 정보가 올바르지 않습니다.');
      itemIds.add(item.itemId);
    }
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
    <div class="trade-heading"><h2>교환</h2><button type="button" class="trade-close" aria-label="닫기">×</button></div>
    <section class="trade-login" hidden><strong>계정 연결이 필요합니다.</strong><p>거래 상대를 확인하고 저장을 안전하게 바꾸기 위해 로그인해 주세요.</p><button type="button" data-login>계정 연결 열기</button></section>
    <section class="trade-lobby"><button type="button" class="primary" data-create>초대 코드 만들기</button><form data-join><label>초대 코드<input name="code" autocomplete="off" maxlength="12" spellcheck="false" required></label><button type="submit">코드로 참가</button></form></section>
    <section class="trade-room" hidden><div class="trade-code" hidden><span>초대 코드</span><strong data-code></strong><button type="button" data-copy>복사</button></div><p class="trade-state" aria-live="polite"></p>
      <div class="trade-previews"><article data-own></article><article data-other></article></div>
      <form class="trade-offer"><label>박스 포켓몬<select name="monster"><option value="">포켓몬 없음</option></select></label><label>보낼 용돈<input name="money" type="number" min="0" step="1" value="0"></label>
        <fieldset class="trade-item-picker"><legend>보낼 물품</legend><div class="trade-item-add"><select name="item" aria-label="추가할 물품"><option value="">물품 선택</option></select><input name="itemQuantity" aria-label="추가할 수량" type="number" min="1" max="999" step="1" value="1"><button type="button" data-add-item>추가</button></div><ul data-offer-items></ul></fieldset>
        <button type="submit" class="trade-offer-save">제안 저장</button></form>
      <div class="trade-actions"><button type="button" class="primary" data-confirm>이 내용으로 확인</button><button type="button" data-cancel>거래 취소</button><button type="button" data-retry hidden>상태 다시 확인</button></div>
    </section><p class="trade-error" role="alert" hidden></p>
  </div></dialog>`);
  const dialog = host.querySelector<HTMLDialogElement>('.trade-dialog')!, login = dialog.querySelector<HTMLElement>('.trade-login')!, lobby = dialog.querySelector<HTMLElement>('.trade-lobby')!, roomSection = dialog.querySelector<HTMLElement>('.trade-room')!;
  const error = dialog.querySelector<HTMLElement>('.trade-error')!, stateText = dialog.querySelector<HTMLElement>('.trade-state')!, codeBox = dialog.querySelector<HTMLElement>('.trade-code')!, codeText = dialog.querySelector<HTMLElement>('[data-code]')!;
  const offerForm = dialog.querySelector<HTMLFormElement>('.trade-offer')!, monsterSelect = offerForm.elements.namedItem('monster') as HTMLSelectElement, moneyInput = offerForm.elements.namedItem('money') as HTMLInputElement;
  const itemSelect = offerForm.elements.namedItem('item') as HTMLSelectElement, itemQuantity = offerForm.elements.namedItem('itemQuantity') as HTMLInputElement, offerItemsList = offerForm.querySelector<HTMLUListElement>('[data-offer-items]')!;
  const confirmButton = dialog.querySelector<HTMLButtonElement>('[data-confirm]')!, cancelButton = dialog.querySelector<HTMLButtonElement>('[data-cancel]')!, retryButton = dialog.querySelector<HTMLButtonElement>('[data-retry]')!;
  let trade: TradeRoom | undefined, checkpoint: TradeCheckpoint | undefined, ignoredTerminalId: string | undefined, pendingGameApplicationId: string | undefined,
    pollTimer = 0, reconnectTimer = 0, reconnectDelay = 1_000, socket: WebSocket | undefined,
    disposed = false, busy = false, applyingResult = false, polling = false, pollAgain = false, sessionId = 0,
    offeredItems: TradeItem[] = [], offerItemsDirty = false;
  const account = () => options.currentAccount();
  const setError = (failure?: unknown) => { error.hidden = !failure; error.textContent = failure ? (failure instanceof Error ? failure.message : String(failure)) : ''; if (failure) options.notify?.(error.textContent, true); };
  const setBusy = (value: boolean) => { busy = value; for (const button of dialog.querySelectorAll<HTMLButtonElement>('button')) button.disabled = value; monsterSelect.disabled = value; moneyInput.disabled = value; itemSelect.disabled = value; itemQuantity.disabled = value; };
  const stopLive = () => { if (pollTimer) window.clearTimeout(pollTimer); if (reconnectTimer) window.clearTimeout(reconnectTimer); pollTimer = 0; reconnectTimer = 0; if (socket) { const current = socket; socket = undefined; current.close(); } };
  const terminal = (status: TradeStatus) => ['completed', 'cancelled', 'expired'].includes(status);
  const acceptRoom = (next: TradeRoom) => {
    if (trade?.id === next.id && (next.version < trade.version || (terminal(trade.status) && !terminal(next.status)))) return trade;
    trade = next; return trade;
  };
  const finish = (outcome: 'no-trade' | 'cancelled' | 'completed') => {
    sessionId++; trade = undefined; checkpoint = undefined; pendingGameApplicationId = undefined; offeredItems = []; offerItemsDirty = false; stopLive(); dialog.close(); options.closed?.(outcome);
  };
  const participantCard = (element: HTMLElement, title: string, participant?: Participant) => {
    element.replaceChildren(); const heading = document.createElement('h3'); heading.textContent = title; element.append(heading);
    if (!participant) { const p = document.createElement('p'); p.textContent = '상대를 기다리는 중입니다.'; element.append(p); return; }
    const name = document.createElement('strong'); name.textContent = participant.user.username; element.append(name);
    const mon = document.createElement('p'); mon.textContent = participant.offer.monster
      ? `${participant.offer.monster.nickname} · ${getSpecies(participant.offer.monster.speciesId).name} · Lv.${participant.offer.monster.level} · ${participant.offer.monster.instanceId}` : '포켓몬 없음'; element.append(mon);
    const cash = document.createElement('p'); cash.textContent = `용돈 ${money(participant.offer.money)}`; element.append(cash);
    const items = document.createElement('div'); items.className = 'trade-preview-items';
    const itemTitle = document.createElement('b'); itemTitle.textContent = '물품'; items.append(itemTitle);
    const itemList = document.createElement('ul');
    if (participant.offer.items.length) for (const offered of participant.offer.items) {
      const li = document.createElement('li'); li.textContent = `${fieldItemById.get(offered.itemId)!.name} ×${offered.quantity}`; itemList.append(li);
    } else { const li = document.createElement('li'); li.textContent = '없음'; itemList.append(li); }
    items.append(itemList); element.append(items);
    const confirmed = document.createElement('span'); confirmed.className = participant.confirmed ? 'is-confirmed' : ''; confirmed.textContent = participant.confirmed ? '확인 완료' : '확인 전'; element.append(confirmed);
  };
  const ownedQuantity = (itemId: string) => Number((options.game().inventory as Record<string, number | undefined>)[itemId] ?? 0);
  const renderOfferItems = () => {
    offerItemsList.replaceChildren();
    for (const offered of offeredItems) {
      const li = document.createElement('li'), label = document.createElement('span'), remove = document.createElement('button');
      label.textContent = `${fieldItemById.get(offered.itemId)!.name} ×${offered.quantity}`;
      remove.type = 'button'; remove.dataset.removeItem = offered.itemId; remove.textContent = '제거'; remove.disabled = busy;
      remove.onclick = () => { offeredItems = offeredItems.filter(item => item.itemId !== offered.itemId); offerItemsDirty = true; renderOfferItems(); fillItems(); };
      li.append(label, remove); offerItemsList.append(li);
    }
  };
  const fillItems = () => {
    const selected = itemSelect.value;
    itemSelect.replaceChildren(new Option('물품 선택', ''));
    for (const item of fieldItems) {
      const stock = ownedQuantity(item.id), offered = offeredItems.find(entry => entry.itemId === item.id)?.quantity ?? 0;
      if (stock > offered) itemSelect.add(new Option(`${item.name} · 보유 ${stock}`, item.id));
    }
    if ([...itemSelect.options].some(option => option.value === selected)) itemSelect.value = selected;
    const current = offeredItems.find(item => item.itemId === itemSelect.value)?.quantity ?? 0;
    itemQuantity.max = String(Math.max(1, Math.min(999, ownedQuantity(itemSelect.value) - current)));
  };
  const render = () => {
    const user = account(), own = trade?.participants.find(item => item.user.id === user?.id), other = trade?.participants.find(item => item.user.id !== user?.id);
    login.hidden = Boolean(user); lobby.hidden = !user || Boolean(trade); roomSection.hidden = !trade;
    if (!trade) return;
    codeBox.hidden = !trade.code; codeText.textContent = trade.code ?? '';
    participantCard(dialog.querySelector('[data-own]')!, '내 제안', own); participantCard(dialog.querySelector('[data-other]')!, '상대 제안', other);
    if (!offerItemsDirty) offeredItems = own?.offer.items.map(item => ({ ...item })) ?? [];
    renderOfferItems(); fillItems();
    const labels: Record<TradeStatus, string> = { waiting: '상대가 초대 코드로 들어오기를 기다립니다.', active: '제안을 고른 뒤 두 사람이 확인해 주세요.', completed: '거래가 완료되었습니다. 결과를 안전하게 적용하는 중입니다.', cancelled: '취소된 거래입니다.', expired: '시간이 만료된 거래입니다.' };
    stateText.textContent = `${labels[trade.status]} · ${new Date(trade.expiresAt).toLocaleTimeString('ko-KR')}까지`;
    const editable = trade.status === 'active' || trade.status === 'waiting'; offerForm.hidden = !editable; confirmButton.hidden = trade.status !== 'active'; cancelButton.hidden = !editable; retryButton.hidden = !['completed'].includes(trade.status);
    if (own) confirmButton.textContent = own.confirmed ? '확인 취소는 제안을 바꾸세요' : '이 내용으로 확인';
  };
  const fillBox = () => {
    monsterSelect.replaceChildren(new Option('포켓몬 없음', ''));
    for (const monster of options.game().player.box) monsterSelect.add(new Option(optionLabel(monster), monster.instanceId));
    moneyInput.max = String(options.game().player.money);
    fillItems();
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
      // The save and neural cache use separate IndexedDB databases. A failed
      // import or screen update must resume the in-memory game application even
      // after the durable save receipt makes the next adoption idempotent.
      if (adoption.newlyApplied) pendingGameApplicationId = room.id;
      if (result.incomingNeural) await importTransferableServerBrain(result.incomingNeural.instanceId, result.incomingNeural.neural, room.id);
      if (pendingGameApplicationId === room.id) {
        await options.applied(adoption.save); pendingGameApplicationId = undefined;
        options.notify?.('거래 완료'); finish('completed');
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
    offeredItems = []; offerItemsDirty = false; trade = await mutate('/api/trades', action === 'create' ? { action } : { action, code }); setError(); fillBox(); render(); connectLive(); void poll();
  };
  dialog.querySelector<HTMLButtonElement>('[data-create]')!.onclick = () => void (async () => { if (busy) return; setBusy(true); try { await start('create'); } catch (failure) { setError(failure); } finally { setBusy(false); render(); } })();
  dialog.querySelector<HTMLFormElement>('[data-join]')!.onsubmit = event => { event.preventDefault(); void (async () => { if (busy) return; setBusy(true); try { const code = String(new FormData(event.currentTarget as HTMLFormElement).get('code') ?? '').trim().toUpperCase(); await start('join', code); } catch (failure) { setError(failure); } finally { setBusy(false); render(); } })(); };
  itemSelect.onchange = () => { itemQuantity.value = '1'; fillItems(); };
  dialog.querySelector<HTMLButtonElement>('[data-add-item]')!.onclick = () => {
    const itemId = itemSelect.value, quantity = Number(itemQuantity.value), catalog = fieldItemById.get(itemId);
    if (!catalog) { setError(new Error('추가할 물품을 선택해 주세요.')); return; }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) { setError(new Error('수량은 1~999개로 입력해 주세요.')); return; }
    const existing = offeredItems.find(item => item.itemId === itemId), next = (existing?.quantity ?? 0) + quantity;
    if (next > 999) { setError(new Error('물품별로 최대 999개까지 보낼 수 있습니다.')); return; }
    if (!existing && offeredItems.length >= 8) { setError(new Error('물품은 8종까지 보낼 수 있습니다.')); return; }
    if (next > ownedQuantity(itemId)) { setError(new Error('가방에 있는 수량까지만 보낼 수 있습니다.')); return; }
    if (existing) existing.quantity = next; else offeredItems.push({ itemId, quantity });
    offerItemsDirty = true; itemQuantity.value = '1'; setError(); renderOfferItems(); fillItems();
  };
  offerForm.onsubmit = event => { event.preventDefault(); void (async () => { if (busy || !trade || !checkpoint) return; setBusy(true); try {
    const monsterId = monsterSelect.value || null, amount = Number(moneyInput.value);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > options.game().player.money) throw new Error('보낼 용돈을 현재 보유액 안에서 입력해 주세요.');
    const monster = monsterId ? options.game().player.box.find(item => item.instanceId === monsterId) : undefined;
    if (monsterId && !monster) throw new Error('선택한 포켓몬이 현재 박스에 없습니다.');
    if (offeredItems.length > 8 || offeredItems.some(item => !fieldItemById.has(item.itemId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > Math.min(999, ownedQuantity(item.itemId)))) throw new Error('보낼 물품과 수량을 다시 확인해 주세요.');
    const neural = monster ? await exportTransferableServerBrain(monster.instanceId) : null;
    await mutate(`/api/trades/${encodeURIComponent(trade.id)}/offer`, { version: trade.version, revision: checkpoint.revision, monsterId, money: amount, items: offeredItems, neural }); offerItemsDirty = false; render(); setError();
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
      sessionId++; trade = undefined; checkpoint = undefined; ignoredTerminalId = undefined; pendingGameApplicationId = undefined; offeredItems = []; offerItemsDirty = false; reconnectDelay = 1_000; setError(); dialog.showModal(); render(); setBusy(true);
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
