import { Brain, validateGraph, type BrainState, type Graph } from '../core/brain';
import { Random, clamp } from '../core/random';
import { POKEMON, getSpecies } from '../data/pokemon';
import { ConnectomeController } from '../game/connectome';
import { actBattle, availableEvolutions, createMonster, evolve, validateGame, type BallItem, type BattleAction, type BattleTurnResult, type GameState } from '../game/engine';
import type { FieldPolicy } from '../game/field';

export const OPEN_WORLD_MODEL = 'pokemon-open-world-recurrent-v1' as const;
export const WORLD_MIN = -120;
export const WORLD_MAX = 120;
export const DEFAULT_WILD_COUNT = 15;
export type WorldBiome = 'meadow' | 'forest' | 'lake' | 'rock';
export type WorldSample = { height: number; biome: WorldBiome; blocked: boolean };
export type WorldPosition = { x: number; z: number; heading: number };
export type WorldFood = { id: number; x: number; z: number };
export type WorldTarget = { kind: 'food' | 'player' | 'wild'; id: string; x: number; z: number };
export type WorldBrainState = Omit<BrainState, 'graph'> & { graphId: string };
export type OpenWorldEntity = {
  id: string; kind: 'wild' | 'companion'; speciesId: number; level: number;
  x: number; z: number; heading: number; energy: number;
  readonly brain: Readonly<BrainState>; observation: number[]; action: number; reward: number;
  foods: number; collisions: number; target?: WorldTarget;
};
export type OpenWorldEntitySnapshot = Omit<OpenWorldEntity, 'brain'> & { brain: WorldBrainState };
export type OpenWorldSnapshot = {
  schema: 1; model: typeof OPEN_WORLD_MODEL; graphId: string; seed: number; rng: number; tick: number;
  player: WorldPosition; selectedWildId?: string; autoCapture: boolean; battleWildId?: string;
  battleElapsed: number; pendingCapture: boolean; pendingBall?: BallItem; lastPlayerReward: number | null; lastEnemyReward: number | null;
  spawnSerial: number; nextFoodId: number; foods: WorldFood[]; entities: OpenWorldEntitySnapshot[];
};
export type OpenWorldEvent =
  | { type: 'move' | 'wait' | 'collision' | 'food'; entityId: string; x: number; z: number; reward: number }
  | { type: 'encounter'; entityId: string; speciesId: number; level: number }
  | { type: 'battle-turn'; entityId: string; result: BattleTurnResult }
  | { type: 'evolved'; entityId: string; fromSpeciesId: number; speciesId: number };
export type OpenWorldStep = { tick: number; events: OpenWorldEvent[]; battleActive: boolean };
export type OpenWorldSave = { schema: 1; model: typeof OPEN_WORLD_MODEL; graphId: string; game: unknown; world: OpenWorldSnapshot };

const STEP_DISTANCE = 1.15;
const BATTLE_INTERVAL = 0.9;
const DIRECTIONS = [{ x: 0, z: -1 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }] as const;
const finite = (value: number) => typeof value === 'number' && Number.isFinite(value);
const key = (x: number, z: number) => `${x.toFixed(2)}:${z.toFixed(2)}`;
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
function hash(text: string): number { let value = 2166136261; for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0; return value || 0x6d2b79f5; }
function stripGraph(state: BrainState): WorldBrainState { const { graph, ...rest } = structuredClone(state); return { ...rest, graphId: graph.id }; }

/** Shared deterministic terrain contract. Rendering may sample it freely without consuming simulation RNG. */
export function sampleWorld(x: number, z: number): WorldSample {
  const height = 1.5 * Math.sin(x * .055) + 1.1 * Math.cos(z * .047) + .45 * Math.sin((x + z) * .11);
  if (!finite(x) || !finite(z) || x < WORLD_MIN || x > WORLD_MAX || z < WORLD_MIN || z > WORLD_MAX) return { height, biome: 'rock', blocked: true };
  const lakeDistance = Math.hypot(x - 42, z + 28);
  if (lakeDistance < 34) return { height: Math.min(height, -.8), biome: 'lake', blocked: lakeDistance < 19 };
  if (x < -28 && z < 45) {
    const tree = Math.sin(x * .41 + z * .17) + Math.cos(z * .37 - x * .13) > 1.55;
    return { height, biome: 'forest', blocked: tree };
  }
  if (z > 50 || (x > 62 && z > 18)) {
    const rock = Math.sin(x * .29) * Math.cos(z * .31) > .72;
    return { height: height + Math.max(0, z - 45) * .035, biome: 'rock', blocked: rock };
  }
  return { height, biome: 'meadow', blocked: false };
}

export function biomeForSpecies(speciesId: number): WorldBiome {
  const habitat = getSpecies(speciesId).habitat;
  if (habitat === 'forest') return 'forest';
  if (habitat === 'sea' || habitat === 'waters-edge') return 'lake';
  if (habitat === 'mountain' || habitat === 'rough-terrain' || habitat === 'cave' || habitat === 'rare') return 'rock';
  return 'meadow';
}

export function speciesForSpawn(serial: number): number {
  if (!Number.isSafeInteger(serial) || serial < 1) throw new Error('Spawn serial must be a positive integer');
  return ((serial - 1) % 151) + 1;
}

export class OpenWorldSimulation {
  readonly graph: Graph;
  readonly seed: number;
  readonly game: GameState;
  rng: Random;
  tick = 0;
  player: WorldPosition = { x: 0, z: 0, heading: 2 };
  foods: WorldFood[] = [];
  entities: OpenWorldEntity[] = [];
  selectedWildId?: string;
  autoCapture = false;
  battleWildId?: string;
  battleElapsed = 0;
  spawnSerial = 1;
  nextFoodId = 1;
  private pendingCapture = false;
  private pendingBall?: BallItem;
  private lastPlayerReward: number | null = null;
  private lastEnemyReward: number | null = null;
  private readonly brains = new Map<string, Brain>();
  private readonly battleController: ConnectomeController;
  private readonly policy?: FieldPolicy;

  constructor(graph: Graph, game: GameState, seed: number, checkpoint?: OpenWorldSnapshot, policy?: FieldPolicy, wildCount = DEFAULT_WILD_COUNT) {
    validateGraph(graph); if (graph.kind !== 'connectome-subset') throw new Error('Open world requires a real connectome subset');
    validateGame(game); if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Open-world seed must be uint32');
    if (!Number.isInteger(wildCount) || wildCount < 12 || wildCount > 18) throw new Error('Open world requires 12..18 wild Pokemon');
    this.graph = structuredClone(graph); this.game = game; this.seed = seed >>> 0; this.rng = new Random(this.seed);
    this.battleController = new ConnectomeController(this.graph); this.policy = policy ? structuredClone(policy) : undefined;
    if (this.policy && (this.policy.graphId !== graph.id || this.policy.schema !== 1)) throw new Error('Open-world field policy does not match graph');
    if (checkpoint) this.restore(checkpoint);
    else {
      this.entities.push(this.makeCompanion());
      while (this.wildEntities().length < wildCount) this.spawnWild();
      while (this.foods.length < 24) this.spawnFood();
    }
  }

  movePlayer(position: WorldPosition): boolean {
    if (![position.x, position.z, position.heading].every(finite) || !Number.isInteger(position.heading) || position.heading < 0 || position.heading > 4) throw new Error('Invalid player position');
    const next = { x: clamp(position.x, WORLD_MIN, WORLD_MAX), z: clamp(position.z, WORLD_MIN, WORLD_MAX), heading: position.heading };
    if (sampleWorld(next.x, next.z).blocked) return false;
    this.player = next; return true;
  }

  selectWild(id: string | null): void {
    if (id === null) { this.selectedWildId = undefined; return; }
    const entity = this.entities.find(item => item.kind === 'wild' && item.id === id); if (!entity) throw new Error('Unknown wild Pokemon');
    this.selectedWildId = id;
  }

  setAutoCapture(enabled: boolean): void { if (typeof enabled !== 'boolean') throw new Error('Auto-capture flag must be boolean'); this.autoCapture = enabled; }

  requestCapture(ball?: BallItem): boolean {
    if (!this.game.battle || !this.battleWildId) return false;
    const selected = ball ?? this.bestBall(); if (!selected || this.game.inventory[selected] <= 0) return false;
    this.pendingCapture = true; this.pendingBall = selected; return true;
  }

  startEncounter(id: string): boolean {
    if (this.game.battle) return false;
    const entity = this.entities.find(item => item.kind === 'wild' && item.id === id); if (!entity) return false;
    const healthy = this.game.player.team.findIndex(monster => monster.hp > 0); if (healthy < 0) return false;
    const wild = createMonster(this.game, entity.speciesId, entity.level);
    this.game.dex.seen = [...new Set([...this.game.dex.seen, entity.speciesId])].sort((a, b) => a - b);
    this.game.battle = { kind: 'wild', regionId: this.game.regionId, player: { team: this.game.player.team, activeIndex: healthy }, enemy: { team: [wild], activeIndex: 0 }, turn: 1, canRun: true };
    this.game.logs.push(`오픈월드에서 ${getSpecies(entity.speciesId).name}을(를) 만났다.`); if (this.game.logs.length > 200) this.game.logs.shift();
    this.battleWildId = id; this.battleElapsed = 0; this.pendingCapture = false; this.pendingBall = undefined; this.lastPlayerReward = null; this.lastEnemyReward = null;
    return true;
  }

  step(options: { deltaSeconds?: number; learning?: boolean } = {}): OpenWorldStep {
    const deltaSeconds = options.deltaSeconds ?? .25, learning = options.learning ?? false;
    if (!finite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 5 || typeof learning !== 'boolean') throw new Error('Invalid open-world step options');
    const events: OpenWorldEvent[] = [];
    this.syncCompanion();
    if (!this.game.battle) {
      this.stepMovement(learning, events);
      const selected = this.selectedWildId ? this.entities.find(entity => entity.id === this.selectedWildId) : undefined;
      const contact = selected && distance(selected, this.player) <= 4 ? selected : this.wildEntities().find(entity => distance(entity, this.player) <= 1.4);
      if (contact && this.startEncounter(contact.id)) events.push({ type: 'encounter', entityId: contact.id, speciesId: contact.speciesId, level: contact.level });
    } else if (!this.battleWildId) throw new Error('Open-world battle is missing its wild entity');

    if (this.game.battle) {
      this.battleElapsed += deltaSeconds;
      while (this.game.battle && this.battleElapsed >= BATTLE_INTERVAL) {
        this.battleElapsed -= BATTLE_INTERVAL;
        const battleEvent = this.advanceBattle(learning, events); if (battleEvent) events.push(battleEvent);
      }
    }
    this.tick++; return { tick: this.tick, events, battleActive: !!this.game.battle };
  }

  visibleEntities(max = 12): OpenWorldEntity[] {
    if (!Number.isInteger(max) || max < 1 || max > 18) throw new Error('Visible entity limit must be 1..18');
    return [...this.entities].sort((a, b) => this.priority(a) - this.priority(b) || distance(a, this.player) - distance(b, this.player) || a.id.localeCompare(b.id)).slice(0, max);
  }

  snapshot(): OpenWorldSnapshot {
    const pack = (entity: OpenWorldEntity): OpenWorldEntitySnapshot => { const { brain: _brain, ...rest } = entity; return { ...structuredClone(rest), brain: stripGraph(this.brain(entity.id).state) }; };
    return { schema: 1, model: OPEN_WORLD_MODEL, graphId: this.graph.id, seed: this.seed, rng: this.rng.state, tick: this.tick,
      player: structuredClone(this.player), selectedWildId: this.selectedWildId, autoCapture: this.autoCapture, battleWildId: this.battleWildId,
      battleElapsed: this.battleElapsed, pendingCapture: this.pendingCapture, pendingBall: this.pendingBall, lastPlayerReward: this.lastPlayerReward, lastEnemyReward: this.lastEnemyReward,
      spawnSerial: this.spawnSerial, nextFoodId: this.nextFoodId, foods: structuredClone(this.foods), entities: this.entities.map(pack) };
  }

  spawnCatalog(): Array<{ speciesId: number; biome: WorldBiome }> { return POKEMON.map((_, index) => { const speciesId = speciesForSpawn(index + 1); return { speciesId, biome: biomeForSpecies(speciesId) }; }); }

  private stepMovement(learning: boolean, events: OpenWorldEvent[]): void {
    const occupied: Array<{ x: number; z: number }> = [];
    for (const entity of this.entities) {
      const target = this.targetFor(entity); entity.target = target;
      const before = target ? distance(entity, target) : 0; entity.observation = this.observe(entity, target, occupied);
      const brain = this.brain(entity.id), action = brain.act(entity.observation, this.tick ? entity.reward : null, learning, learning ? .12 : 0, 4);
      let reward = -.005, type: 'move' | 'wait' | 'collision' | 'food' = 'wait';
      if (action < 4) {
        const direction = DIRECTIONS[action as 0 | 1 | 2 | 3], x = entity.x + direction.x * STEP_DISTANCE, z = entity.z + direction.z * STEP_DISTANCE;
        entity.heading = action;
        if (sampleWorld(x, z).blocked || occupied.some(point => Math.hypot(point.x - x, point.z - z) < 1)) { reward -= .2; entity.collisions++; type = 'collision'; }
        else { entity.x = x; entity.z = z; entity.energy = Math.max(0, entity.energy - .04); type = 'move'; }
      } else entity.energy = Math.min(100, entity.energy + .025);
      if (target) reward += clamp(before - distance(entity, target), -STEP_DISTANCE, STEP_DISTANCE) * .05;
      if (entity.kind === 'wild') {
        const foodIndex = this.foods.findIndex(food => distance(food, entity) < 1.25);
        if (foodIndex >= 0) { this.foods.splice(foodIndex, 1); entity.foods++; entity.energy = Math.min(100, entity.energy + 20); reward += 1.5; type = 'food'; this.spawnFood(); }
      }
      entity.action = action; entity.reward = reward; occupied.push({ x: entity.x, z: entity.z });
      events.push({ type, entityId: entity.id, x: entity.x, z: entity.z, reward });
    }
  }

  private advanceBattle(learning: boolean, events: OpenWorldEvent[]): Extract<OpenWorldEvent, { type: 'battle-turn' }> | undefined {
    const battle = this.game.battle, entityId = this.battleWildId; if (!battle || !entityId) return undefined;
    const player = battle.player.team[battle.player.activeIndex], enemy = battle.enemy.team[battle.enemy.activeIndex];
    let action: BattleAction;
    if (battle.awaitingSwitch) {
      const index = battle.player.team.findIndex(monster => monster.hp > 0); action = { type: 'switch', index };
    } else if ((this.pendingCapture || (this.autoCapture && enemy.hp / enemy.stats.hp <= .35)) && (this.pendingBall ?? this.bestBall())) {
      action = { type: 'catch', ball: (this.pendingBall ?? this.bestBall())! }; this.pendingCapture = false; this.pendingBall = undefined;
    } else {
      const decision = this.battleController.choose(player, enemy, battle.turn, this.lastPlayerReward, learning);
      action = decision.action < 4 ? { type: 'move', index: decision.action } : { type: 'wait' };
    }
    const playerHp = player.hp, enemyHp = enemy.hp;
    const enemyDecision = this.battleController.choose(enemy, player, battle.turn, this.lastEnemyReward, learning);
    const result = actBattle(this.game, action, enemyDecision.action);
    this.lastPlayerReward = clamp((enemyHp - enemy.hp) / Math.max(1, enemy.stats.hp) - (playerHp - player.hp) / Math.max(1, player.stats.hp), -1, 1);
    this.lastEnemyReward = -this.lastPlayerReward;
    if (result.battleEnded) {
      this.battleController.finish(player, result.outcome === 'won' ? 1 : result.outcome === 'lost' ? -1 : .25, learning);
      this.battleController.finish(enemy, result.outcome === 'lost' ? 1 : result.outcome === 'won' ? -1 : 0, learning);
      const removed = this.entities.find(entity => entity.id === entityId);
      if (removed) this.removeWild(entityId);
      if (result.outcome === 'won') this.autoEvolve(events);
      this.battleWildId = undefined; this.selectedWildId = undefined; this.battleElapsed = 0; this.pendingCapture = false; this.pendingBall = undefined; this.lastPlayerReward = null; this.lastEnemyReward = null;
    }
    return { type: 'battle-turn', entityId, result };
  }

  private autoEvolve(events: OpenWorldEvent[]): void {
    for (const monster of this.game.player.team) {
      for (;;) {
        const candidate = availableEvolutions(this.game, monster.instanceId).find(option => option.method === 'level'); if (!candidate) break;
        const fromSpeciesId = monster.speciesId;
        evolve(this.game, monster.instanceId, { targetId: candidate.target });
        events.push({ type: 'evolved', entityId: monster.instanceId, fromSpeciesId, speciesId: monster.speciesId });
      }
    }
    this.syncCompanion();
  }

  private makeCompanion(): OpenWorldEntity {
    const lead = this.game.player.team[0], id = `companion:${lead.instanceId}`;
    return this.makeEntity(id, 'companion', lead.speciesId, lead.level, { x: -2, z: 2 });
  }

  private syncCompanion(): void {
    const lead = this.game.player.team.find(monster => monster.hp > 0) ?? this.game.player.team[0];
    let companion = this.entities.find(entity => entity.kind === 'companion');
    const expectedId = `companion:${lead.instanceId}`;
    if (!companion || companion.id !== expectedId) {
      if (companion) { this.entities.splice(this.entities.indexOf(companion), 1); this.brains.delete(companion.id); }
      companion = this.makeEntity(expectedId, 'companion', lead.speciesId, lead.level, { x: this.player.x - 2, z: this.player.z + 2 }); this.entities.unshift(companion);
    }
    companion.speciesId = lead.speciesId; companion.level = lead.level;
  }

  private spawnWild(): OpenWorldEntity {
    const speciesId = speciesForSpawn(this.spawnSerial), id = `wild-${this.spawnSerial++}`, biome = biomeForSpecies(speciesId);
    const position = this.openPosition(biome, 10), radial = Math.hypot(position.x, position.z);
    const level = Math.max(2, Math.min(85, 2 + Math.floor((radial / 170) ** 1.6 * 78) + this.rng.int(4)));
    const entity = this.makeEntity(id, 'wild', speciesId, level, position); this.entities.push(entity); return entity;
  }

  private removeWild(id: string): void {
    const index = this.entities.findIndex(entity => entity.id === id); if (index >= 0) this.entities.splice(index, 1);
    this.brains.delete(id); this.spawnWild();
  }

  private makeEntity(id: string, kind: OpenWorldEntity['kind'], speciesId: number, level: number, position: { x: number; z: number }): OpenWorldEntity {
    const brain = new Brain(hash(`openworld:${id}`), this.graph); brain.state.sensoryBypass = false;
    if (this.policy) { brain.state.inputWeights = structuredClone(this.policy.inputWeights); brain.state.readout = structuredClone(this.policy.readout); }
    brain.state.graph = this.graph;
    this.brains.set(id, brain);
    return { id, kind, speciesId, level, x: position.x, z: position.z, heading: 4, energy: 100, brain: brain.state,
      observation: Array(12).fill(0), action: 4, reward: 0, foods: 0, collisions: 0 };
  }

  private targetFor(entity: OpenWorldEntity): WorldTarget | undefined {
    if (entity.kind === 'companion') {
      const selected = this.selectedWildId ? this.entities.find(item => item.id === this.selectedWildId) : undefined;
      return selected ? { kind: 'wild', id: selected.id, x: selected.x, z: selected.z } : { kind: 'player', id: 'player', x: this.player.x, z: this.player.z };
    }
    const food = [...this.foods].sort((a, b) => distance(entity, a) - distance(entity, b) || a.id - b.id)[0];
    return food ? { kind: 'food', id: String(food.id), x: food.x, z: food.z } : undefined;
  }

  private observe(entity: OpenWorldEntity, target: WorldTarget | undefined, occupied: Array<{ x: number; z: number }>): number[] {
    const dx = target ? target.x - entity.x : 0, dz = target ? target.z - entity.z : 0;
    const blocked = DIRECTIONS.map(direction => {
      const x = entity.x + direction.x * STEP_DISTANCE, z = entity.z + direction.z * STEP_DISTANCE;
      return sampleWorld(x, z).blocked || occupied.some(point => Math.hypot(point.x - x, point.z - z) < 1) ? 1 : 0;
    });
    return [1, dx / 240, dz / 240, Math.sign(dx), Math.sign(dz), Math.abs(dx) / 240, Math.abs(dz) / 240, ...blocked, entity.energy / 100];
  }

  private openPosition(biome: WorldBiome, awayFromPlayer: number): { x: number; z: number } {
    for (let attempt = 0; attempt < 3000; attempt++) {
      const x = WORLD_MIN + 3 + this.rng.next() * (WORLD_MAX - WORLD_MIN - 6), z = WORLD_MIN + 3 + this.rng.next() * (WORLD_MAX - WORLD_MIN - 6);
      const sample = sampleWorld(x, z);
      if (!sample.blocked && sample.biome === biome && Math.hypot(x - this.player.x, z - this.player.z) >= awayFromPlayer && !this.entities.some(entity => Math.hypot(entity.x - x, entity.z - z) < 3) && !this.foods.some(food => Math.hypot(food.x - x, food.z - z) < 2)) return { x, z };
    }
    throw new Error(`No open ${biome} position`);
  }

  private spawnFood(): void {
    const biomes: WorldBiome[] = ['meadow', 'forest', 'lake', 'rock']; const position = this.openPosition(biomes[this.rng.int(biomes.length)], 4);
    this.foods.push({ id: this.nextFoodId++, ...position });
  }

  private brain(id: string): Brain { const brain = this.brains.get(id); if (!brain) throw new Error(`Missing open-world brain ${id}`); return brain; }
  private wildEntities(): OpenWorldEntity[] { return this.entities.filter(entity => entity.kind === 'wild'); }
  private bestBall(): BallItem | undefined { return (['ultra-ball', 'great-ball', 'poke-ball'] as BallItem[]).find(ball => this.game.inventory[ball] > 0); }
  private priority(entity: OpenWorldEntity): number { return entity.id === this.battleWildId ? 0 : entity.id === this.selectedWildId ? 1 : entity.kind === 'companion' ? 2 : 3; }

  private restore(checkpoint: OpenWorldSnapshot): void {
    if (!checkpoint || checkpoint.schema !== 1 || checkpoint.model !== OPEN_WORLD_MODEL || checkpoint.graphId !== this.graph.id || checkpoint.seed !== this.seed || !Number.isInteger(checkpoint.rng) || checkpoint.rng < 0 || checkpoint.rng > 0xffffffff || !Number.isSafeInteger(checkpoint.tick) || checkpoint.tick < 0 || !finite(checkpoint.battleElapsed) || checkpoint.battleElapsed < 0 || checkpoint.battleElapsed >= BATTLE_INTERVAL || typeof checkpoint.autoCapture !== 'boolean' || typeof checkpoint.pendingCapture !== 'boolean' || (checkpoint.pendingBall !== undefined && !['poke-ball', 'great-ball', 'ultra-ball'].includes(checkpoint.pendingBall)) || ![checkpoint.lastPlayerReward, checkpoint.lastEnemyReward].every(value => value === null || (finite(value) && Math.abs(value) <= 1)) || !Number.isSafeInteger(checkpoint.spawnSerial) || checkpoint.spawnSerial < 1 || !Number.isSafeInteger(checkpoint.nextFoodId) || checkpoint.nextFoodId < 1 || !Array.isArray(checkpoint.foods) || !Array.isArray(checkpoint.entities)) throw new Error('Invalid open-world checkpoint');
    if (![checkpoint.player?.x, checkpoint.player?.z, checkpoint.player?.heading].every(finite) || !Number.isInteger(checkpoint.player.heading) || checkpoint.player.heading < 0 || checkpoint.player.heading > 4 || sampleWorld(checkpoint.player.x, checkpoint.player.z).blocked) throw new Error('Invalid open-world player');
    if (checkpoint.entities.filter(entity => entity.kind === 'wild').length < 12 || checkpoint.entities.filter(entity => entity.kind === 'wild').length > 18 || checkpoint.entities.filter(entity => entity.kind === 'companion').length !== 1 || new Set(checkpoint.entities.map(entity => entity.id)).size !== checkpoint.entities.length) throw new Error('Invalid open-world roster');
    for (const food of checkpoint.foods) if (!Number.isSafeInteger(food.id) || food.id < 1 || food.id >= checkpoint.nextFoodId || !finite(food.x) || !finite(food.z) || sampleWorld(food.x, food.z).blocked) throw new Error('Invalid open-world food');
    if (new Set(checkpoint.foods.map(food => food.id)).size !== checkpoint.foods.length || new Set(checkpoint.foods.map(food => key(food.x, food.z))).size !== checkpoint.foods.length) throw new Error('Duplicate open-world food');
    for (const saved of checkpoint.entities) {
      if (!saved || typeof saved.id !== 'string' || !saved.id || !['wild', 'companion'].includes(saved.kind) || !Number.isInteger(saved.speciesId) || saved.speciesId < 1 || saved.speciesId > 151 || !Number.isInteger(saved.level) || saved.level < 1 || saved.level > 100 || !finite(saved.x) || !finite(saved.z) || sampleWorld(saved.x, saved.z).blocked || !Number.isInteger(saved.heading) || saved.heading < 0 || saved.heading > 4 || !Number.isInteger(saved.action) || saved.action < 0 || saved.action > 4 || !finite(saved.energy) || saved.energy < 0 || saved.energy > 100 || !finite(saved.reward) || Math.abs(saved.reward) > 10 || !Number.isSafeInteger(saved.foods) || saved.foods < 0 || !Number.isSafeInteger(saved.collisions) || saved.collisions < 0 || !Array.isArray(saved.observation) || saved.observation.length !== 12 || !saved.observation.every(finite) || saved.brain?.graphId !== this.graph.id || saved.brain.sensoryBypass !== false) throw new Error('Invalid open-world entity');
      const { graphId: _graphId, ...state } = structuredClone(saved.brain), brain = Brain.restore({ ...state, graph: this.graph }); brain.state.graph = this.graph; this.brains.set(saved.id, brain);
      const { brain: _savedBrain, ...rest } = structuredClone(saved); this.entities.push({ ...rest, brain: brain.state });
    }
    if (checkpoint.selectedWildId !== undefined && !this.entities.some(entity => entity.kind === 'wild' && entity.id === checkpoint.selectedWildId)) throw new Error('Invalid selected wild Pokemon');
    if ((checkpoint.battleWildId !== undefined) !== !!this.game.battle || (checkpoint.battleWildId && !this.entities.some(entity => entity.kind === 'wild' && entity.id === checkpoint.battleWildId))) throw new Error('Open-world battle does not match game');
    this.rng = new Random(checkpoint.rng); this.tick = checkpoint.tick; this.player = structuredClone(checkpoint.player); this.foods = structuredClone(checkpoint.foods);
    this.selectedWildId = checkpoint.selectedWildId; this.autoCapture = checkpoint.autoCapture; this.battleWildId = checkpoint.battleWildId; this.battleElapsed = checkpoint.battleElapsed;
    this.pendingCapture = checkpoint.pendingCapture; this.pendingBall = checkpoint.pendingBall; this.lastPlayerReward = checkpoint.lastPlayerReward; this.lastEnemyReward = checkpoint.lastEnemyReward;
    this.spawnSerial = checkpoint.spawnSerial; this.nextFoodId = checkpoint.nextFoodId;
  }
}

export function serializeOpenWorld(game: GameState, simulation: OpenWorldSimulation): string {
  if (game !== simulation.game) throw new Error('Open-world save game does not match simulation');
  const packedGame = JSON.parse(JSON.stringify(game, (keyName, value) => keyName === 'graph' ? undefined : value));
  const save: OpenWorldSave = { schema: 1, model: OPEN_WORLD_MODEL, graphId: simulation.graph.id, game: packedGame, world: simulation.snapshot() };
  return JSON.stringify(save);
}

export function restoreOpenWorld(graph: Graph, json: string, policy?: FieldPolicy): { game: GameState; simulation: OpenWorldSimulation } {
  let value: OpenWorldSave; try { value = JSON.parse(json) as OpenWorldSave; } catch { throw new Error('Open-world save JSON cannot be read'); }
  if (!value || value.schema !== 1 || value.model !== OPEN_WORLD_MODEL || value.graphId !== graph.id || !value.world) throw new Error('Invalid open-world save');
  const game = value.game as GameState;
  const monsters = [...(game.player?.team ?? []), ...(game.player?.box ?? []), ...(game.battle?.player?.team ?? []), ...(game.battle?.enemy?.team ?? [])];
  for (const monster of monsters) if (monster.brain) monster.brain.graph = structuredClone(graph);
  validateGame(game);
  if (game.battle) game.battle.player.team = game.player.team;
  return { game, simulation: new OpenWorldSimulation(graph, game, value.world.seed, value.world, policy, value.world.entities.filter(entity => entity.kind === 'wild').length) };
}
