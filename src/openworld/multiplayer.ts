import { RealtimeClient, type Presence, type RealtimeView } from '../network/realtime';
import { onAccountChange } from '../game/account';
import { getSpecies } from '../data/pokemon';
import { pokemonWorldDisplayHeight } from './visual-scale';
import type { WorldCreature, WorldPoint } from './types';

export class MultiplayerSession {
  readonly client: RealtimeClient;
  view: RealtimeView = { status: 'offline', players: [], history: [] };
  private unsubscribe?: () => void;
  private unsubscribeAccount?: () => void;

  constructor(private readonly changed: () => void, client = new RealtimeClient()) {
    this.client = client;
    this.unsubscribe = client.subscribe(view => { this.view = view; changed(); });
    this.unsubscribeAccount = onAccountChange(user => client.accountChanged(user !== null));
  }
  join(presence: Presence): void { this.client.join(presence); }
  update(presence: Presence): void { this.client.setPresence(presence); }
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
  close(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.unsubscribeAccount?.(); this.unsubscribeAccount = undefined; this.client.close(); }
}
