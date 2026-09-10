import type { Graph } from '../core/brain';
import { getSpecies } from '../data/pokemon';
import type { GameState } from '../game/engine';
import { FieldSimulation, type FieldMember, type FieldPolicy } from '../game/field';
import { getRegion } from '../game/regions';
import type { ViewState } from '../game/storage';

/** A field has its own motor memories; battling does not change their input meaning. */
export class FieldSession {
  simulation!: FieldSimulation;
  paused = false;
  learning = true;
  selectedId = '';
  placingFood = false;
  private game?: GameState;
  private rosterKey = '';

  constructor(private graph: Graph, private policy?: FieldPolicy) {}

  sync(game: GameState, view: ViewState) {
    const members: FieldMember[] = game.player.team.map(monster => ({ id: monster.instanceId, speciesId: monster.speciesId }));
    // Two nearby observation subjects let a new trainer compare independent circuits.
    const nearby = getRegion(game.regionId).encounterIds.filter(id => !members.some(member => member.speciesId === id) && getSpecies(id).evolutions.length > 0);
    for (const id of nearby.slice(0, Math.max(0, 3 - members.length))) members.push({ id: `observe-${id}`, speciesId: id });
    const rosterKey = JSON.stringify(members);
    if (this.game !== game) {
      let seed = 2166136261;
      for (const char of game.seed) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
      this.simulation = new FieldSimulation(this.graph, view.field?.seed ?? seed, members, view.field, this.policy);
      this.paused = view.fieldPreferences?.paused ?? false;
      this.learning = view.fieldPreferences?.learning ?? true;
      this.selectedId = view.fieldPreferences?.selectedId ?? members[0].id;
      this.placingFood = false; this.game = game; this.rosterKey = rosterKey;
    } else if (this.rosterKey !== rosterKey) {
      this.simulation.setMembers(members); this.rosterKey = rosterKey;
    }
    if (!this.simulation.entities.some(entity => entity.id === this.selectedId)) this.selectedId = members[0].id;
    this.simulation.setPlayer(view.position.x, view.position.y);
  }

  save(view: ViewState) {
    if (!this.simulation) return;
    view.field = this.simulation.snapshot();
    view.fieldPreferences = { paused: this.paused, learning: this.learning, selectedId: this.selectedId };
  }

  name(id: string, speciesId: number) {
    return this.game?.player.team.find(monster => monster.instanceId === id)?.nickname ?? `${getSpecies(speciesId).name} · 관찰`;
  }
}
