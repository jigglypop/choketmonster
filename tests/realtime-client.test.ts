import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, realtimeUrl, type Presence } from '../src/network/realtime';

class FakeSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { if (this.readyState >= 2) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

const base: Presence = { region: 'kanto', sceneId: 'surface:kanto', speciesId: 1, x: 1, z: 2, heading: 0, activity: 'idle' };

describe('RealtimeClient', () => {
  beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true }); });
  afterEach(() => { vi.useRealTimers(); Reflect.deleteProperty(globalThis, 'window'); });

  it('sends at most one latest changed state per 100ms and retains it through backpressure', () => {
    const sockets: FakeSocket[] = [];
    const client = new RealtimeClient({ url: 'ws://test/api/realtime', ticket: 'test-ticket', createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; }, visible: () => true });
    client.join(base); sockets[0].open();
    expect(sockets[0].sent.map(row => row.type)).toEqual(['join']);
    expect(client.snapshot().status).toBe('connecting');
    sockets[0].message({ type: 'welcome', id: 'self', region: 'kanto', sceneId: 'surface:kanto', tickRate: 10, players: [], history: [] });
    expect(client.snapshot().status).toBe('connected');
    expect(sockets[0].sent.map(row => row.type)).toEqual(['join', 'state']);
    expect(client.sendChat('😀'.repeat(200))).toBe(true);
    expect(client.sendChat('😀'.repeat(201))).toBe(false);
    vi.advanceTimersByTime(500); expect(sockets[0].sent.filter(row => row.type === 'state')).toHaveLength(1);
    client.setPresence({ ...base, x: 3 }); client.setPresence({ ...base, x: 4 }); vi.advanceTimersByTime(100);
    expect(sockets[0].sent.filter(row => row.type === 'state').at(-1)).toMatchObject({ x: 4, seq: 2 });
    sockets[0].bufferedAmount = 70_000; client.setPresence({ ...base, x: 9 }); vi.advanceTimersByTime(300);
    expect(sockets[0].sent.filter(row => row.type === 'state').at(-1)).toMatchObject({ x: 4 });
    sockets[0].bufferedAmount = 0; vi.advanceTimersByTime(100);
    expect(sockets[0].sent.filter(row => row.type === 'state').at(-1)).toMatchObject({ x: 9 });
    client.close();
  });

  it('replaces snapshots, applies patches, ignores stale rooms and deduplicates chat IDs', () => {
    const socket = new FakeSocket(); const client = new RealtimeClient({ url: 'ws://test/api/realtime', ticket: 'test-ticket', createSocket: () => socket as unknown as WebSocket, visible: () => true });
    let latest = client.snapshot(); client.subscribe(view => { latest = view; }); client.join(base); socket.open();
    const self = { ...base, id: 'self', name: '계정1', updatedAt: 1 }, peer = { ...base, id: 'peer', name: '친구', x: 5, updatedAt: 1 };
    socket.message({ type: 'welcome', id: 'self', region: 'kanto', sceneId: 'surface:kanto', tickRate: 10, players: [self, peer], history: [] });
    expect(latest.players.map(row => row.id)).toEqual(['peer']);
    socket.message({ type: 'patch', region: 'johto', sceneId: 'surface:johto', players: [{ ...peer, region: 'johto', sceneId: 'surface:johto', x: 90 }], left: [] });
    expect(latest.players[0].x).toBe(5);
    socket.message({ type: 'patch', region: 'kanto', sceneId: 'surface:kanto', players: [{ ...peer, x: 6, updatedAt: 2 }], left: [] }); expect(latest.players[0].x).toBe(6);
    socket.message({ type: 'patch', region: 'kanto', sceneId: 'surface:kanto', players: [{ ...peer, x: 4, updatedAt: 1 }], left: [] }); expect(latest.players[0].x).toBe(6);
    socket.message({ type: 'chat', region: 'johto', sceneId: 'surface:johto', message: { id: 'old-room', playerId: 'peer', name: '친구', text: '이전 방', sentAt: 9 } }); expect(latest.history).toHaveLength(0);
    socket.message({ type: 'chat', region: 'kanto', sceneId: 'surface:kanto', message: { id: 'm1', playerId: 'peer', name: '친구', text: '안녕', sentAt: 10 } });
    socket.message({ type: 'chat', region: 'kanto', sceneId: 'surface:kanto', message: { id: 'm1', playerId: 'peer', name: '친구', text: '안녕', sentAt: 10 } }); expect(latest.history).toHaveLength(1);
    socket.message({ type: 'patch', region: 'kanto', sceneId: 'surface:kanto', players: [], left: ['peer'] }); expect(latest.players).toHaveLength(0);
    socket.message({ type: 'snapshot', region: 'kanto', sceneId: 'surface:kanto', players: [{ ...peer, id: 'next' }] }); expect(latest.players.map(row => row.id)).toEqual(['next']);
    client.close();
  });

  it('shares a room with peers on the same dungeon floor only', () => {
    const socket = new FakeSocket(); const client = new RealtimeClient({ url: 'ws://test/api/realtime', ticket: 'test-ticket', createSocket: () => socket as unknown as WebSocket, visible: () => true });
    let latest = client.snapshot(); client.subscribe(view => { latest = view; });
    const floor: Presence = { ...base, sceneId: 'cave:kanto:mt-moon-b2f' };
    client.join(floor); socket.open();
    const peer = { ...floor, id: 'peer', name: '친구', updatedAt: 1 };
    socket.message({ type: 'welcome', id: 'self', region: 'kanto', sceneId: floor.sceneId, tickRate: 10, players: [peer, { ...peer, id: 'bad', sceneId: 'cave:kanto:Mt_Moon' }], history: [] });
    expect(latest.players.map(row => row.id)).toEqual(['peer']);
    expect(latest.sceneId).toBe('cave:kanto:mt-moon-b2f');
    client.close();
  });

  it('accepts expansion-region rooms and rejects cross-region scenes or unsupported species', () => {
    const socket = new FakeSocket(); const client = new RealtimeClient({ url: 'ws://test/api/realtime', ticket: 'test-ticket', createSocket: () => socket as unknown as WebSocket, visible: () => true });
    let latest = client.snapshot(); client.subscribe(view => { latest = view; });
    const presence: Presence = { ...base, region: 'galar', sceneId: 'surface:galar', speciesId: 810 };
    client.join(presence); socket.open();
    socket.message({ type: 'welcome', id: 'self', region: 'galar', sceneId: 'surface:galar', tickRate: 10,
      players: [
        { ...presence, id: 'valid', name: '가라르', updatedAt: 1 },
        { ...presence, id: 'max', name: '전국도감', speciesId: 1025, updatedAt: 1 },
        { ...presence, id: 'cross', name: 'wrong', sceneId: 'surface:sinnoh', updatedAt: 1 },
        { ...presence, id: 'future', name: 'future', speciesId: 1026, updatedAt: 1 },
      ], history: [] });
    expect(latest.players.map(player => player.id).sort()).toEqual(['max','valid']);
    client.close();
  });

  it('backs off after close and rejoins with the latest state', () => {
    const sockets: FakeSocket[] = [];
    const client = new RealtimeClient({ url: 'ws://test/api/realtime', ticket: 'test-ticket', createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; }, visible: () => true, random: () => 0 });
    client.join(base); sockets[0].open();
    expect(client.sendChat('welcome 전')).toBe(false);
    sockets[0].message({ type: 'welcome', id: 'self', region: 'kanto', sceneId: 'surface:kanto', tickRate: 10, players: [], history: [] });
    client.setPresence({ ...base, x: 44, activity: 'moving' }); sockets[0].close();
    vi.advanceTimersByTime(374); expect(sockets).toHaveLength(1); vi.advanceTimersByTime(1); expect(sockets).toHaveLength(2);
    sockets[1].open(); expect(sockets[1].sent[0]).toMatchObject({ type: 'join', region: 'kanto' });
    expect(sockets[1].sent).toHaveLength(1);
    sockets[1].message({ type: 'welcome', id: 'next-self', region: 'kanto', sceneId: 'surface:kanto', tickRate: 10, players: [], history: [] });
    expect(sockets[1].sent[1]).toMatchObject({ type: 'state', x: 44, activity: 'moving' });
    client.join({ ...base, region: 'johto', x: 8 });
    expect(sockets[1].sent.at(-1)).toMatchObject({ type: 'join', region: 'johto', x: 8 });
    client.close();
  });

  it('disconnects on logout and reconnects with a fresh ticket after login', async () => {
    const sockets: FakeSocket[] = [], urls: string[] = [];
    let ticket = 0;
    const client = new RealtimeClient({ url: 'ws://test/api/realtime', getTicket: async () => `ticket-${++ticket}`,
      createSocket: url => { urls.push(url); const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; }, visible: () => true });
    client.accountChanged(false); client.join(base);
    expect(client.snapshot().status).toBe('auth-required'); expect(sockets).toHaveLength(0);
    client.accountChanged(true); await vi.runAllTicks();
    expect(urls[0]).toContain('ticket=ticket-1');
    sockets[0].open(); sockets[0].message({ type: 'welcome', id: 'self', region: 'kanto', sceneId: 'surface:kanto', tickRate: 10, players: [], history: [] });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sockets[0].sent.at(-1)).toMatchObject({ type: 'reauth', ticket: 'ticket-2' });
    client.accountChanged(false);
    expect(sockets[0].readyState).toBe(3); expect(client.snapshot().status).toBe('auth-required');
    client.accountChanged(true); await vi.runAllTicks();
    expect(urls[1]).toContain('ticket=ticket-3');
    client.close();
  });

  it('backs off and retries when ticket issuance has a transient failure', async () => {
    const sockets: FakeSocket[] = [];
    let calls = 0;
    const client = new RealtimeClient({ url: 'ws://test/api/realtime', random: () => 0,
      getTicket: async () => { if (++calls === 1) throw new Error('temporary outage'); return 'recovered-ticket'; },
      createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; }, visible: () => true });
    client.join(base); await vi.advanceTimersByTimeAsync(0);
    expect(client.snapshot()).toMatchObject({ status: 'reconnecting', error: 'temporary outage' });
    expect(sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(375);
    expect(calls).toBe(2); expect(sockets).toHaveLength(1);
    client.close();
  });

  it('uses the current origin and upgrades secure pages to wss', () => {
    expect(realtimeUrl({ protocol: 'http:', host: '127.0.0.1:5186' } as Location)).toBe('ws://127.0.0.1:5186/api/realtime');
    expect(realtimeUrl({ protocol: 'https:', host: 'game.example' } as Location)).toBe('wss://game.example/api/realtime');
  });
});
