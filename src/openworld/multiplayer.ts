import { localRealtimeName, RealtimeClient, type Presence, type RealtimeView } from '../network/realtime';
import { getSpecies } from '../data/pokemon';
import { pokemonWorldDisplayHeight } from './visual-scale';
import type { WorldCreature, WorldPoint } from './types';

export class MultiplayerSession {
  readonly client: RealtimeClient;
  name: string;
  view: RealtimeView = { status: 'offline', players: [], history: [] };
  private unsubscribe?: () => void;

  constructor(private readonly changed: () => void, client = new RealtimeClient()) {
    this.client = client;
    try { this.name = localRealtimeName(); } catch { this.name = `트레이너${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`; }
    this.unsubscribe = client.subscribe(view => { this.view = view; changed(); });
  }
  join(presence: Omit<Presence, 'name'>): void { this.client.join({ ...presence, name: this.name }); }
  update(presence: Omit<Presence, 'name'>): void { this.client.setPresence({ ...presence, name: this.name }); }
  rename(value: string, presence: Omit<Presence, 'name'>): boolean {
    const name = Array.from(value.trim()).slice(0, 16).join(''); if (!name) return false;
    this.name = name; try { localStorage.setItem('choketmon-realtime-name', name); } catch { /* Session-only name. */ }
    this.join(presence); this.changed(); return true;
  }
  sendChat(text: string): boolean { return this.client.sendChat(text); }
  creatures(origin: WorldPoint, movementSpeed: (speciesId: number) => number): WorldCreature[] {
    return this.view.players.map(player => ({ player, distance: Math.hypot(player.x - origin.x, player.z - origin.z) }))
      .filter(row => row.distance <= 48)
      .sort((a, b) => a.distance - b.distance || a.player.id.localeCompare(b.player.id)).slice(0, 12)
      .map(({ player }) => ({ id: `remote:${player.id}`, speciesId: player.speciesId, name: player.name, level: 1, hp: 1, maxHp: 1,
        x: player.x, z: player.z, heading: player.heading as 0 | 1 | 2 | 3 | 4,
        action: player.activity === 'moving' ? 'walk' : 'idle', movementSpeed: movementSpeed(player.speciesId),
        displayHeight: pokemonWorldDisplayHeight(getSpecies(player.speciesId).heightMeters), remotePlayer: { name: player.name, activity: player.activity } }));
  }
  close(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.client.close(); }
}
