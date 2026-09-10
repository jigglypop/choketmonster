import { Brain, validateGraph, type BrainState, type Graph } from '../core/brain.ts';
import { Random, clamp } from '../core/random.ts';
import { tileAt } from './map.ts';

export const FIELD_MODEL = 'pokemon-field-recurrent-v1';
export type FieldMember = { id: string; speciesId: number };
export type FieldFood = { id: number; x: number; y: number };
export type FieldTarget = { foodId: number; x: number; y: number };
export type FieldBrainState = Omit<BrainState, 'graph'> & { graphId: string };
export type FieldPolicy = { schema: 1; model: typeof FIELD_MODEL; graphId: string; trainingSeed: number; inputWeights: number[][]; readout: number[][]; note: string };
export type FieldEntity = { id: string; speciesId: number; x: number; y: number; heading: number; energy: number; readonly brain: Readonly<BrainState>; lastObservation: number[]; target?: FieldTarget; action: number; reward: number; foods: number; collisions: number };
export type FieldEntitySnapshot = Omit<FieldEntity, 'brain'> & { brain: FieldBrainState };
export type FieldSnapshot = { schema: 1; model: typeof FIELD_MODEL; graphId: string; seed: number; rng: number; tick: number; recurrentEnabled: boolean; player: { x: number; y: number }; foods: FieldFood[]; nextFoodId: number; entities: FieldEntitySnapshot[]; memories: FieldEntitySnapshot[] };
export type FieldEvent = { type: 'move' | 'wait' | 'collision' | 'food'; entityId: string; x: number; y: number; reward: number };
export type FieldStep = { tick: number; events: FieldEvent[] };

const DIRECTIONS = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }] as const;
const BLOCKED = new Set(['tree', 'water', 'building']);
const INITIAL_FOODS = 8;
const walkable = (x: number, y: number) => !BLOCKED.has(tileAt(x, y));
const key = (x: number, y: number) => `${x}:${y}`;
function hash(text: string): number { let value = 2166136261; for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0; return value || 0x6d2b79f5; }
function validMember(member: FieldMember): boolean { return !!member && typeof member.id === 'string' && !!member.id && Number.isInteger(member.speciesId) && member.speciesId >= 1 && member.speciesId <= 151; }
const validCoordinate = (value: number) => Number.isInteger(value) && value >= 0;
function stripGraph(state: BrainState): FieldBrainState { const { graph, ...memory } = structuredClone(state); return { ...memory, graphId: graph.id }; }

export class FieldSimulation {
  readonly graph: Graph;
  readonly seed: number;
  rng: Random;
  tick = 0;
  recurrentEnabled = true;
  player = { x: 12, y: 10 };
  foods: FieldFood[] = [];
  entities: FieldEntity[] = [];
  nextFoodId = 1;
  private readonly zeroGraph: Graph;
  private readonly brains = new Map<string, Brain>();
  private readonly memories = new Map<string, FieldEntity>();
  private policy?: FieldPolicy;

  constructor(graph: Graph, seed: number, members: FieldMember[], checkpoint?: FieldSnapshot, policy?: FieldPolicy) {
    validateGraph(graph);
    if (graph.kind !== 'connectome-subset') throw new Error('Field simulation requires a real connectome subset');
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Field seed must be uint32');
    this.graph = structuredClone(graph); this.zeroGraph = structuredClone(graph); this.zeroGraph.edges = this.zeroGraph.edges.map(edge => ({ ...edge, weight: 0 }));
    this.seed = seed >>> 0; this.rng = new Random(this.seed);
    if (policy) this.validatePolicy(policy); this.policy = policy ? structuredClone(policy) : undefined;
    if (checkpoint) this.restore(checkpoint);
    this.setMembers(members);
    if (!checkpoint) this.resetEpisode(this.seed);
  }

  setMembers(members: FieldMember[]): void {
    if (!Array.isArray(members) || members.length > 6 || !members.every(validMember) || new Set(members.map(member => member.id)).size !== members.length) throw new Error('Field supports up to 6 unique members with species 1..151');
    this.entities = members.map(member => {
      const retained = this.memories.get(member.id);
      if (retained) { retained.speciesId = member.speciesId; return retained; }
      const brain = new Brain(hash(`field:${member.id}`), this.graph); brain.state.sensoryBypass = false;
      if (this.policy) { brain.state.inputWeights = structuredClone(this.policy.inputWeights); brain.state.readout = structuredClone(this.policy.readout); }
      brain.state.graph = this.computationalGraph(); this.brains.set(member.id, brain);
      const entity: FieldEntity = { ...member, x: 0, y: 0, heading: 4, energy: 100, brain: brain.state, lastObservation: Array(12).fill(0), action: 4, reward: 0, foods: 0, collisions: 0 };
      this.memories.set(member.id, entity); return entity;
    });
    this.placeEntities();
  }

  setRecurrentEnabled(enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new Error('Recurrent mode must be boolean');
    this.recurrentEnabled = enabled; for (const brain of this.brains.values()) brain.state.graph = this.computationalGraph();
  }

  setPlayer(x: number, y: number): void {
    if (!validCoordinate(x) || !validCoordinate(y) || !walkable(x, y)) throw new Error('Player must be on a walkable tile');
    this.player = { x, y };
    const displaced = this.entities.find(entity => entity.x === x && entity.y === y);
    if (displaced) this.relocate(displaced, new Set([key(x, y), ...this.entities.filter(entity => entity !== displaced).map(entity => key(entity.x, entity.y)), ...this.foods.map(food => key(food.x, food.y))]));
  }

  dropFood(x: number, y: number): FieldFood {
    if (!validCoordinate(x) || !validCoordinate(y) || !walkable(x, y) || (this.player.x === x && this.player.y === y) || this.entities.some(entity => entity.x === x && entity.y === y) || this.foods.some(food => food.x === x && food.y === y)) throw new Error('Food must be dropped on an empty walkable tile');
    const food = { id: this.nextFoodId++, x, y }; this.foods.push(food); return structuredClone(food);
  }

  resetEpisode(seed = this.seed): void {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Episode seed must be uint32');
    this.rng = new Random(seed); this.tick = 0; this.foods = []; this.nextFoodId = 1; this.player = { x: 12, y: 10 };
    for (const entity of this.entities) { const brain = this.brain(entity.id); brain.resetEpisode(hash(`${seed}:${entity.id}`)); entity.energy = 100; entity.action = 4; entity.reward = 0; entity.foods = 0; entity.collisions = 0; entity.x = 0; entity.y = 0; entity.heading = 4; entity.lastObservation = Array(12).fill(0); entity.target = undefined; }
    this.placeEntities(); while (this.foods.length < INITIAL_FOODS) this.spawnFood();
  }

  step(learning: boolean, epsilon = learning ? 0.12 : 0): FieldStep {
    if (typeof learning !== 'boolean' || !Number.isFinite(epsilon) || epsilon < 0 || epsilon > 1) throw new Error('learning flag and epsilon must be valid');
    const events: FieldEvent[] = [], occupied = new Set(this.entities.map(entity => key(entity.x, entity.y))); occupied.add(key(this.player.x, this.player.y));
    for (const entity of this.entities) {
      const brain = this.brain(entity.id), target = this.nearestFood(entity); entity.target = target ? { foodId: target.id, x: target.x, y: target.y } : undefined;
      const before = target ? Math.abs(target.x - entity.x) + Math.abs(target.y - entity.y) : 0; entity.lastObservation = this.observe(entity, target, occupied);
      const action = brain.act(entity.lastObservation, this.tick ? entity.reward : null, learning, epsilon, 4);
      occupied.delete(key(entity.x, entity.y)); let reward = -0.01, type: FieldEvent['type'] = 'wait';
      if (action < 4) {
        const direction = DIRECTIONS[action as 0 | 1 | 2 | 3], x = entity.x + direction.x, y = entity.y + direction.y; entity.heading = action;
        if (!walkable(x, y) || occupied.has(key(x, y))) { reward -= 0.3; entity.collisions++; type = 'collision'; }
        else { entity.x = x; entity.y = y; entity.energy = Math.max(0, entity.energy - 0.12); type = 'move'; }
      } else entity.energy = Math.min(100, entity.energy + 0.02);
      const after = target ? Math.abs(target.x - entity.x) + Math.abs(target.y - entity.y) : before; reward += clamp(before - after, -1, 1) * 0.08;
      const foodIndex = this.foods.findIndex(food => food.x === entity.x && food.y === entity.y);
      if (foodIndex >= 0) { this.foods.splice(foodIndex, 1); entity.foods++; entity.energy = Math.min(100, entity.energy + 25); reward += 2; type = 'food'; this.spawnFood(occupied); }
      occupied.add(key(entity.x, entity.y)); entity.action = action; entity.reward = reward; events.push({ type, entityId: entity.id, x: entity.x, y: entity.y, reward });
    }
    this.tick++; return { tick: this.tick, events };
  }

  snapshot(): FieldSnapshot {
    const active = new Set(this.entities.map(entity => entity.id));
    const pack = (entity: FieldEntity): FieldEntitySnapshot => { const { brain: _brain, ...values } = entity; return { ...structuredClone(values), brain: stripGraph(this.brain(entity.id).state) }; };
    return { schema: 1, model: FIELD_MODEL, graphId: this.graph.id, seed: this.seed, rng: this.rng.state, tick: this.tick, recurrentEnabled: this.recurrentEnabled, player: structuredClone(this.player), foods: structuredClone(this.foods), nextFoodId: this.nextFoodId, entities: this.entities.map(pack), memories: [...this.memories.values()].filter(entity => !active.has(entity.id)).map(pack) };
  }

  private restore(checkpoint: FieldSnapshot): void {
    if (!checkpoint || checkpoint.schema !== 1 || checkpoint.model !== FIELD_MODEL || checkpoint.graphId !== this.graph.id || checkpoint.seed !== this.seed || !Number.isInteger(checkpoint.rng) || checkpoint.rng < 0 || checkpoint.rng > 0xffffffff || !Number.isSafeInteger(checkpoint.tick) || checkpoint.tick < 0 || typeof checkpoint.recurrentEnabled !== 'boolean' || !Number.isSafeInteger(checkpoint.nextFoodId) || checkpoint.nextFoodId < 1 || !Array.isArray(checkpoint.foods) || !Array.isArray(checkpoint.entities) || !Array.isArray(checkpoint.memories)) throw new Error('Invalid field checkpoint');
    if (!validCoordinate(checkpoint.player?.x) || !validCoordinate(checkpoint.player?.y) || !walkable(checkpoint.player.x, checkpoint.player.y)) throw new Error('Invalid field player position');
    for (const food of checkpoint.foods) if (!Number.isSafeInteger(food.id) || food.id < 1 || !validCoordinate(food.x) || !validCoordinate(food.y) || !walkable(food.x, food.y) || food.id >= checkpoint.nextFoodId) throw new Error('Invalid field food');
    if (new Set(checkpoint.foods.map(food => food.id)).size !== checkpoint.foods.length || new Set(checkpoint.foods.map(food => key(food.x, food.y))).size !== checkpoint.foods.length) throw new Error('Duplicate field food');
    this.recurrentEnabled = checkpoint.recurrentEnabled;
    const unpack = (saved: FieldEntitySnapshot): FieldEntity => {
      if (!validMember(saved) || !validCoordinate(saved.x) || !validCoordinate(saved.y) || !walkable(saved.x, saved.y) || !Number.isInteger(saved.heading) || saved.heading < 0 || saved.heading > 4 || !Number.isInteger(saved.action) || saved.action < 0 || saved.action > 4 || !Number.isFinite(saved.energy) || saved.energy < 0 || saved.energy > 100 || !Number.isFinite(saved.reward) || Math.abs(saved.reward) > 10 || !Number.isSafeInteger(saved.foods) || saved.foods < 0 || !Number.isSafeInteger(saved.collisions) || saved.collisions < 0 || !Array.isArray(saved.lastObservation) || saved.lastObservation.length !== 12 || !saved.lastObservation.every(Number.isFinite) || (saved.target !== undefined && (!Number.isSafeInteger(saved.target.foodId) || saved.target.foodId < 1 || !validCoordinate(saved.target.x) || !validCoordinate(saved.target.y) || !walkable(saved.target.x, saved.target.y)))) throw new Error('Invalid field entity');
      if (saved.brain.graphId !== this.graph.id) throw new Error('Field brain graph does not match');
      if (saved.brain.sensoryBypass !== false) throw new Error('Field brain sensory bypass must be disabled');
      const { graphId: _graphId, ...memory } = structuredClone(saved.brain); const brain = Brain.restore({ ...memory, graph: this.computationalGraph() }); brain.state.graph = this.computationalGraph(); this.brains.set(saved.id, brain);
      const entity = { ...structuredClone(saved), brain: brain.state } as FieldEntity; this.memories.set(entity.id, entity); return entity;
    };
    const saved = [...checkpoint.entities, ...checkpoint.memories]; if (new Set(saved.map(entity => entity.id)).size !== saved.length) throw new Error('Duplicate field memory');
    this.rng = new Random(checkpoint.rng); this.tick = checkpoint.tick; this.player = structuredClone(checkpoint.player); this.foods = structuredClone(checkpoint.foods); this.nextFoodId = checkpoint.nextFoodId;
    const activeIds = new Set(checkpoint.entities.map(entity => entity.id)); saved.map(unpack); this.entities = [...this.memories.values()].filter(entity => activeIds.has(entity.id));
    const occupied = [this.player, ...this.entities].map(value => key(value.x, value.y)); if (new Set(occupied).size !== occupied.length || checkpoint.foods.some(food => occupied.includes(key(food.x, food.y)))) throw new Error('Field checkpoint has collisions');
  }

  private brain(id: string): Brain { const brain = this.brains.get(id); if (!brain) throw new Error(`Missing field brain ${id}`); return brain; }
  private computationalGraph(): Graph { return this.recurrentEnabled ? this.graph : this.zeroGraph; }
  private observe(entity: FieldEntity, target: FieldFood | undefined, occupied: Set<string>): number[] {
    const dx = target ? target.x - entity.x : 0, dy = target ? target.y - entity.y : 0;
    const blocked = DIRECTIONS.map(direction => !walkable(entity.x + direction.x, entity.y + direction.y) || occupied.has(key(entity.x + direction.x, entity.y + direction.y)) ? 1 : 0);
    return [1, dx / 21, dy / 12, Math.sign(dx), Math.sign(dy), Math.abs(dx) / 21, Math.abs(dy) / 12, ...blocked, entity.energy / 100];
  }
  private nearestFood(entity: FieldEntity): FieldFood | undefined { return [...this.foods].sort((a, b) => (Math.abs(a.x - entity.x) + Math.abs(a.y - entity.y)) - (Math.abs(b.x - entity.x) + Math.abs(b.y - entity.y)) || a.id - b.id)[0]; }
  private validatePolicy(policy: FieldPolicy): void { if (!policy || policy.schema !== 1 || policy.model !== FIELD_MODEL || policy.graphId !== this.graph.id || !Array.isArray(policy.inputWeights) || !Array.isArray(policy.readout)) throw new Error('Invalid field policy'); const probe = new Brain(1, this.graph); probe.state.sensoryBypass = false; probe.state.inputWeights = structuredClone(policy.inputWeights); probe.state.readout = structuredClone(policy.readout); Brain.restore(probe.snapshot()); }
  private placeEntities(): void { const occupied = new Set([key(this.player.x, this.player.y), ...this.foods.map(food => key(food.x, food.y))]); for (const entity of this.entities) { if (walkable(entity.x, entity.y) && !occupied.has(key(entity.x, entity.y))) occupied.add(key(entity.x, entity.y)); else this.relocate(entity, occupied); } }
  private relocate(entity: FieldEntity, occupied: Set<string>): void { for (let attempt = 0; attempt < 500; attempt++) { const x = 1 + this.rng.int(22), y = 1 + this.rng.int(13); if (walkable(x, y) && !occupied.has(key(x, y))) { entity.x = x; entity.y = y; occupied.add(key(x, y)); return; } } throw new Error('No open tile for field entity'); }
  private spawnFood(extraOccupied = new Set<string>()): FieldFood { const occupied = new Set([...extraOccupied, key(this.player.x, this.player.y), ...this.entities.map(entity => key(entity.x, entity.y)), ...this.foods.map(food => key(food.x, food.y))]); for (let attempt = 0; attempt < 500; attempt++) { const x = 1 + this.rng.int(22), y = 1 + this.rng.int(13); if (walkable(x, y) && !occupied.has(key(x, y))) { const food = { id: this.nextFoodId++, x, y }; this.foods.push(food); return food; } } throw new Error('No open tile for field food'); }
}
