import { Brain, validateGraph, type BrainState, type Graph } from '../core/brain';
import { Random, clamp } from '../core/random';
import { POKEMON, getMove, getSpecies } from '../data/pokemon';
import { ConnectomeController } from '../game/connectome';
import { actBattle, availableEvolutions, captureDefeatedWild, createMonster, evolve, validateGame, type BallItem, type BattleAction, type BattleTurnResult, type GameState, type Monster } from '../game/engine';
import { KANTO_START, KANTO_LOCATIONS, KANTO_GYMS, KANTO_MAP_VERSION, locationAt, encountersForLocation, sampleKantoWorld, evaluateKantoTraversal, nearestKantoWalkable, kantoTravelPoint, safeKantoArrival } from './kanto';
import { REGIONS } from '../game/regions';
import type { FieldPolicy } from '../game/field';
import { appendReward, emptyRewardLedger, rewardEncounter, rewardBattleTurn, validateRewardLedger, type EngineeredReward, type RewardLedger, type RewardDecisionSource } from '../game/rewards';

export const OPEN_WORLD_MODEL = 'pokemon-open-world-recurrent-v1' as const;
export const WORLD_MIN = -120;
export const WORLD_MAX = 120;
export const DEFAULT_WILD_COUNT = 15;
export type WorldBiome = 'meadow' | 'forest' | 'lake' | 'rock';
export type WorldSample = { height: number; biome: WorldBiome; blocked: boolean };
export type WorldPosition = { x: number; z: number; heading: number };
export type WorldFood = { id: number; x: number; z: number };
export type WorldRespawn = { id: string; speciesId: number; level: number; biome: WorldBiome; originX: number; originZ: number; remainingSeconds: number };
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
  player: WorldPosition; selectedWildId?: string; autoCapture: boolean; autoHunt?: boolean; battleWildId?: string;
  battleElapsed: number; pendingCapture: boolean; pendingBall?: BallItem; lastPlayerReward: number | null; lastEnemyReward: number | null;
  pendingAction?: BattleAction;
  manualControlRemaining?: number;
  controlMode?: 'auto' | 'manual';
  selectionPinned?: boolean;
  trackingSelected?: boolean;
  visitedTownIds?: string[];
  rewardLedgers?: Record<string, RewardLedger>;
  mapVersion?: 'kanto-v1' | 'kanto-v2';
  densityRemaining?: number;
  spawnSerial: number; nextFoodId: number; foods: WorldFood[]; respawnQueue?: WorldRespawn[]; entities: OpenWorldEntitySnapshot[]; companionMemories?: OpenWorldEntitySnapshot[];
};
export type OpenWorldEvent =
  | { type: 'move' | 'wait' | 'collision' | 'food'; entityId: string; x: number; z: number; reward: number }
  | { type: 'encounter'; entityId: string; speciesId: number; level: number }
  | { type: 'battle-turn'; entityId: string; result: BattleTurnResult }
  | { type: 'evolved'; entityId: string; fromSpeciesId: number; speciesId: number };
export type OpenWorldStep = { tick: number; events: OpenWorldEvent[]; battleActive: boolean };
export type OpenWorldSave = { schema: 1; model: typeof OPEN_WORLD_MODEL; graphId: string; game: unknown; world: OpenWorldSnapshot };

const PATH_SAMPLE_DISTANCE = .45;
const MANUAL_CONTROL_HOLD = .3;
const DENSITY_MIN_RADIUS = 6;
const DENSITY_MAX_RADIUS = 18;
const DENSITY_TARGET = 6;
const BATTLE_INTERVAL = 0.9;
const UNIQUE_SPECIES = new Set([144, 145, 146, 150, 151]);
const DIRECTIONS = [{ x: 0, z: -1 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }] as const;
const finite = (value: number) => typeof value === 'number' && Number.isFinite(value);
const key = (x: number, z: number) => `${x.toFixed(2)}:${z.toFixed(2)}`;
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
function hash(text: string): number { let value = 2166136261; for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0; return value || 0x6d2b79f5; }
function stripGraph(state: BrainState): WorldBrainState { const { graph, ...rest } = structuredClone(state); return { ...rest, graphId: graph.id }; }

/** Shared deterministic terrain contract. Rendering may sample it freely without consuming simulation RNG. */
export function sampleWorld(x: number, z: number): WorldSample {
  return sampleKantoWorld(x, z);
}

export function biomeForSpecies(speciesId: number): WorldBiome {
  const habitat = getSpecies(speciesId).habitat;
  if (habitat === 'forest') return 'forest';
  if (habitat === 'sea' || habitat === 'waters-edge') return 'lake';
  if (habitat === 'mountain' || habitat === 'rough-terrain' || habitat === 'cave' || habitat === 'rare') return 'rock';
  return 'meadow';
}

/** Engineered mapping from Pokemon base Speed to open-world units per second. */
export function movementSpeed(speciesId: number, level = 5): number {
  const baseSpeed = getSpecies(speciesId).baseStats.speed;
  return Math.min(5, 1.2 + baseSpeed * .018 + Math.max(0, level - 5) * .012);
}

export function nextSpeciesInBiome(speciesId: number): number {
  const biome = biomeForSpecies(speciesId), candidates = POKEMON.map(species => species.id).filter(id => biomeForSpecies(id) === biome);
  const index = candidates.indexOf(speciesId); if (index < 0) throw new Error('Species is missing from its biome');
  return candidates[(index + 1) % candidates.length];
}

export function speciesForSpawn(serial: number): number {
  if (!Number.isSafeInteger(serial) || serial < 1) throw new Error('Spawn serial must be a positive integer');
  return ((serial - 1) % 151) + 1;
}

export function initialSpawnSpecies(serial: number): number {
  if (!Number.isSafeInteger(serial) || serial < 1) throw new Error('Spawn serial must be a positive integer');
  const grouped = (biome: WorldBiome) => POKEMON.map(species => species.id).filter(id => biomeForSpecies(id) === biome);
  const meadow = grouped('meadow'), forest = grouped('forest'), lake = grouped('lake'), rock = grouped('rock');
  const preferred = [...meadow.slice(0, 7), ...forest.slice(0, 3), ...lake.slice(0, 3), ...rock.slice(0, 2)];
  const remaining = POKEMON.map(species => species.id).filter(id => !preferred.includes(id));
  const sequence = [...preferred, ...remaining]; return sequence[(serial - 1) % sequence.length];
}

export class OpenWorldSimulation {
  readonly graph: Graph;
  readonly seed: number;
  readonly game: GameState;
  rng: Random;
  tick = 0;
  player: WorldPosition = { ...KANTO_START, heading: 0 };
  foods: WorldFood[] = [];
  entities: OpenWorldEntity[] = [];
  selectedWildId?: string;
  selectionPinned = false;
  trackingSelected = false;
  visitedTownIds: string[] = ['pallet'];
  lastMovementBlock?: string;
  rewardLedgers: Record<string, RewardLedger> = {};
  autoCapture = false;
  autoHunt = true;
  controlMode: 'auto' | 'manual' = 'auto';
  battleWildId?: string;
  battleElapsed = 0;
  spawnSerial = 1;
  nextFoodId = 1;
  respawnQueue: WorldRespawn[] = [];
  manualControlRemaining = 0;
  densityRemaining = 2.5;
  private pendingCapture = false;
  private pendingBall?: BallItem;
  private pendingAction?: BattleAction;
  private lastPlayerReward: number | null = null;
  private lastEnemyReward: number | null = null;
  private readonly brains = new Map<string, Brain>();
  private readonly companionMemories = new Map<string, OpenWorldEntity>();
  private readonly battleController: ConnectomeController;
  private readonly policy?: FieldPolicy;

  constructor(graph: Graph, game: GameState, seed: number, checkpoint?: OpenWorldSnapshot, policy?: FieldPolicy, wildCount = DEFAULT_WILD_COUNT) {
    validateGraph(graph); if (graph.kind !== 'connectome-subset') throw new Error('Open world requires a real connectome subset');
    validateGame(game); if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Open-world seed must be uint32');
    const rosterCount = checkpoint ? checkpoint.entities.filter(entity => entity.kind === 'wild').length + (checkpoint.respawnQueue?.length ?? 0) : wildCount;
    if (!Number.isInteger(rosterCount) || rosterCount < 12 || rosterCount > 18) throw new Error('Open world requires 12..18 alive or pending wild Pokemon');
    this.graph = structuredClone(graph); this.game = game; this.seed = seed >>> 0; this.rng = new Random(this.seed);
    this.battleController = new ConnectomeController(this.graph); this.policy = policy ? structuredClone(policy) : undefined;
    if (this.policy && (this.policy.graphId !== graph.id || this.policy.schema !== 1)) throw new Error('Open-world field policy does not match graph');
    if (checkpoint) { this.restore(checkpoint); if (!checkpoint.mapVersion) this.migrateLegacyMap(); else if (checkpoint.mapVersion !== KANTO_MAP_VERSION) this.migrateKantoBoundaries(); }
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

  movePartner(position: WorldPosition): boolean {
    if (this.game.battle?.kind === 'wild' && this.game.battle.canRun && this.controlMode === 'manual') {
      this.requestAction({ type: 'run' }); return false;
    }
    if (this.game.battle || this.game.captureOffer || ![position.x, position.z, position.heading].every(finite) || !Number.isInteger(position.heading) || position.heading < 0 || position.heading > 4) return false;
    const companion = this.entities.find(entity => entity.kind === 'companion'); if (!companion) return false;
    this.lastMovementBlock = undefined;
    const traversal = evaluateKantoTraversal(companion, position, this.game.player.badges);
    if (!traversal.allowed) { this.lastMovementBlock = traversal.reason; return false; }
    const maximum = movementSpeed(companion.speciesId, companion.level) * .35;
    // Manual movement can pass wild creatures; terrain and route gates still block it.
    if (distance(companion, position) > maximum || this.pathBlocked(companion, position.x, position.z, [])) return false;
    companion.x = position.x; companion.z = position.z; companion.heading = position.heading; companion.action = position.heading; companion.reward = 0;
    const brain = this.brain(companion.id); brain.state.previous = null;
    this.player = structuredClone(position); this.manualControlRemaining = MANUAL_CONTROL_HOLD; this.recordTownVisit(); return true;
  }

  syncPlayerToCompanion(): WorldPosition {
    const companion = this.entities.find(entity => entity.kind === 'companion'); if (!companion) return structuredClone(this.player);
    this.player = { x: companion.x, z: companion.z, heading: companion.heading }; return structuredClone(this.player);
  }

  private recordTownVisit(): void {
    const town = locationAt(this.player.x, this.player.z);
    if (town.kind === 'town' && distance(town, this.player) < 8.5 && !this.visitedTownIds.includes(town.id)) this.visitedTownIds.push(town.id);
  }

  teleportToTown(townId: string): boolean {
    if (this.game.battle || this.game.captureOffer || !this.visitedTownIds.includes(townId)) return false;
    const arrival = kantoTravelPoint(townId, this.game.player.badges);
    if (!arrival) return false;
    this.relocatePartner(arrival); this.game.logs.push(`${locationAt(arrival.x, arrival.z).name}으로 순간이동했습니다.`); this.game.logs = this.game.logs.slice(-200); return true;
  }

  private relocatePartner(arrival: { x: number; z: number }): void {
    const companion = this.entities.find(entity => entity.kind === 'companion')!;
    const count = this.rosterStatus().total;
    this.player = { ...arrival, heading: 0 }; Object.assign(companion, this.player);
    companion.target = undefined; this.selectWild(null); this.setControlMode('manual'); this.manualControlRemaining = 0;
    for (const entity of this.wildEntities()) { this.brains.delete(entity.id); this.entities.splice(this.entities.indexOf(entity), 1); }
    this.respawnQueue = []; this.foods = [];
    while (this.wildEntities().length < count) this.spawnWild();
    while (this.foods.length < 24) this.spawnFood();
    this.densityRemaining = 2.5; this.recordTownVisit();
  }

  selectWild(id: string | null, inspectOnly = false): void {
    if (id === null) { this.selectedWildId = undefined; this.selectionPinned = false; this.trackingSelected = false; return; }
    const entity = this.entities.find(item => item.kind === 'wild' && item.id === id); if (!entity) throw new Error('Unknown wild Pokemon');
    this.selectedWildId = id; this.selectionPinned = true; this.trackingSelected = !inspectOnly;
    if (inspectOnly && !this.game.battle) this.setControlMode('manual');
  }

  trackSelected(): boolean {
    if (!this.selectedWildId || this.game.battle || this.game.captureOffer) return false;
    this.setControlMode('auto'); this.selectionPinned = true; this.trackingSelected = true; return true;
  }

  canEngageWild(id: string): boolean {
    const companion = this.entities.find(entity => entity.kind === 'companion'), wild = this.entities.find(entity => entity.id === id && entity.kind === 'wild');
    return !!companion && !!wild && distance(companion, wild) <= 4 && !this.pathBlocked(companion, wild.x, wild.z, []);
  }

  setAutoCapture(enabled: boolean): void { if (typeof enabled !== 'boolean') throw new Error('Auto-capture flag must be boolean'); this.autoCapture = enabled; }
  get hasBalls(): boolean { return this.bestBall() !== undefined; }
  get escaping(): boolean { return this.pendingAction?.type === 'run'; }
  setAutoHunt(enabled: boolean): void { if (typeof enabled !== 'boolean') throw new Error('Auto-hunt flag must be boolean'); this.autoHunt = enabled; if (!this.game.battle) this.selectWild(null); }

  setControlMode(mode: 'auto' | 'manual'): void {
    if (mode !== 'auto' && mode !== 'manual') throw new Error('Invalid control mode');
    this.controlMode = mode; this.pendingAction = undefined; this.pendingCapture = false; this.battleElapsed = 0;
    if (mode === 'manual') this.trackingSelected = false;
    const companion = this.entities.find(entity => entity.kind === 'companion');
    if (companion) { this.brain(companion.id).state.previous = null; companion.action = 4; companion.reward = 0; }
    if (this.game.battle) this.clearPendingLearning(this.game.battle.player.team[this.game.battle.player.activeIndex]);
  }

  captureVictory(ball?: BallItem): boolean { return captureDefeatedWild(this.game, ball ?? this.cheapestBall() ?? 'poke-ball'); }
  releaseVictory(): void { if (this.game.captureOffer) { this.game.logs.push(`${this.game.captureOffer.nickname}을(를) 놓아주었습니다.`); this.game.logs = this.game.logs.slice(-200); this.game.captureOffer = undefined; } }

  challengeLocalGym(): boolean {
    const location = locationAt(this.player.x, this.player.z), gym = KANTO_GYMS.find(item => item.locationId === location.id);
    if (!gym || this.game.battle || this.game.captureOffer || gym.badge !== this.game.player.badges + 1) return false;
    const healthy = this.game.player.team.findIndex(monster => monster.hp > 0); if (healthy < 0) return false;
    this.game.regionId = REGIONS[gym.badge - 1].id;
    this.game.battle = { kind: 'gym', regionId: this.game.regionId, gymBadge: gym.badge, canRun: false, turn: 1, player: { team: this.game.player.team, activeIndex: healthy }, enemy: { team: [createMonster(this.game, gym.speciesId, gym.level)], activeIndex: 0 } };
    this.battleWildId = `gym:${gym.badge}`; this.battleElapsed = 0; this.lastPlayerReward = null; this.lastEnemyReward = null;
    return true;
  }

  traverseTunnel(): boolean {
    if (this.game.battle || this.game.captureOffer || this.game.player.badges < 2) return false;
    const entrances = KANTO_LOCATIONS.filter(item => item.id === 'diglett-cave-east' || item.id === 'diglett-cave-west');
    const from = entrances.find(item => distance(item, this.player) <= 5); if (!from) return false;
    const to = entrances.find(item => item !== from)!;
    const arrival = safeKantoArrival(to.id, this.game.player.badges); if (!arrival) return false;
    this.relocatePartner(arrival);
    this.game.logs.push(`디그다의 굴을 지나 ${to.name}으로 이동했습니다.`); this.game.logs = this.game.logs.slice(-200); return true;
  }

  requestCapture(ball?: BallItem): boolean {
    if (this.game.battle?.kind !== 'wild' || !this.battleWildId || this.game.battle.awaitingSwitch) return false;
    const selected = ball ?? this.bestBall(); if (!selected || this.game.inventory[selected] <= 0) return false;
    this.pendingCapture = true; this.pendingBall = selected; this.pendingAction = undefined; return true;
  }

  /** Queues one player-selected action while preserving the simulation's battle reward and cleanup path. */
  requestAction(action: BattleAction): boolean {
    if (!this.game.battle || !this.validRequestedAction(action)) return false;
    const battle = this.game.battle;
    if (battle.awaitingSwitch && action.type !== 'switch') return false;
    if (action.type === 'run' && !battle.canRun) return false;
    if (action.type === 'switch' && (action.index === battle.player.activeIndex || !battle.player.team[action.index]?.hp)) return false;
    if (action.type === 'item') {
      const target = action.targetInstanceId ? battle.player.team.find(monster => monster.instanceId === action.targetInstanceId) : battle.player.team[battle.player.activeIndex];
      if (!target || target.hp <= 0 || target.hp >= target.stats.hp || this.game.inventory[action.item] <= 0) return false;
    }
    if (action.type === 'catch') return this.requestCapture(action.ball);
    this.pendingAction = structuredClone(action); this.pendingCapture = false; this.pendingBall = undefined; return true;
  }

  startEncounter(id: string): boolean {
    if (this.game.battle || this.game.captureOffer) return false;
    const entity = this.entities.find(item => item.kind === 'wild' && item.id === id); if (!entity) return false;
    const healthy = this.game.player.team.findIndex(monster => monster.hp > 0); if (healthy < 0) return false;
    const wild = createMonster(this.game, entity.speciesId, entity.level);
    this.game.dex.seen = [...new Set([...this.game.dex.seen, entity.speciesId])].sort((a, b) => a - b);
    this.game.battle = { kind: 'wild', regionId: this.game.regionId, player: { team: this.game.player.team, activeIndex: healthy }, enemy: { team: [wild], activeIndex: 0 }, turn: 1, canRun: true };
    this.game.logs.push(`오픈월드에서 ${getSpecies(entity.speciesId).name}을(를) 만났다.`); if (this.game.logs.length > 200) this.game.logs.shift();
    this.battleWildId = id; this.battleElapsed = 0; this.pendingCapture = false; this.pendingBall = undefined; this.pendingAction = undefined; this.lastPlayerReward = null; this.lastEnemyReward = null;
    return true;
  }

  step(options: { deltaSeconds?: number; learning?: boolean; epsilon?: number } = {}): OpenWorldStep {
    const deltaSeconds = options.deltaSeconds ?? .25, learning = options.learning ?? false, epsilon = options.epsilon ?? (learning ? .12 : 0);
    if (!finite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 5 || typeof learning !== 'boolean' || !finite(epsilon) || epsilon < 0 || epsilon > 1) throw new Error('Invalid open-world step options');
    const events: OpenWorldEvent[] = [];
    const manualControlActive = this.manualControlRemaining > 0; this.manualControlRemaining = Math.max(0, this.manualControlRemaining - deltaSeconds);
    this.syncCompanion();
    if (this.game.captureOffer) {
      if (!this.hasBalls) this.releaseVictory();
      else { this.tick++; return { tick: this.tick, events, battleActive: false }; }
    }
    if (!this.game.battle) {
      this.advanceDensity(deltaSeconds);
      this.advanceRespawns(deltaSeconds);
      if (this.autoHunt && this.controlMode === 'auto' && !this.selectionPinned) {
        const companion = this.entities.find(entity => entity.kind === 'companion'), nearest = this.nearestWildToCompanion();
        const current = this.selectedWildId ? this.entities.find(entity => entity.id === this.selectedWildId && entity.kind === 'wild') : undefined;
        if (nearest && (!current || !companion || distance(nearest, companion) + 2 < distance(current, companion))) this.selectedWildId = nearest.id;
      }
      this.stepMovement(deltaSeconds, learning, epsilon, manualControlActive, events);
      this.syncPlayerToCompanion(); this.recordTownVisit();
      const selected = this.selectedWildId ? this.entities.find(entity => entity.id === this.selectedWildId) : undefined;
      const companion = this.entities.find(entity => entity.kind === 'companion');
      const selectedContact = selected && (!this.selectionPinned || this.trackingSelected) && this.canEngageWild(selected.id);
      const contact = selectedContact ? selected : this.controlMode === 'auto' && !this.selectionPinned ? this.wildEntities().find(entity => distance(entity, this.player) <= 1.4 && this.canEngageWild(entity.id)) : undefined;
      if (contact && this.controlMode === 'auto' && !manualControlActive && this.startEncounter(contact.id)) {
        events.push({ type: 'encounter', entityId: contact.id, speciesId: contact.speciesId, level: contact.level });
        const moved = !!companion && events.some(event => event.type === 'move' && event.entityId === companion.id);
        const source: RewardDecisionSource = this.controlMode === 'auto' && !manualControlActive ? 'connectome' : 'manual';
        const individualId = this.game.battle!.player.team[this.game.battle!.player.activeIndex].instanceId;
        const credit = rewardEncounter({ individualId, decisionSource: source, learningEnabled: learning, movementLedToEncounter: moved });
        if (credit.breakdown.engagement) {
          this.recordReward(credit, 'engagement', source);
          if (companion) this.brain(companion.id).finish(companion.reward + credit.total, credit.learningEligible);
        }
      }
    } else if (!this.battleWildId) throw new Error('Open-world battle is missing its wild entity');

    if (this.game.battle) {
      if (this.controlMode === 'manual' && !this.pendingAction && !this.pendingCapture) { this.battleElapsed = 0; this.tick++; return { tick: this.tick, events, battleActive: true }; }
      this.battleElapsed += deltaSeconds;
      while (this.game.battle && this.battleElapsed >= BATTLE_INTERVAL) {
        this.battleElapsed -= BATTLE_INTERVAL;
        const battleEvent = this.advanceBattle(learning, events); if (battleEvent) events.push(battleEvent);
        if (this.controlMode === 'manual') { this.battleElapsed = 0; break; }
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
      player: structuredClone(this.player), selectedWildId: this.selectedWildId, autoCapture: this.autoCapture, autoHunt: this.autoHunt, battleWildId: this.battleWildId,
      battleElapsed: this.battleElapsed, pendingCapture: this.pendingCapture, pendingBall: this.pendingBall, lastPlayerReward: this.lastPlayerReward, lastEnemyReward: this.lastEnemyReward,
      pendingAction: structuredClone(this.pendingAction), manualControlRemaining: this.manualControlRemaining,
      densityRemaining: this.densityRemaining, controlMode: this.controlMode, mapVersion: KANTO_MAP_VERSION,
      selectionPinned: this.selectionPinned, trackingSelected: this.trackingSelected, visitedTownIds: [...this.visitedTownIds],
      rewardLedgers: structuredClone(Object.fromEntries(Object.entries(this.rewardLedgers).filter(([id]) => this.rewardOwnerIds().has(id)))),
      spawnSerial: this.spawnSerial, nextFoodId: this.nextFoodId, foods: structuredClone(this.foods), respawnQueue: structuredClone(this.respawnQueue), entities: this.entities.map(pack), companionMemories: [...this.companionMemories.values()].map(pack) };
  }

  spawnCatalog(): Array<{ speciesId: number; biome: WorldBiome }> { return POKEMON.map((_, index) => { const speciesId = speciesForSpawn(index + 1); return { speciesId, biome: biomeForSpecies(speciesId) }; }); }
  rosterStatus(): { alive: number; pending: number; total: number } { const alive = this.wildEntities().length, pending = this.respawnQueue.length; return { alive, pending, total: alive + pending }; }
  nearbyWildCount(radius = 25): number { if (!finite(radius) || radius <= 0 || radius > 100) throw new Error('Nearby radius must be 0..100'); return this.wildEntities().filter(entity => distance(entity, this.player) <= radius).length; }

  private stepMovement(deltaSeconds: number, learning: boolean, epsilon: number, manualControlActive: boolean, events: OpenWorldEvent[]): void {
    const occupied: Array<{ x: number; z: number }> = [];
    for (const entity of this.entities) {
      const target = this.targetFor(entity); entity.target = target;
      const before = target ? distance(entity, target) : 0; entity.observation = this.observe(entity, target, occupied, deltaSeconds);
      if (entity.kind === 'companion' && (manualControlActive || this.controlMode === 'manual')) {
        entity.action = 4;
        entity.reward = 0; occupied.push({ x: entity.x, z: entity.z }); events.push({ type: 'wait', entityId: entity.id, x: entity.x, z: entity.z, reward: 0 }); continue;
      }
      const brain = this.brain(entity.id), action = brain.act(entity.observation, this.tick ? entity.reward : null, learning, epsilon, 4);
      let reward = -.005, type: 'move' | 'wait' | 'collision' | 'food' = 'wait';
      if (action < 4 && deltaSeconds > 0) {
        const direction = DIRECTIONS[action as 0 | 1 | 2 | 3], stepDistance = movementSpeed(entity.speciesId, entity.level) * deltaSeconds;
        const x = entity.x + direction.x * stepDistance, z = entity.z + direction.z * stepDistance;
        entity.heading = action;
        if (this.pathBlocked(entity, x, z, occupied)) { reward -= .2; entity.collisions++; type = 'collision'; }
        else { entity.x = x; entity.z = z; entity.energy = Math.max(0, entity.energy - .035 * stepDistance); type = 'move'; }
      } else entity.energy = Math.min(100, entity.energy + .025);
      if (target) {
        const maxProgress = movementSpeed(entity.speciesId, entity.level) * deltaSeconds;
        reward += clamp(before - distance(entity, target), -maxProgress, maxProgress) * .05;
      }
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
    const captureBall = this.pendingCapture ? (this.pendingBall && this.game.inventory[this.pendingBall] > 0 ? this.pendingBall : this.bestBall()) : undefined;
    if (this.pendingCapture && !captureBall) { this.pendingCapture = false; this.pendingBall = undefined; }
    let action: BattleAction, learnedPlayerAction = false, source: RewardDecisionSource = 'manual';
    if (battle.awaitingSwitch) {
      const requested = this.pendingAction; this.pendingAction = undefined;
      const index = requested?.type === 'switch' ? requested.index : battle.player.team.findIndex(monster => monster.hp > 0);
      action = { type: 'switch', index };
    } else if (this.pendingAction) {
      action = this.pendingAction; this.pendingAction = undefined;
    } else if (this.pendingCapture && captureBall) {
      action = { type: 'catch', ball: captureBall }; this.pendingCapture = false; this.pendingBall = undefined;
    } else {
      const decision = this.chooseBattle(player, enemy, battle, this.lastPlayerReward, learning);
      if (decision.action < 4 && (!this.autoHunt || this.isDamagingAttack(player, battle, decision.action))) { action = { type: 'move', index: decision.action }; learnedPlayerAction = decision.rawAction === decision.action; }
      else if (this.autoHunt) action = { type: 'move', index: this.fallbackAttack(player, battle) };
      else { action = { type: 'wait' }; learnedPlayerAction = true; }
      source = learnedPlayerAction ? 'connectome' : 'fallback';
    }
    if (!learnedPlayerAction) this.clearPendingLearning(player);
    const playerHp = player.hp, enemyHp = enemy.hp, playerLevel = player.level, enemyLevel = enemy.level;
    const playerMaxBefore = battle.transformations?.[player.instanceId]?.stats.hp ?? player.stats.hp, enemyMaxBefore = battle.transformations?.[enemy.instanceId]?.stats.hp ?? enemy.stats.hp;
    const playerTypes = getSpecies(battle.transformations?.[player.instanceId]?.speciesId ?? player.speciesId).types;
    const enemyTypes = getSpecies(battle.transformations?.[enemy.instanceId]?.speciesId ?? enemy.speciesId).types;
    const enemyDecision = this.chooseBattle(enemy, player, battle, this.lastEnemyReward, learning);
    const enemySource: RewardDecisionSource = enemyDecision.rawAction === enemyDecision.action ? 'connectome' : 'fallback';
    const result = actBattle(this.game, action, enemyDecision.action);
    if (result.battleEnded && result.outcome === 'won') this.autoEvolve(events);
    const playerAttack = result.executedMoves.find(move => move.actorInstanceId === player.instanceId), enemyAttack = result.executedMoves.find(move => move.actorInstanceId === enemy.instanceId);
    const playerMaxHp = Math.max(playerMaxBefore, player.stats.hp), enemyMaxHp = Math.max(enemyMaxBefore, enemy.stats.hp);
    const playerReward = rewardBattleTurn({ individualId: player.instanceId, decisionSource: source, learningEnabled: learning,
      selfHpBefore: playerHp, selfHpAfter: player.hp, selfMaxHp: playerMaxHp, opponentHpBefore: enemyHp, opponentHpAfter: enemy.hp, opponentMaxHp: enemyMaxHp,
      chosenAttackType: playerAttack?.moveType, defenderTypes: enemyTypes, damagingMove: playerAttack?.damagingMove, actionExecuted: playerAttack?.executed, attackHit: playerAttack?.hit, typeEffectiveness: playerAttack?.typeMultiplier,
      outcome: result.outcome, levelsGained: player.level - playerLevel, evolved: events.some(event => event.type === 'evolved' && event.entityId === player.instanceId) });
    const enemyReward = rewardBattleTurn({ individualId: enemy.instanceId, decisionSource: enemySource, learningEnabled: learning,
      selfHpBefore: enemyHp, selfHpAfter: enemy.hp, selfMaxHp: enemyMaxHp, opponentHpBefore: playerHp, opponentHpAfter: player.hp, opponentMaxHp: playerMaxHp,
      chosenAttackType: enemyAttack?.moveType, defenderTypes: playerTypes, damagingMove: enemyAttack?.damagingMove, actionExecuted: enemyAttack?.executed, attackHit: enemyAttack?.hit, typeEffectiveness: enemyAttack?.typeMultiplier,
      outcome: result.outcome === 'won' ? 'lost' : result.outcome === 'lost' ? 'won' : result.outcome, levelsGained: enemy.level - enemyLevel });
    this.recordReward(playerReward, 'battle', source); this.recordReward(enemyReward, 'battle', enemySource);
    for (const gain of result.experienceGains.filter(gain => gain.shared && gain.levelsGained > 0)) {
      const member = this.game.player.team.find(monster => monster.instanceId === gain.instanceId)!;
      this.recordReward(rewardBattleTurn({ individualId: member.instanceId, decisionSource: 'fallback', learningEnabled: false,
        selfHpBefore: member.hp, selfHpAfter: member.hp, selfMaxHp: member.stats.hp, opponentHpBefore: 0, opponentHpAfter: 0, opponentMaxHp: 1,
        levelsGained: gain.levelsGained, evolved: events.some(event => event.type === 'evolved' && event.entityId === member.instanceId) }), 'battle', 'fallback');
    }
    this.lastPlayerReward = playerReward.learningEligible ? playerReward.total : null; this.lastEnemyReward = enemyReward.learningEligible ? enemyReward.total : null;
    if (result.battleEnded) {
      this.battleController.finish(player, playerReward.total, playerReward.learningEligible);
      this.battleController.finish(enemy, enemyReward.total, enemyReward.learningEligible);
      const removed = this.entities.find(entity => entity.id === entityId);
      if (removed) this.removeWild(entityId);
      if (result.outcome === 'won' && battle.kind === 'wild') {
        this.game.captureOffer = structuredClone(enemy); this.game.captureOffer.hp = 0;
        this.game.captureOffer.status = undefined; this.game.captureOffer.statusTurns = undefined;
        if (this.autoCapture && this.hasBalls) this.captureVictory();
        else if (!this.hasBalls) this.releaseVictory();
      }
      this.battleWildId = undefined; this.selectedWildId = undefined; this.battleElapsed = 0; this.pendingCapture = false; this.pendingBall = undefined; this.lastPlayerReward = null; this.lastEnemyReward = null;
      this.pendingAction = undefined;
      this.selectionPinned = false; this.trackingSelected = false;
      const owners = this.rewardOwnerIds(); for (const id of Object.keys(this.rewardLedgers)) if (!owners.has(id)) delete this.rewardLedgers[id];
    }
    return { type: 'battle-turn', entityId, result };
  }

  private rewardOwnerIds(): Set<string> { return new Set([...this.game.player.team, ...this.game.player.box, ...(this.game.battle?.enemy.team ?? []), ...(this.game.captureOffer ? [this.game.captureOffer] : [])].map(monster => monster.instanceId)); }
  private recordReward(reward: EngineeredReward, event: 'engagement' | 'battle', source: RewardDecisionSource): void {
    this.rewardLedgers[reward.individualId] = appendReward(this.rewardLedgers[reward.individualId] ?? emptyRewardLedger(reward.individualId), { event, source, tick: this.tick }, reward);
  }

  private chooseBattle(monster: Monster, other: Monster, battle: NonNullable<GameState['battle']>, reward: number | null, learning: boolean) {
    const selfForm = battle.transformations?.[monster.instanceId], otherForm = battle.transformations?.[other.instanceId];
    const self = { ...monster, ...(selfForm ?? {}), brain: monster.brain }, foe = { ...other, ...(otherForm ?? {}), brain: other.brain };
    const decision = this.battleController.choose(self, foe, battle.turn, reward, learning); monster.brain = self.brain; return decision;
  }

  private clearPendingLearning(monster: Monster): void {
    const brain = this.battleController.ensure(monster); brain.state.previous = null; monster.brain = brain.snapshot(); this.lastPlayerReward = null;
  }

  private fallbackAttack(monster: Monster, battle: NonNullable<GameState['battle']>): number {
    const moves = battle.transformations?.[monster.instanceId]?.moves ?? monster.moves;
    const damaging = moves.map((slot, index) => ({ index, slot, move: getMove(slot.moveId) })).filter(candidate => candidate.slot.pp > 0 && (candidate.move.power > 0 || [12, 32, 49, 69, 82, 90, 101, 149, 162].includes(candidate.move.id)));
    damaging.sort((a, b) => b.move.power - a.move.power || a.index - b.index);
    return damaging[0]?.index ?? moves.findIndex(slot => slot.pp > 0) ?? 0;
  }

  private isDamagingAttack(monster: Monster, battle: NonNullable<GameState['battle']>, index: number): boolean {
    const slot = (battle.transformations?.[monster.instanceId]?.moves ?? monster.moves)[index]; if (!slot || slot.pp <= 0) return false;
    const move = getMove(slot.moveId); return move.power > 0 || [12, 32, 49, 69, 82, 90, 101, 149, 162].includes(move.id);
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
    return this.makeEntity(id, 'companion', lead.speciesId, lead.level, this.companionPosition());
  }

  private syncCompanion(): void {
    const lead = this.game.player.team.find(monster => monster.hp > 0) ?? this.game.player.team[0];
    let companion = this.entities.find(entity => entity.kind === 'companion');
    const expectedId = `companion:${lead.instanceId}`;
    if (!companion || companion.id !== expectedId) {
      if (companion) { this.entities.splice(this.entities.indexOf(companion), 1); this.companionMemories.set(companion.id, companion); }
      companion = this.companionMemories.get(expectedId);
      const position = this.companionPosition();
      if (companion) { this.companionMemories.delete(expectedId); companion.x = position.x; companion.z = position.z; }
      else companion = this.makeEntity(expectedId, 'companion', lead.speciesId, lead.level, position);
      this.entities.unshift(companion);
    }
    companion.speciesId = lead.speciesId; companion.level = lead.level;
  }

  private encounterAt(position: { x: number; z: number }): { speciesId: number; level: number } {
    const location = locationAt(position.x, position.z);
    const pool = this.spawnPool(location.id);
    if (!pool.length) throw new Error(`No unlocked encounters at ${location.id}`);
    return { speciesId: pool[this.rng.int(pool.length)], level: location.minLevel + this.rng.int(location.maxLevel - location.minLevel + 1) };
  }

  private spawnPool(locationId: string): number[] {
    return encountersForLocation(locationId, this.game.player.badges).filter(speciesId => !UNIQUE_SPECIES.has(speciesId) || (!this.game.dex.caught.includes(speciesId) && !this.entities.some(entity => entity.kind === 'wild' && entity.speciesId === speciesId) && !this.respawnQueue.some(pending => pending.speciesId === speciesId)));
  }

  private localSpawnPosition(): { x: number; z: number } {
    // Stream nearby zones: the location under the spawn controls species and level.
    const current = locationAt(this.player.x, this.player.z);
    for (let attempt = 0; attempt < 2500; attempt++) {
      const radius = 6 + this.rng.next() * (attempt < 1000 ? 18 : 35), angle = this.rng.next() * Math.PI * 2;
      const x = this.player.x + Math.cos(angle) * radius, z = this.player.z + Math.sin(angle) * radius;
      const location = locationAt(x, z);
      if (!sampleWorld(x, z).blocked && location.minLevel <= current.maxLevel + 4 && this.spawnPool(location.id).length && !this.entities.some(entity => distance(entity, { x, z }) < 2)) return { x, z };
    }
    for (const location of [...KANTO_LOCATIONS].sort((a, b) => distance(a, this.player) - distance(b, this.player))) {
      if (this.spawnPool(location.id).length && !sampleWorld(location.x, location.z).blocked) return { x: location.x, z: location.z };
    }
    throw new Error('No unlocked Kanto spawn position');
  }

  private spawnWild(): OpenWorldEntity {
    const position = this.localSpawnPosition(), { speciesId, level } = this.encounterAt(position);
    const entity = this.makeEntity(`wild-${this.spawnSerial++}`, 'wild', speciesId, level, position); this.entities.push(entity); return entity;
  }

  private removeWild(id: string): void {
    const index = this.entities.findIndex(entity => entity.id === id && entity.kind === 'wild'); if (index < 0) return;
    const [removed] = this.entities.splice(index, 1); this.brains.delete(id);
    this.respawnQueue.push({ id: `respawn:${id}`, speciesId: removed.speciesId, level: removed.level, biome: biomeForSpecies(removed.speciesId), originX: removed.x, originZ: removed.z, remainingSeconds: 4 + this.rng.next() * 2 });
  }

  private advanceRespawns(deltaSeconds: number): void {
    for (const pending of this.respawnQueue) pending.remainingSeconds = Math.max(0, pending.remainingSeconds - deltaSeconds);
    const ready = this.respawnQueue.filter(pending => pending.remainingSeconds === 0);
    this.respawnQueue = this.respawnQueue.filter(pending => pending.remainingSeconds > 0);
    for (const _pending of ready) this.spawnWild();
  }

  private advanceDensity(deltaSeconds: number): void {
    this.densityRemaining -= deltaSeconds; if (this.densityRemaining > 0) return;
    this.densityRemaining = 2 + this.rng.next();
    // Retire out-of-range individuals and create new local individuals with new IDs.
    const candidates = this.wildEntities().filter(entity => distance(entity, this.player) > 38 && entity.id !== this.selectedWildId && entity.id !== this.battleWildId);
    for (const donor of candidates.slice(0, 4)) {
      this.entities.splice(this.entities.indexOf(donor), 1); this.brains.delete(donor.id); this.spawnWild();
    }
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
      return selected && (!this.selectionPinned || this.trackingSelected) ? { kind: 'wild', id: selected.id, x: selected.x, z: selected.z } : { kind: 'player', id: 'player', x: this.player.x, z: this.player.z };
    }
    const food = [...this.foods].sort((a, b) => distance(entity, a) - distance(entity, b) || a.id - b.id)[0];
    return food ? { kind: 'food', id: String(food.id), x: food.x, z: food.z } : undefined;
  }

  private observe(entity: OpenWorldEntity, target: WorldTarget | undefined, occupied: Array<{ x: number; z: number }>, deltaSeconds: number): number[] {
    const dx = target ? target.x - entity.x : 0, dz = target ? target.z - entity.z : 0;
    const blocked = DIRECTIONS.map(direction => {
      const lookahead = movementSpeed(entity.speciesId, entity.level) * deltaSeconds;
      const x = entity.x + direction.x * lookahead, z = entity.z + direction.z * lookahead;
      return this.pathBlocked(entity, x, z, occupied) ? 1 : 0;
    });
    return [1, clamp(dx / 16, -1, 1), clamp(dz / 10, -1, 1), Math.sign(dx), Math.sign(dz), Math.min(Math.abs(dx) / 16, 1), Math.min(Math.abs(dz) / 10, 1), ...blocked, entity.energy / 100];
  }

  private pathBlocked(from: { x: number; z: number }, x: number, z: number, occupied: Array<{ x: number; z: number }>): boolean {
    if (!evaluateKantoTraversal(from, { x, z }, this.game.player.badges).allowed) return true;
    const length = Math.hypot(x - from.x, z - from.z), samples = Math.max(1, Math.ceil(length / PATH_SAMPLE_DISTANCE));
    for (let sample = 1; sample <= samples; sample++) {
      const ratio = sample / samples, px = from.x + (x - from.x) * ratio, pz = from.z + (z - from.z) * ratio;
      if (sampleWorld(px, pz).blocked || occupied.some(point => Math.hypot(point.x - px, point.z - pz) < 1)) return true;
    }
    return false;
  }

  private openPosition(biome: WorldBiome, awayFromPlayer: number): { x: number; z: number } {
    for (let attempt = 0; attempt < 3000; attempt++) {
      const x = WORLD_MIN + 3 + this.rng.next() * (WORLD_MAX - WORLD_MIN - 6), z = WORLD_MIN + 3 + this.rng.next() * (WORLD_MAX - WORLD_MIN - 6);
      const sample = sampleWorld(x, z);
      if (!sample.blocked && sample.biome === biome && Math.hypot(x - this.player.x, z - this.player.z) >= awayFromPlayer && !this.entities.some(entity => Math.hypot(entity.x - x, entity.z - z) < 3) && !this.foods.some(food => Math.hypot(food.x - x, food.z - z) < 2)) return { x, z };
    }
    throw new Error(`No open ${biome} position`);
  }

  private openBeginnerPosition(): { x: number; z: number } {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const angle = this.rng.next() * Math.PI * 2, radius = 8 + this.rng.next() * 7;
      const x = this.player.x + Math.cos(angle) * radius, z = this.player.z + Math.sin(angle) * radius;
      if (!sampleWorld(x, z).blocked && !this.entities.some(entity => Math.hypot(entity.x - x, entity.z - z) < 3)) return { x, z };
    }
    throw new Error('No open beginner position');
  }

  private openNearbyPosition(biome: WorldBiome, minimum: number, maximum: number): { x: number; z: number } {
    for (let attempt = 0; attempt < 2000; attempt++) {
      const angle = this.rng.next() * Math.PI * 2, radius = minimum + this.rng.next() * (maximum - minimum);
      const x = this.player.x + Math.cos(angle) * radius, z = this.player.z + Math.sin(angle) * radius;
      const sample = sampleWorld(x, z);
      if (!sample.blocked && sample.biome === biome && !this.entities.some(entity => distance(entity, { x, z }) < 3) && !this.foods.some(food => distance(food, { x, z }) < 2)) return { x, z };
    }
    return this.openPosition(biome, minimum);
  }

  private openRespawnPosition(pending: WorldRespawn): { x: number; z: number } {
    for (let attempt = 0; attempt < 2000; attempt++) {
      const nearPlayer = attempt < 300, center = nearPlayer ? this.player : { x: pending.originX, z: pending.originZ };
      const minimum = nearPlayer ? 6 : 5, maximum = nearPlayer ? 14 : 18, radius = minimum + this.rng.next() * (maximum - minimum), angle = this.rng.next() * Math.PI * 2;
      const x = clamp(center.x + Math.cos(angle) * radius, WORLD_MIN + 2, WORLD_MAX - 2), z = clamp(center.z + Math.sin(angle) * radius, WORLD_MIN + 2, WORLD_MAX - 2);
      const sample = sampleWorld(x, z);
      if (!sample.blocked && sample.biome === pending.biome && distance({ x, z }, this.player) >= 6 && !this.entities.some(entity => distance(entity, { x, z }) < 3) && !this.foods.some(food => distance(food, { x, z }) < 2)) return { x, z };
    }
    return this.openPosition(pending.biome, 8);
  }

  private companionPosition(): { x: number; z: number } {
    for (const offset of [{ x: 0, z: 0 }, { x: -2, z: 2 }, { x: 2, z: 2 }, { x: -2, z: -2 }, { x: 2, z: -2 }]) {
      const position = { x: this.player.x + offset.x, z: this.player.z + offset.z };
      if (!sampleWorld(position.x, position.z).blocked) return position;
    }
    return { x: this.player.x, z: this.player.z };
  }

  private spawnFood(): void {
    for (let attempt = 0; attempt < 5000; attempt++) {
      const anchor = this.entities[this.rng.int(this.entities.length)] ?? this.player;
      const radius = 3 + this.rng.next() * 25, angle = this.rng.next() * Math.PI * 2;
      const point = { x: anchor.x + Math.cos(angle) * radius, z: anchor.z + Math.sin(angle) * radius };
      if (!sampleWorld(point.x, point.z).blocked && !this.foods.some(food => distance(food, point) < 1.5)) { this.foods.push({ id: this.nextFoodId++, ...point }); return; }
    }
    throw new Error('No nearby food position inside Kanto paths');
  }

  private brain(id: string): Brain { const brain = this.brains.get(id); if (!brain) throw new Error(`Missing open-world brain ${id}`); return brain; }
  private wildEntities(): OpenWorldEntity[] { return this.entities.filter(entity => entity.kind === 'wild'); }
  private nearestWildToCompanion(): OpenWorldEntity | undefined { const companion = this.entities.find(entity => entity.kind === 'companion'); return companion ? [...this.wildEntities()].sort((a, b) => distance(a, companion) - distance(b, companion) || a.id.localeCompare(b.id))[0] : undefined; }
  private cheapestBall(): BallItem | undefined { return (['poke-ball', 'great-ball', 'ultra-ball'] as BallItem[]).find(ball => this.game.inventory[ball] > 0); }
  private bestBall(): BallItem | undefined { return (['ultra-ball', 'great-ball', 'poke-ball'] as BallItem[]).find(ball => this.game.inventory[ball] > 0); }
  private validRequestedAction(action: BattleAction): boolean {
    if (!action || typeof action !== 'object') return false;
    if (action.type === 'move') return Number.isInteger(action.index) && action.index >= 0 && action.index < 4;
    if (action.type === 'switch') return Number.isInteger(action.index) && action.index >= 0 && action.index < this.game.player.team.length;
    if (action.type === 'item') return ['potion', 'super-potion'].includes(action.item) && (action.targetInstanceId === undefined || typeof action.targetInstanceId === 'string');
    if (action.type === 'catch') return ['poke-ball', 'great-ball', 'ultra-ball'].includes(action.ball);
    return action.type === 'wait' || action.type === 'run';
  }
  private priority(entity: OpenWorldEntity): number { return entity.id === this.battleWildId ? 0 : entity.id === this.selectedWildId ? 1 : entity.kind === 'companion' ? 2 : 3; }

  private migrateKantoBoundaries(): void {
    const relocate = (point: { x: number; z: number }) => {
      const arrival = nearestKantoWalkable(point.x, point.z, this.game.player.badges) ?? KANTO_START;
      point.x = arrival.x; point.z = arrival.z;
    };
    relocate(this.player);
    for (const entity of [...this.entities, ...this.companionMemories.values()]) { relocate(entity); entity.target = undefined; }
    this.syncPlayerToCompanion();
    for (const pending of this.respawnQueue) {
      const point = { x: pending.originX, z: pending.originZ }; relocate(point); pending.originX = point.x; pending.originZ = point.z;
    }
    const kept: WorldFood[] = [];
    for (const food of this.foods) { relocate(food); if (!kept.some(other => distance(other, food) < 1.5)) kept.push(food); }
    this.foods = kept; while (this.foods.length < 24) this.spawnFood();
    this.recordTownVisit();
    for (const gym of KANTO_GYMS.filter(gym => gym.badge <= this.game.player.badges)) if (!this.visitedTownIds.includes(gym.locationId)) this.visitedTownIds.push(gym.locationId);
    this.game.logs.push('도로와 벽에 맞춰 위치를 정리했습니다. 개체별 기억과 진행 상황은 그대로입니다.'); this.game.logs = this.game.logs.slice(-200);
  }

  private migrateLegacyMap(): void {
    // The caller keeps the original save; owned memories survive terrain replacement.
    const rosterCount = this.rosterStatus().total;
    this.player = { ...KANTO_START, heading: 0 };
    for (const entity of [...this.entities, ...this.companionMemories.values()]) {
      if (entity.kind === 'companion') { entity.x = KANTO_START.x; entity.z = KANTO_START.z; entity.target = undefined; }
    }
    for (const entity of this.wildEntities()) {
      if (entity.id === this.battleWildId) { entity.x = KANTO_START.x; entity.z = KANTO_START.z - 3; }
      else { this.entities.splice(this.entities.indexOf(entity), 1); this.brains.delete(entity.id); }
    }
    this.selectedWildId = this.battleWildId && this.game.battle?.kind === 'wild' ? this.battleWildId : undefined;
    this.respawnQueue = []; this.foods = [];
    while (this.wildEntities().length < rosterCount) this.spawnWild();
    while (this.foods.length < 24) this.spawnFood();
    this.game.logs.push('관동 지도로 이동했습니다. 파트너의 기억과 진행 상황을 보존했습니다.'); this.game.logs = this.game.logs.slice(-200);
  }

  private restore(checkpoint: OpenWorldSnapshot): void {
    if (checkpoint.mapVersion !== undefined && !['kanto-v1', KANTO_MAP_VERSION].includes(checkpoint.mapVersion)) throw new Error('Unknown Kanto map version');
    const invalidTerrain = (x: number, z: number) => checkpoint.mapVersion === KANTO_MAP_VERSION ? sampleWorld(x, z).blocked : Math.abs(x) > 120 || Math.abs(z) > 120;
    if (!checkpoint || checkpoint.schema !== 1 || checkpoint.model !== OPEN_WORLD_MODEL || checkpoint.graphId !== this.graph.id || checkpoint.seed !== this.seed || !Number.isInteger(checkpoint.rng) || checkpoint.rng < 0 || checkpoint.rng > 0xffffffff || !Number.isSafeInteger(checkpoint.tick) || checkpoint.tick < 0 || !finite(checkpoint.battleElapsed) || checkpoint.battleElapsed < 0 || checkpoint.battleElapsed >= BATTLE_INTERVAL || typeof checkpoint.autoCapture !== 'boolean' || typeof checkpoint.pendingCapture !== 'boolean' || (checkpoint.pendingBall !== undefined && !['poke-ball', 'great-ball', 'ultra-ball'].includes(checkpoint.pendingBall)) || (checkpoint.pendingAction !== undefined && !this.validRequestedAction(checkpoint.pendingAction)) || ![checkpoint.lastPlayerReward, checkpoint.lastEnemyReward].every(value => value === null || (finite(value) && Math.abs(value) <= 2)) || !Number.isSafeInteger(checkpoint.spawnSerial) || checkpoint.spawnSerial < 1 || !Number.isSafeInteger(checkpoint.nextFoodId) || checkpoint.nextFoodId < 1 || !Array.isArray(checkpoint.foods) || !Array.isArray(checkpoint.entities) || (checkpoint.companionMemories !== undefined && !Array.isArray(checkpoint.companionMemories))) throw new Error('Invalid open-world checkpoint');
    if ((checkpoint.autoHunt !== undefined && typeof checkpoint.autoHunt !== 'boolean') || (checkpoint.respawnQueue !== undefined && !Array.isArray(checkpoint.respawnQueue))) throw new Error('Invalid open-world automation checkpoint');
    if (checkpoint.manualControlRemaining !== undefined && (!finite(checkpoint.manualControlRemaining) || checkpoint.manualControlRemaining < 0 || checkpoint.manualControlRemaining > MANUAL_CONTROL_HOLD)) throw new Error('Invalid manual-control hold');
    if (checkpoint.densityRemaining !== undefined && (!finite(checkpoint.densityRemaining) || checkpoint.densityRemaining < 0 || checkpoint.densityRemaining > 3)) throw new Error('Invalid density timer');
    if (![checkpoint.player?.x, checkpoint.player?.z, checkpoint.player?.heading].every(finite) || !Number.isInteger(checkpoint.player.heading) || checkpoint.player.heading < 0 || checkpoint.player.heading > 4 || invalidTerrain(checkpoint.player.x, checkpoint.player.z)) throw new Error('Invalid open-world player');
    const memories = checkpoint.companionMemories ?? [], respawns = checkpoint.respawnQueue ?? [], savedEntities = [...checkpoint.entities, ...memories];
    const wildCount = checkpoint.entities.filter(entity => entity.kind === 'wild').length;
    if (wildCount + respawns.length < 12 || wildCount + respawns.length > 18 || checkpoint.entities.filter(entity => entity.kind === 'companion').length !== 1 || memories.some(entity => entity.kind !== 'companion') || new Set(savedEntities.map(entity => entity.id)).size !== savedEntities.length) throw new Error('Invalid open-world roster');
    if (new Set(respawns.map(respawn => respawn.id)).size !== respawns.length || respawns.some(respawn => !respawn || typeof respawn.id !== 'string' || !respawn.id || !Number.isInteger(respawn.speciesId) || respawn.speciesId < 1 || respawn.speciesId > 151 || !Number.isInteger(respawn.level) || respawn.level < 1 || respawn.level > 100 || respawn.biome !== biomeForSpecies(respawn.speciesId) || !finite(respawn.originX) || !finite(respawn.originZ) || invalidTerrain(respawn.originX, respawn.originZ) || !finite(respawn.remainingSeconds) || respawn.remainingSeconds <= 0 || respawn.remainingSeconds > 6)) throw new Error('Invalid open-world respawn queue');
    const ownedIds = new Set([...this.game.player.team, ...this.game.player.box].map(monster => `companion:${monster.instanceId}`));
    if (savedEntities.filter(entity => entity.kind === 'companion').some(entity => !ownedIds.has(entity.id))) throw new Error('Open-world companion memory is not owned');
    for (const food of checkpoint.foods) if (!Number.isSafeInteger(food.id) || food.id < 1 || food.id >= checkpoint.nextFoodId || !finite(food.x) || !finite(food.z) || invalidTerrain(food.x, food.z)) throw new Error('Invalid open-world food');
    if (new Set(checkpoint.foods.map(food => food.id)).size !== checkpoint.foods.length || new Set(checkpoint.foods.map(food => key(food.x, food.z))).size !== checkpoint.foods.length) throw new Error('Duplicate open-world food');
    for (const saved of savedEntities) {
      if (!saved || typeof saved.id !== 'string' || !saved.id || !['wild', 'companion'].includes(saved.kind) || !Number.isInteger(saved.speciesId) || saved.speciesId < 1 || saved.speciesId > 151 || !Number.isInteger(saved.level) || saved.level < 1 || saved.level > 100 || !finite(saved.x) || !finite(saved.z) || invalidTerrain(saved.x, saved.z) || !Number.isInteger(saved.heading) || saved.heading < 0 || saved.heading > 4 || !Number.isInteger(saved.action) || saved.action < 0 || saved.action > 4 || !finite(saved.energy) || saved.energy < 0 || saved.energy > 100 || !finite(saved.reward) || Math.abs(saved.reward) > 10 || !Number.isSafeInteger(saved.foods) || saved.foods < 0 || !Number.isSafeInteger(saved.collisions) || saved.collisions < 0 || !Array.isArray(saved.observation) || saved.observation.length !== 12 || !saved.observation.every(finite) || saved.brain?.graphId !== this.graph.id || saved.brain.sensoryBypass !== false) throw new Error('Invalid open-world entity');
      const { graphId: _graphId, ...state } = structuredClone(saved.brain), brain = Brain.restore({ ...state, graph: this.graph }); brain.state.graph = this.graph; this.brains.set(saved.id, brain);
      const { brain: _savedBrain, ...rest } = structuredClone(saved), entity = { ...rest, brain: brain.state };
      if (memories.includes(saved)) this.companionMemories.set(entity.id, entity); else this.entities.push(entity);
    }
    if (checkpoint.selectedWildId !== undefined && !this.entities.some(entity => entity.kind === 'wild' && entity.id === checkpoint.selectedWildId)) throw new Error('Invalid selected wild Pokemon');
    if ((checkpoint.battleWildId !== undefined) !== !!this.game.battle || (checkpoint.battleWildId && this.game.battle?.kind === 'wild' && !this.entities.some(entity => entity.kind === 'wild' && entity.id === checkpoint.battleWildId))) throw new Error('Open-world battle does not match game');
    if (checkpoint.controlMode !== undefined && !['auto', 'manual'].includes(checkpoint.controlMode)) throw new Error('Invalid control mode checkpoint');
    if ((checkpoint.selectionPinned !== undefined && typeof checkpoint.selectionPinned !== 'boolean') || (checkpoint.trackingSelected !== undefined && typeof checkpoint.trackingSelected !== 'boolean')) throw new Error('Invalid target selection');
    if (checkpoint.visitedTownIds !== undefined && (!Array.isArray(checkpoint.visitedTownIds) || new Set(checkpoint.visitedTownIds).size !== checkpoint.visitedTownIds.length || checkpoint.visitedTownIds.some(id => !KANTO_LOCATIONS.some(place => place.id === id && place.kind === 'town')))) throw new Error('Invalid visited towns');
    this.visitedTownIds = checkpoint.visitedTownIds ? [...checkpoint.visitedTownIds] : ['pallet'];
    this.selectionPinned = checkpoint.selectionPinned ?? false; this.trackingSelected = checkpoint.trackingSelected ?? Boolean(checkpoint.selectedWildId);
    if (checkpoint.rewardLedgers !== undefined) {
      if (!checkpoint.rewardLedgers || typeof checkpoint.rewardLedgers !== 'object' || Array.isArray(checkpoint.rewardLedgers)) throw new Error('Invalid reward ledgers');
      const owners = this.rewardOwnerIds();
      for (const [id, ledger] of Object.entries(checkpoint.rewardLedgers)) { validateRewardLedger(ledger); if (ledger.individualId !== id || !owners.has(id)) throw new Error('Reward ledger owner mismatch'); }
      this.rewardLedgers = structuredClone(checkpoint.rewardLedgers);
    }
    this.controlMode = checkpoint.controlMode ?? 'auto';
    this.rng = new Random(checkpoint.rng); this.tick = checkpoint.tick; this.player = structuredClone(checkpoint.player); this.foods = structuredClone(checkpoint.foods);
    this.selectedWildId = checkpoint.selectedWildId; this.autoCapture = checkpoint.autoCapture; this.autoHunt = checkpoint.autoHunt ?? true; this.battleWildId = checkpoint.battleWildId; this.battleElapsed = checkpoint.battleElapsed;
    this.pendingCapture = checkpoint.pendingCapture; this.pendingBall = checkpoint.pendingBall; this.lastPlayerReward = checkpoint.lastPlayerReward; this.lastEnemyReward = checkpoint.lastEnemyReward;
    this.pendingAction = structuredClone(checkpoint.pendingAction);
    this.spawnSerial = checkpoint.spawnSerial; this.nextFoodId = checkpoint.nextFoodId; this.respawnQueue = structuredClone(respawns); this.manualControlRemaining = checkpoint.manualControlRemaining ?? 0; this.densityRemaining = checkpoint.densityRemaining ?? 0;
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
  const monsters = [...(game.player?.team ?? []), ...(game.player?.box ?? []), ...(game.battle?.player?.team ?? []), ...(game.battle?.enemy?.team ?? []), ...(game.captureOffer ? [game.captureOffer] : [])];
  for (const monster of monsters) if (monster.brain) monster.brain.graph = structuredClone(graph);
  validateGame(game);
  if (game.battle) game.battle.player.team = game.player.team;
  return { game, simulation: new OpenWorldSimulation(graph, game, value.world.seed, value.world, policy, value.world.entities.filter(entity => entity.kind === 'wild').length) };
}
