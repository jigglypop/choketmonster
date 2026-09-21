export type RealtimeRegion = 'kanto' | 'johto' | 'hoenn' | 'sinnoh' | 'unova' | 'kalos' | 'alola' | 'galar' | 'hisui' | 'paldea';
export type PlayerActivity = 'idle' | 'moving' | 'battle';
export type RemotePlayer = { id: string; name: string; region: RealtimeRegion; sceneId: string; speciesId: number; x: number; z: number; heading: number; activity: PlayerActivity; updatedAt: number };
export type ChatMessage = { id: string; playerId: string; name: string; text: string; sentAt: number };
export type Presence = Omit<RemotePlayer, 'id' | 'name' | 'updatedAt'>;
export type RealtimeStatus = 'offline' | 'auth-required' | 'connecting' | 'connected' | 'reconnecting';

type ServerMessage =
  | { type: 'welcome'; id: string; region: RealtimeRegion; sceneId: string; tickRate: number; players: RemotePlayer[]; history: ChatMessage[] }
  | { type: 'snapshot'; region: RealtimeRegion; sceneId: string; players: RemotePlayer[] }
  | { type: 'patch'; region: RealtimeRegion; sceneId: string; players: RemotePlayer[]; left: string[] }
  | { type: 'chat'; region: RealtimeRegion; sceneId: string; message: ChatMessage }
  | { type: 'pong'; sentAt: number }
  | { type: 'error'; code: string; message: string };

export type RealtimeView = { status: RealtimeStatus; id?: string; region?: RealtimeRegion; sceneId?: string; players: RemotePlayer[]; history: ChatMessage[]; ping?: number; error?: string };
type Options = { url?: string; ticket?: string; getTicket?: () => Promise<string>; createSocket?: (url: string) => WebSocket; now?: () => number; random?: () => number; visible?: () => boolean; maxBufferedAmount?: number };

const REALTIME_REGIONS: readonly RealtimeRegion[] = ['kanto', 'johto', 'hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'hisui', 'paldea'];
const validRegion = (value: unknown): value is RealtimeRegion => REALTIME_REGIONS.includes(value as RealtimeRegion);
const WS_CONNECTING = 0, WS_OPEN = 1, WS_CLOSING = 2;
const codePointLength = (value: string) => Array.from(value).length;
const validScene = (value: unknown, region: RealtimeRegion): value is string => typeof value === 'string' && (value === `surface:${region}` || new RegExp(`^cave:${region}:[a-z0-9-]+$`).test(value)) && value.length <= 64;
const validPlayer = (value: unknown): value is RemotePlayer => { const p = value as RemotePlayer; return Boolean(p && typeof p.id === 'string' && p.id && typeof p.name === 'string' && codePointLength(p.name) <= 32 && validRegion(p.region) && validScene(p.sceneId, p.region) && Number.isInteger(p.speciesId) && p.speciesId > 0 && p.speciesId <= 1025 && [p.x, p.z, p.heading, p.updatedAt].every(Number.isFinite) && ['idle', 'moving', 'battle'].includes(p.activity)); };
const validChat = (value: unknown): value is ChatMessage => { const m = value as ChatMessage; return Boolean(m && typeof m.id === 'string' && m.id && typeof m.playerId === 'string' && typeof m.name === 'string' && codePointLength(m.name) <= 32 && typeof m.text === 'string' && codePointLength(m.text) <= 200 && Number.isFinite(m.sentAt)); };
const samePresence = (a?: Presence, b?: Presence) => Boolean(a && b && a.region === b.region && a.sceneId === b.sceneId && a.speciesId === b.speciesId && a.x === b.x && a.z === b.z && a.heading === b.heading && a.activity === b.activity);

export class RealtimeClient {
  private socket?: WebSocket;
  private desired?: Presence;
  private latest?: Presence;
  private sent?: Presence;
  private peers = new Map<string, RemotePlayer>();
  private messages = new Map<string, ChatMessage>();
  private listeners = new Set<(view: RealtimeView) => void>();
  private reconnectTimer?: number;
  private stateTimer?: number;
  private pingTimer?: number;
  private reauthTimer?: number;
  private reauthPending = false;
  private attempt = 0;
  private seq = 0;
  private joined = false;
  private ticketPending = false;
  private ticketGeneration = 0;
  private authRequired = false;
  private disposed = false;
  private view: RealtimeView = { status: 'offline', players: [], history: [] };
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly visible: () => boolean;
  private readonly maxBufferedAmount: number;
  private readonly visibility = () => { if (this.visible()) this.connect(); else this.disconnect(false); };

  constructor(private readonly options: Options = {}) {
    this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
    this.visible = options.visible ?? (() => typeof document === 'undefined' || !document.hidden);
    this.createSocket = options.createSocket ?? (url => new WebSocket(url));
    this.maxBufferedAmount = options.maxBufferedAmount ?? 64 * 1024;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibility);
  }

  subscribe(listener: (view: RealtimeView) => void): () => void { this.listeners.add(listener); listener(this.snapshot()); return () => this.listeners.delete(listener); }
  snapshot(): RealtimeView { return { ...this.view, players: [...this.view.players], history: [...this.view.history] }; }

  join(presence: Presence): void {
    const regionChanged = this.desired && (this.desired.region !== presence.region || this.desired.sceneId !== presence.sceneId);
    this.desired = { ...presence }; this.latest = this.desired;
    if (regionChanged) { this.peers.clear(); this.messages.clear(); this.sent = undefined; this.publish({ region: presence.region, players: [], history: [] }); }
    if (this.socket?.readyState === WS_OPEN) { this.joined = false; this.publish({ status: 'connecting' }); this.send({ type: 'join', ...this.desired }, true); }
    else this.connect();
  }

  setPresence(presence: Presence): void { this.latest = { ...presence }; }
  accountChanged(authenticated: boolean): void {
    this.authRequired = !authenticated;
    this.ticketGeneration++;
    this.ticketPending = false;
    this.disconnect(false);
    this.attempt = 0;
    if (authenticated) this.connect();
    else this.publish({ status: 'auth-required', error: undefined });
  }
  sendChat(text: string): boolean { const value = text.trim(); return this.joined && codePointLength(value) > 0 && codePointLength(value) <= 200 && this.send({ type: 'chat', text: value }); }

  connect(): void {
    if (this.disposed || !this.desired || !this.visible() || this.socket && (this.socket.readyState === WS_CONNECTING || this.socket.readyState === WS_OPEN)) return;
    if (this.authRequired) return void this.publish({ status: 'auth-required', error: undefined });
    this.clearReconnect(); this.publish({ status: this.attempt ? 'reconnecting' : 'connecting', error: undefined });
    if (this.ticketPending) return;
    if (this.options.ticket) return this.openSocket(this.options.ticket);
    this.ticketPending = true;
    const generation = this.ticketGeneration;
    void (this.options.getTicket ?? fetchRealtimeTicket)().then(ticket => {
      if (generation !== this.ticketGeneration) return;
      this.ticketPending = false;
      if (!this.disposed && this.desired && this.visible()) this.openSocket(ticket);
    }).catch(error => {
      if (generation !== this.ticketGeneration) return;
      this.ticketPending = false;
      if (error instanceof RealtimeAuthRequiredError) { this.authRequired = true; this.publish({ status:'auth-required', error:undefined }); }
      else { this.publish({ status:'offline', error:error instanceof Error ? error.message : String(error) }); this.scheduleReconnect(); }
    });
  }

  private openSocket(ticket: string): void {
    if (this.disposed || !this.desired || this.socket) return;
    const target = new URL(this.options.url ?? realtimeUrl()); target.searchParams.set('ticket', ticket);
    const socket = this.createSocket(target.toString()); this.socket = socket;
    socket.addEventListener('open', () => {
      if (socket !== this.socket) return;
      this.sent = undefined; this.joined = false; this.publish({ status: 'connecting', error: undefined });
      this.send({ type: 'join', ...this.desired! }, true); this.startTimers();
    });
    socket.addEventListener('message', event => { if (socket === this.socket && typeof event.data === 'string') this.receive(event.data); });
    socket.addEventListener('close', () => { if (socket !== this.socket) return; this.socket = undefined; this.joined = false; this.stopTimers(); this.publish({ status: 'offline', id: undefined, players: [] }); if (!this.disposed && this.visible()) this.scheduleReconnect(); });
    socket.addEventListener('error', () => { if (socket === this.socket) this.publish({ error: '실시간 연결을 확인하고 있습니다.' }); });
  }

  close(): void { this.disposed = true; if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibility); this.disconnect(true); this.listeners.clear(); }

  private disconnect(permanent: boolean): void {
    this.clearReconnect(); this.stopTimers(); const socket = this.socket; this.socket = undefined; this.joined = false;
    if (socket && socket.readyState < WS_CLOSING) socket.close(1000, permanent ? 'client-close' : 'background');
    this.peers.clear(); this.publish({ status: 'offline', id: undefined, players: [] });
  }
  private scheduleReconnect(): void { this.clearReconnect(); const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempt++, 5)) * (.75 + this.random() * .5); this.publish({ status: 'reconnecting' }); this.reconnectTimer = window.setTimeout(() => this.connect(), delay); }
  private clearReconnect(): void { if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
  private startTimers(): void { this.stopTimers(); this.stateTimer = window.setInterval(() => this.flushState(), 100); this.pingTimer = window.setInterval(() => this.send({ type: 'ping', sentAt: this.now() }), 15_000); this.scheduleReauthentication(40_000); this.flushState(); }
  private stopTimers(): void { if (this.stateTimer !== undefined) window.clearInterval(this.stateTimer); if (this.pingTimer !== undefined) window.clearInterval(this.pingTimer); if (this.reauthTimer !== undefined) window.clearTimeout(this.reauthTimer); this.stateTimer = this.pingTimer = this.reauthTimer = undefined; this.reauthPending = false; }
  private scheduleReauthentication(delay: number): void {
    if (this.options.ticket || this.disposed) return;
    if (this.reauthTimer !== undefined) window.clearTimeout(this.reauthTimer);
    this.reauthTimer = window.setTimeout(() => void this.reauthenticate(), delay);
  }
  private async reauthenticate(): Promise<void> {
    if (this.reauthPending || !this.joined) return;
    this.reauthPending = true;
    const generation = this.ticketGeneration;
    try {
      const ticket = await (this.options.getTicket ?? fetchRealtimeTicket)();
      if (generation !== this.ticketGeneration || !this.joined) return;
      if (!this.send({ type:'reauth', ticket }, true)) throw new Error('실시간 인증을 갱신하지 못했습니다.');
      this.scheduleReauthentication(40_000);
    } catch (error) {
      if (generation !== this.ticketGeneration) return;
      if (error instanceof RealtimeAuthRequiredError) this.accountChanged(false);
      else { this.publish({ error:error instanceof Error ? error.message : String(error) }); this.scheduleReauthentication(5_000); }
    } finally { this.reauthPending = false; }
  }
  private flushState(): void { if (!this.joined || !this.latest || samePresence(this.sent, this.latest)) return; if (this.send({ type: 'state', seq: ++this.seq, x: this.latest.x, z: this.latest.z, heading: this.latest.heading, speciesId: this.latest.speciesId, activity: this.latest.activity })) this.sent = { ...this.latest }; }
  private send(value: object, priority = false): boolean { const socket = this.socket; if (!socket || socket.readyState !== WS_OPEN || (!priority && socket.bufferedAmount > this.maxBufferedAmount)) return false; socket.send(JSON.stringify(value)); return true; }

  private receive(raw: string): void {
    let message: ServerMessage; try { message = JSON.parse(raw) as ServerMessage; } catch { return; }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'pong' && Number.isFinite(message.sentAt)) return void this.publish({ ping: Math.max(0, this.now() - message.sentAt) });
    if (message.type === 'error') return void this.publish({ error: typeof message.message === 'string' ? message.message : '실시간 오류' });
    if (message.type === 'chat') { if (!this.joined || !validRegion(message.region) || message.region !== this.desired?.region || message.sceneId !== this.desired?.sceneId || !validChat(message.message)) return; this.messages.set(message.message.id, message.message); this.trimMessages(); return void this.publishLists(); }
    if (!('region' in message) || !validRegion(message.region) || message.region !== this.desired?.region || message.sceneId !== this.desired?.sceneId) return;
    if (message.type === 'welcome') {
      if (typeof message.id !== 'string' || !Array.isArray(message.players) || !Array.isArray(message.history)) return;
      this.view.id = message.id; this.joined = true; this.attempt = 0; this.replacePlayers(message.players); this.messages.clear(); for (const row of message.history) if (validChat(row)) this.messages.set(row.id, row); this.trimMessages(); this.publish({ status: 'connected', region:message.region, sceneId:message.sceneId, error: undefined }); this.publishLists(); this.flushState(); return;
    }
    if (!this.joined) return;
    if (message.type === 'snapshot' && Array.isArray(message.players)) { this.replacePlayers(message.players); this.publishLists(); return; }
    if (message.type === 'patch' && Array.isArray(message.players) && Array.isArray(message.left)) {
      let changed = false;
      for (const player of message.players) if (validPlayer(player) && player.region === message.region && player.sceneId === message.sceneId && player.id !== this.view.id) {
        const previous = this.peers.get(player.id);
        if (!previous || player.updatedAt > previous.updatedAt) { this.peers.set(player.id, player); changed = true; }
      }
      for (const id of message.left) if (typeof id === 'string' && this.peers.delete(id)) changed = true;
      if (changed) this.publishLists();
    }
  }
  private replacePlayers(players: unknown[]): void { this.peers.clear(); for (const player of players) if (validPlayer(player) && player.region === this.desired?.region && player.sceneId === this.desired?.sceneId && player.id !== this.view.id) this.peers.set(player.id, player); }
  private trimMessages(): void { const rows = [...this.messages.values()].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id)).slice(-100); this.messages = new Map(rows.map(row => [row.id, row])); }
  private publishLists(): void { this.publish({ players: [...this.peers.values()].sort((a, b) => a.id.localeCompare(b.id)), history: [...this.messages.values()].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id)) }); }
  private publish(patch: Partial<RealtimeView>): void { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(this.snapshot()); }
}

export function realtimeUrl(locationLike?: Pick<Location, 'protocol' | 'host'>): string {
  const origin = locationLike ?? (typeof location === 'undefined' ? { protocol: 'http:', host: '127.0.0.1' } : location);
  return `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}/api/realtime`;
}
async function fetchRealtimeTicket(): Promise<string> {
  const response=await fetch('/api/auth/realtime-ticket',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10_000)});
  const body=await response.json().catch(()=>({})) as {ticket?:unknown;message?:string};
  if(response.status===401) { expiredAuthSession(); throw new RealtimeAuthRequiredError(); }
  if(!response.ok||typeof body.ticket!=='string'||!body.ticket) throw new Error(body.message??'로그인 후 실시간 채팅을 사용할 수 있습니다.');
  return body.ticket;
}
class RealtimeAuthRequiredError extends Error {}
import { expiredAuthSession } from '../game/auth-session';
