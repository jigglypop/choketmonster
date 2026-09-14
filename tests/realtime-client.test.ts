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

const base: Presence = { region: 'kanto', name: '트레이너0001', speciesId: 1, x: 1, z: 2, heading: 0, activity: 'idle' };

describe('RealtimeClient', () => {
  beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true }); });
  afterEach(() => { vi.useRealTimers(); Reflect.deleteProperty(globalThis, 'window'); });

  it('sends at most one latest changed state per 100ms and retains it through backpressure', () => {
    const sockets: FakeSocket[] = [];
    const client = new RealtimeClient({ url: 'ws://test/api/realtime', createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; }, visible: () => true });
    client.join(base); sockets[0].open();
    expect(sockets[0].sent.map(row => row.type)).toEqual(['join']);
    expect(client.snapshot().status).toBe('connecting');
    sockets[0].message({ type: 'welcome', id: 'self', region: 'kanto', tickRate: 10, players: [], history: [] });
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
    const socket = new FakeSocket(); const client = new RealtimeClient({ url: 'ws://test/api/realtime', createSocket: () => socket as unknown as WebSocket, visible: () => true });
    let latest = client.snapshot(); client.subscribe(view => { latest = view; }); client.join(base); socket.open();
    const self = { ...base, id: 'self', updatedAt: 1 }, peer = { ...base, id: 'peer', name: '친구', x: 5, updatedAt: 1 };
    socket.message({ type: 'welcome', id: 'self', region: 'kanto', tickRate: 10, players: [self, peer], history: [] });
    expect(latest.players.map(row => row.id)).toEqual(['peer']);
    socket.message({ type: 'patch', region: 'johto', players: [{ ...peer, region: 'johto', x: 90 }], left: [] });
    expect(latest.players[0].x).toBe(5);
    socket.message({ type: 'patch', region: 'kanto', players: [{ ...peer, x: 6, updatedAt: 2 }], left: [] }); expect(latest.players[0].x).toBe(6);
    socket.message({ type: 'patch', region: 'kanto', players: [{ ...peer, x: 4, updatedAt: 1 }], left: [] }); expect(latest.players[0].x).toBe(6);
    socket.message({ type: 'chat', region: 'johto', message: { id: 'old-room', playerId: 'peer', name: '친구', text: '이전 방', sentAt: 9 } }); expect(latest.history).toHaveLength(0);
    socket.message({ type: 'chat', region: 'kanto', message: { id: 'm1', playerId: 'peer', name: '친구', text: '안녕', sentAt: 10 } });
    socket.message({ type: 'chat', region: 'kanto', message: { id: 'm1', playerId: 'peer', name: '친구', text: '안녕', sentAt: 10 } }); expect(latest.history).toHaveLength(1);
    socket.message({ type: 'patch', region: 'kanto', players: [], left: ['peer'] }); expect(latest.players).toHaveLength(0);
    socket.message({ type: 'snapshot', region: 'kanto', players: [{ ...peer, id: 'next' }] }); expect(latest.players.map(row => row.id)).toEqual(['next']);
    client.close();
  });

  it('backs off after close and rejoins with the latest state', () => {
    const sockets: FakeSocket[] = [];
    const client = new RealtimeClient({ url: 'ws://test/api/realtime', createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; }, visible: () => true, random: () => 0 });
    client.join(base); sockets[0].open();
    expect(client.sendChat('welcome 전')).toBe(false);
    sockets[0].message({ type: 'welcome', id: 'self', region: 'kanto', tickRate: 10, players: [], history: [] });
    client.setPresence({ ...base, x: 44, activity: 'moving' }); sockets[0].close();
    vi.advanceTimersByTime(374); expect(sockets).toHaveLength(1); vi.advanceTimersByTime(1); expect(sockets).toHaveLength(2);
    sockets[1].open(); expect(sockets[1].sent[0]).toMatchObject({ type: 'join', region: 'kanto' });
    expect(sockets[1].sent).toHaveLength(1);
    sockets[1].message({ type: 'welcome', id: 'next-self', region: 'kanto', tickRate: 10, players: [], history: [] });
    expect(sockets[1].sent[1]).toMatchObject({ type: 'state', x: 44, activity: 'moving' });
    client.join({ ...base, region: 'johto', x: 8 });
    expect(sockets[1].sent.at(-1)).toMatchObject({ type: 'join', region: 'johto', x: 8 });
    client.close();
  });

  it('uses the current origin and upgrades secure pages to wss', () => {
    expect(realtimeUrl({ protocol: 'http:', host: '127.0.0.1:5186' } as Location)).toBe('ws://127.0.0.1:5186/api/realtime');
    expect(realtimeUrl({ protocol: 'https:', host: 'game.example' } as Location)).toBe('wss://game.example/api/realtime');
  });
});
