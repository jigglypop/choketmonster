import { Brain, validateGraph, type BrainState, type Graph } from '../core/brain';
import { addEvolutionSteps } from '../game/evolution-progress';
import { advanceEggProgress } from '../game/breeding';
import { Random, clamp } from '../core/random';
import { POKEMON, getMove, getSpecies } from '../data/pokemon';
import { getVersionSpeciesIds } from '../data/pokemon-versions';
import { replenishBalls, challengeCampaignGym, challengeCampaignTrainer, challengeFieldTrainer, claimRegionalStarter as claimStarter } from '../game/engine';
import { CAMPAIGN_REGIONS, getRegionalBadges, getCampaignGyms, getNextCampaignTrainer, campaignTravelReason, regionalWildLevels, type CampaignRegion } from '../game/campaign';
import { availableFieldTrainer, fieldTrainersAt, type FieldTrainer } from '../data/field-trainers';
import { chooseRegionalEncounter, encounterPeriodAt, regionalRuntimePools, supplementalEncounterRules, type EncounterPeriod } from '../data/regional-encounters';
import { chooseExpansionEncounter, expansionEncounterSpecies, isExpansionRegion } from '../data/expansion-spawns';
import { gameplayHabitat } from '../game/habitat';
import { ConnectomeController, type NeuralMonster } from '../game/connectome';
import { chooseServerBrains, usesServerBrain, type ServerDecision } from '../game/server-brain';
import { activateBattleTransformation, actBattle, availableEvolutions, battleMonsterView, battleMonsterTypes, captureDefeatedWild, createMonster, evolve, evolutionRoute, firstUsableRegionalTeamIndex, validateGame, type BallItem, type BattleAction, type BattleTurnResult, type GameState, type Monster } from '../game/engine';
import { monsterRegionalUseReason, needsRegionalStarter } from '../game/regional-policy';
import { KANTO_START, KANTO_MAP_VERSION } from './kanto';
import { WORLD_MIN, WORLD_MAX, WORLD_SCALE, migrateSurfaceSnapshotCoordinates, surfaceSceneId } from './world-space';
import { CAVE_SCENES, caveLocation, cavePortalAtInterior, cavePortalAtSurface, getCaveScene } from './caves';
import { getWorldAtlas, getLegacyJohtoAtlas, getLegacyExpansionAtlas, migrateLegacyExpansionLocationId, type WorldAtlas, type WorldRegionId } from './atlas';
import { getPlayableSpeciesIds, isPlayableAdventureVersion, isPlayableWorldRegion, playableWorldRegionForVersion } from './availability';
import type { FieldPolicy } from '../game/field';
import type { WorldSample } from './types';
export type { WorldSample } from './types';
import { appendReward, emptyRewardLedger, rewardEncounter, rewardBattleTurn, validateRewardLedger, type EngineeredReward, type RewardLedger, type RewardDecisionSource } from '../game/rewards';

export const OPEN_WORLD_MODEL = 'pokemon-open-world-recurrent-v1' as const;
export { WORLD_MIN, WORLD_MAX };
export const DEFAULT_WILD_COUNT = 15;
export type WorldBiome = 'meadow' | 'forest' | 'lake' | 'rock';
export type WorldPosition = { x: number; z: number; heading: number };
export type WorldFood = { id: number; x: number; z: number };
export type WorldRespawn = { id: string; speciesId: number; level: number; biome: WorldBiome; originX: number; originZ: number; remainingSeconds: number };
export type WorldTarget = { kind: 'food' | 'player' | 'wild' | 'explore'; id: string; x: number; z: number };
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
  serverFinalizations?: ServerFinalization[];
  player: WorldPosition; selectedWildId?: string; autoCapture: boolean; autoHunt?: boolean; battleWildId?: string;
  worldClockSeconds?: number;
  battleElapsed: number; pendingCapture: boolean; pendingBall?: BallItem; lastPlayerReward: number | null; lastEnemyReward: number | null;
  pendingAction?: BattleAction;
  manualControlRemaining?: number;
  /** Next preferred team slot for an automatic wild battle. */
  nextBattleTeamIndex?: number;
  controlMode?: 'auto' | 'manual';
  selectionPinned?: boolean;
  trackingSelected?: boolean;
  visitedTownIds?: string[];
  visitedTownsByRegion?: Record<string, string[]>;
  rewardLedgers?: Record<string, RewardLedger>;
  regionId?: WorldRegionId;
  sceneId?: string;
  surfaceReturn?: { sceneId: string; x: number; z: number };
  mapVersion?: string;
  /** Legacy timer is accepted on import but no longer drives encounters. */
  densityRemaining?: number;
  spawnAnchor?: { x: number; z: number };
  encounterLayout?: typeof RED_ENCOUNTER_LAYOUT | typeof GOLD_ENCOUNTER_LAYOUT | typeof EXPANSION_ENCOUNTER_LAYOUT;
  spawnSerial: number; nextFoodId: number; foods: WorldFood[]; respawnQueue?: WorldRespawn[]; entities: OpenWorldEntitySnapshot[]; companionMemories?: OpenWorldEntitySnapshot[];
};
type ServerFinalization = { self: NeuralMonster; other: NeuralMonster; turn: number; reward: number; learning: boolean; episode: string };
export type OpenWorldEvent =
  | { type: 'move' | 'wait' | 'collision' | 'food'; entityId: string; x: number; z: number; reward: number }
  | { type: 'encounter'; entityId: string; speciesId: number; level: number }
  | { type: 'battle-turn'; entityId: string; result: BattleTurnResult }
  | { type: 'evolved'; entityId: string; fromSpeciesId: number; speciesId: number };
export type OpenWorldStep = { tick: number; events: OpenWorldEvent[]; battleActive: boolean };
export type OpenWorldSave = { schema: 1; model: typeof OPEN_WORLD_MODEL; graphId: string; game: unknown; world: OpenWorldSnapshot };

export const RED_ENCOUNTER_LAYOUT = 'red-v1';
export const GOLD_ENCOUNTER_LAYOUT = 'gold-v1';
export const EXPANSION_ENCOUNTER_LAYOUT = 'expansion-v1';

export function needsRedEncounterMigration(world: OpenWorldSnapshot, version = 'red'): boolean {
  if (world.regionId && isExpansionRegion(world.regionId)) return world.encounterLayout !== EXPANSION_ENCOUNTER_LAYOUT;
  if (world.regionId === 'johto') return world.encounterLayout !== GOLD_ENCOUNTER_LAYOUT;
  if (world.encounterLayout === GOLD_ENCOUNTER_LAYOUT) return true;
  return world.encounterLayout === undefined && (!['red', 'blue', 'yellow'].includes(version) || (world.regionId ?? 'kanto') !== 'kanto');
}

const PATH_SAMPLE_DISTANCE = .45;
const MANUAL_CONTROL_HOLD = .3;
const SPAWN_TRAVEL_DISTANCE = 24;
const WILD_UNLOAD_DISTANCE = 38;
const BATTLE_INTERVAL = 0.9;
const UNIQUE_SPECIES = new Set([144, 145, 146, 150, 151]);
const DIRECTIONS = [{ x: 0, z: -1 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }] as const;
const finite = (value: number) => typeof value === 'number' && Number.isFinite(value);
const isCampaignRegion = (region: string): region is CampaignRegion => CAMPAIGN_REGIONS.includes(region as CampaignRegion);
const key = (x: number, z: number) => `${x.toFixed(2)}:${z.toFixed(2)}`;
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
function hash(text: string): number { let value = 2166136261; for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0; return value || 0x6d2b79f5; }
function stripGraph(state: BrainState): WorldBrainState {
  // This runs once per world creature on every save. Copy the small mutable
  // matrices directly; cloning the full state repeatedly made a 16-creature
  // checkpoint block the UI for several seconds in Chromium.
  return {
    schema: state.schema, seed: state.seed, graphId: state.graph.id,
    inputWeights: state.inputWeights.map(row => [...row]), readout: state.readout.map(row => [...row]),
    activity: [...state.activity], previous: state.previous ? [...state.previous] : null,
    action: state.action, rng: state.rng, updates: state.updates,
    ...(state.sensoryBypass === undefined ? {} : { sensoryBypass: state.sensoryBypass }),
  };
}

/** Shared deterministic terrain contract. Rendering may sample it freely without consuming simulation RNG. */
export function sampleWorld(x: number, z: number): WorldSample {
  return getWorldAtlas('kanto').sample(x, z);
}

export function biomeForSpecies(speciesId: number): WorldBiome {
  const habitat = gameplayHabitat(getSpecies(speciesId));
  if (habitat === 'forest') return 'forest';
  if (habitat === 'sea' || habitat === 'waters-edge') return 'lake';
  if (habitat === 'mountain' || habitat === 'rough-terrain' || habitat === 'cave' || habitat === 'rare') return 'rock';
  return 'meadow';
}

/** Engineered mapping from Pokemon base Speed to open-world units per second. */
export function movementSpeed(speciesId: number, level = 5): number {
  const baseSpeed = getSpecies(speciesId).baseStats.speed;
  return Math.min(12, (1.2 + baseSpeed * .018) * 2.4 + Math.max(0, level - 5) * .0264);
}

export function nextSpeciesInBiome(speciesId: number): number {
  const biome = biomeForSpecies(speciesId), candidates = getPlayableSpeciesIds().filter(id => biomeForSpecies(id) === biome);
  const index = candidates.indexOf(speciesId); if (index < 0) throw new Error('Species is missing from its biome');
  return candidates[(index + 1) % candidates.length];
}

export function speciesForSpawn(serial: number): number {
  if (!Number.isSafeInteger(serial) || serial < 1) throw new Error('Spawn serial must be a positive integer');
  const species = getPlayableSpeciesIds();
  return species[(serial - 1) % species.length];
}

export function initialSpawnSpecies(serial: number): number {
  if (!Number.isSafeInteger(serial) || serial < 1) throw new Error('Spawn serial must be a positive integer');
  const playable = getPlayableSpeciesIds();
  const grouped = (biome: WorldBiome) => playable.filter(id => biomeForSpecies(id) === biome);
  const meadow = grouped('meadow'), forest = grouped('forest'), lake = grouped('lake'), rock = grouped('rock');
  const preferred = [...meadow.slice(0, 7), ...forest.slice(0, 3), ...lake.slice(0, 3), ...rock.slice(0, 2)];
  const remaining = playable.filter(id => !preferred.includes(id));
  const sequence = [...preferred, ...remaining]; return sequence[(serial - 1) % sequence.length];
}

export class OpenWorldSimulation {
  readonly graph: Graph;
  readonly seed: number;
  readonly game: GameState;
  regionId: WorldRegionId;
  sceneId: string;
  surfaceReturn?: { sceneId: string; x: number; z: number };
  rng: Random;
  tick = 0;
  player: WorldPosition = { ...KANTO_START, heading: 0 };
  foods: WorldFood[] = [];
  entities: OpenWorldEntity[] = [];
  selectedWildId?: string;
  selectionPinned = false;
  trackingSelected = false;
  visitedTownIds: string[] = ['pallet'];
  visitedTownsByRegion: Record<string, string[]> = { kanto: ['pallet'] };
  lastMovementBlock?: string;
  rewardLedgers: Record<string, RewardLedger> = {};
  autoCapture = true;
  /** Kept in checkpoints for compatibility; automatic movement always hunts. */
  get autoHunt(): boolean { return this.controlMode === 'auto'; }
  controlMode: 'auto' | 'manual' = 'auto';
  worldClockSeconds = 0;
  battleWildId?: string;
  battleElapsed = 0;
  spawnSerial = 1;
  nextFoodId = 1;
  respawnQueue: WorldRespawn[] = [];
  manualControlRemaining = 0;
  private spawnAnchor: { x: number; z: number };
  private pendingCapture = false;
  private pendingBall?: BallItem;
  private pendingAction?: BattleAction;
  private lastPlayerReward: number | null = null;
  private lastEnemyReward: number | null = null;
  private readonly brains = new Map<string, Brain>();
  private readonly companionMemories = new Map<string, OpenWorldEntity>();
  private readonly battleController: ConnectomeController;
  private readonly policy?: FieldPolicy;
  private requireModels = false;
  private readonly modelStatuses = new Map<string, { speciesId: number; status: 'loading' | 'ready' | 'failed' }>();
  private serverTurn?: { battle: NonNullable<GameState['battle']>; turn: number; decisions: Map<string, ServerDecision> };
  private serverFinalizations: ServerFinalization[] = [];
  private restoringAtlas?: WorldAtlas;
  private evolutionStepRemainder = 0;

  get regionalBadges(): number { return getRegionalBadges(this.game, this.regionId); }
  get atlas(): WorldAtlas { return this.restoringAtlas ?? getWorldAtlas(this.regionId); }
  sampleWorld(x: number, z: number): WorldSample { return getCaveScene(this.sceneId)?.sample(x, z) ?? this.atlas.sample(x, z); }
  locationAt(x: number, z: number) { return caveLocation(this.sceneId) ?? this.atlas.locationAt(x, z); }
  isSafeTown(x: number, z: number): boolean { return !getCaveScene(this.sceneId) && this.atlas.locationAt(x, z).kind === 'town'; }
  /** Headless simulations need no renderer; the playable panel opts into this gate. */
  requireReadyModels(): void { this.requireModels = true; this.modelStatuses.clear(); }
  private modelSpecies(entityId: string): number | undefined {
    const entity = this.entities.find(item => item.id === entityId), battle = this.game.battle;
    const monster = entity?.kind === 'companion'
      ? battle?.player.team[battle.player.activeIndex] ?? this.game.player.team[firstUsableRegionalTeamIndex(this.game, this.regionId)]
      : battle && entityId === this.battleWildId ? battle.enemy.team[battle.enemy.activeIndex] : undefined;
    return (monster && battle?.transformations?.[monster.instanceId]?.speciesId) ?? monster?.speciesId ?? entity?.speciesId;
  }
  setModelStatus(entityId: string, status: 'loading' | 'ready' | 'failed' | 'untracked', speciesId = this.modelSpecies(entityId)): void {
    if (speciesId === undefined || speciesId !== this.modelSpecies(entityId)) return;
    // Leaving the frustum is not a successful load. Never release a failed model's gate.
    if (status === 'untracked') {
      if (this.modelStatuses.get(entityId)?.status !== 'failed') this.modelStatuses.delete(entityId);
    } else this.modelStatuses.set(entityId, { speciesId, status });
  }
  modelStatus(entityId: string): 'loading' | 'failed' | undefined {
    const entry = this.modelStatuses.get(entityId);
    if (!entry || entry.speciesId !== this.modelSpecies(entityId)) return this.requireModels ? 'loading' : undefined;
    return entry.status === 'ready' ? undefined : entry.status;
  }
  get modelsReady(): boolean {
    const companion = this.entities.find(entity => entity.kind === 'companion');
    return !!companion && !this.modelStatus(companion.id) && (!this.game.battle || !!this.battleWildId && !this.modelStatus(this.battleWildId));
  }
  get dayPeriod(): EncounterPeriod { return encounterPeriodAt(this.worldClockSeconds); }
  get timeOfDay(): EncounterPeriod { return this.dayPeriod; }
  get worldHour(): number { return this.worldClockSeconds / (20 * 60) * 24; }
  // Legacy encounter clock remains save-compatible; presentation is always daytime.
  get daylightIntensity(): number { return 1; }
  synchronizeWorldClock(epochMilliseconds: number): void {
    if (!Number.isFinite(epochMilliseconds) || epochMilliseconds < 0) throw new Error('World clock timestamp must be non-negative');
    this.worldClockSeconds = epochMilliseconds / 1000 % (20 * 60);
    this.synchronizeEvolutionContext();
  }
  synchronizeEvolutionContext(multiplayer = false): void {
    this.game.evolutionContext = { period: this.dayPeriod === 'night' ? 'night' : 'day',
      regionId: this.regionId, locationId: this.locationAt(this.player.x, this.player.z).id,
      raining: false, multiplayer };
  }
  private recordEvolutionWalk(meters: number): void {
    const lead = this.game.player.team[0]; if (!lead || !Number.isFinite(meters) || meters <= 0) return;
    this.evolutionStepRemainder += meters;
    const steps = Math.floor(this.evolutionStepRemainder);
    if (steps) { this.evolutionStepRemainder -= steps; addEvolutionSteps(lead, steps); advanceEggProgress(this.game, steps); }
  }
  // Menu challenges do not spawn human NPCs in the world.
  get localFieldTrainer(): FieldTrainer | undefined {
    return availableFieldTrainer(this.regionId, this.locationAt(this.player.x, this.player.z).id, this.game.defeatedFieldTrainers);
  }
  trainerRenderData(radius = 40): Array<FieldTrainer & { x: number; z: number }> {
    if (!finite(radius) || radius <= 0 || radius > 120) throw new Error('Trainer render radius must be 0..120');
    return [];
  }
  portalRenderData(radius = 60): Array<{ id: string; label: string; targetSceneId: string; x: number; z: number }> {
    const cave = getCaveScene(this.sceneId);
    if (cave) return cave.portals.filter(portal => distance(portal.interior, this.player) <= radius)
      .map(portal => ({ id: portal.id, label: `Exit to ${portal.surfaceLocationId}`, targetSceneId: portal.surfaceSceneId, ...portal.interior }));
    return CAVE_SCENES.filter(scene => scene.regionId === this.regionId).flatMap(scene => scene.portals
      .filter(portal => distance(portal.surface, this.player) <= radius)
      .map(portal => ({ id: portal.id, label: scene.label, targetSceneId: scene.sceneId, ...portal.surface })));
  }

  /** Resolve one matching battle frame before advancing it. Network timing never consumes simulation RNG. */
  async prepareServerBattle(learning: boolean): Promise<void> {
    if (!usesServerBrain()) return;
    while (this.serverFinalizations.length) {
      const tasks = this.serverFinalizations.slice(0, 2);
      if (tasks.length === 2 && tasks[0].self.instanceId === tasks[1].self.instanceId) tasks.pop();
      await chooseServerBrains(this.battleController, tasks.map(task => ({ self: task.self, foe: task.other,
        turn: task.turn, reward: task.reward, learning: task.learning, battleId: task.episode, terminal: true })));
      this.serverFinalizations.splice(0, tasks.length);
    }
    const battle = this.game.battle;
    if (!battle || !this.modelsReady || (this.controlMode === 'manual' && !this.pendingAction && !this.pendingCapture)) return;
    const player = battle.player.team[battle.player.activeIndex], enemy = battle.enemy.team[battle.enemy.activeIndex];
    const frame = this.serverTurn?.battle === battle && this.serverTurn.turn === battle.turn
      ? this.serverTurn : { battle, turn: battle.turn, decisions: new Map<string, ServerDecision>() };
    const automatic = !battle.awaitingSwitch && !this.pendingAction && !this.pendingCapture;
    const participants = (automatic ? [player, enemy] : [enemy]).filter(monster => !frame.decisions.has(monster.instanceId));
    if (participants.length) {
      const decisions = await chooseServerBrains(this.battleController, participants.map(monster => {
      const other = monster === player ? enemy : player;
      const self = battleMonsterView(battle, monster), foe = battleMonsterView(battle, other);
      return { self, foe, turn: frame.turn, reward: monster === player ? this.lastPlayerReward : this.lastEnemyReward,
        learning, battleId: this.serverBattleId(battle), context: { automatic: true,
          selfStatStages: battle.statStages?.[monster.instanceId], otherStatStages: battle.statStages?.[other.instanceId] } };
      }));
      participants.forEach((monster, index) => frame.decisions.set(monster.instanceId, decisions[index]));
    }
    if (this.game.battle === battle && battle.turn === frame.turn) this.serverTurn = frame;
  }

  private serverBattleId(battle: NonNullable<GameState['battle']>) { return `${this.seed}:${battle.enemy.team[0].instanceId}`; }

  private serverBattleReady(): boolean {
    const battle = this.game.battle, frame = this.serverTurn;
    if (!battle || frame?.battle !== battle || frame.turn !== battle.turn) return false;
    if (!frame.decisions.has(battle.enemy.team[battle.enemy.activeIndex].instanceId)) return false;
    return Boolean(battle.awaitingSwitch || this.pendingAction || this.pendingCapture
      || frame.decisions.has(battle.player.team[battle.player.activeIndex].instanceId));
  }

  constructor(graph: Graph, game: GameState, seed: number, checkpoint?: OpenWorldSnapshot, policy?: FieldPolicy, wildCount = DEFAULT_WILD_COUNT) {
    validateGraph(graph); if (graph.kind !== 'connectome-subset') throw new Error('Open world requires a real connectome subset');
    validateGame(game); if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Open-world seed must be uint32');
    if (!checkpoint && !isPlayableAdventureVersion(game.adventureVersion ?? 'red')) {
      game.adventureVersion = 'national'; game.versionCaught ??= {}; game.versionCaught.national ??= [];
    }
    const rosterCount = checkpoint ? checkpoint.entities.filter(entity => entity.kind === 'wild').length + (checkpoint.respawnQueue?.length ?? 0) : wildCount;
    if (!Number.isInteger(rosterCount) || rosterCount < 0 || rosterCount > 18 || (!checkpoint && rosterCount < 12)) throw new Error('Open world requires at most 18 saved wild Pokemon or 12..18 new wild Pokemon');
    this.graph = structuredClone(graph); this.game = game; this.seed = seed >>> 0; this.rng = new Random(this.seed);
    // Saves created before regional atlases always used Kanto, even when their
    // collection version was Gold, Scarlet, or another expanded data set.
    this.regionId = checkpoint ? checkpoint.regionId ?? 'kanto'
      : game.campaign?.startRegion === 'johto' ? 'johto' : playableWorldRegionForVersion(game.adventureVersion ?? 'red');
    this.sceneId = checkpoint?.sceneId ?? surfaceSceneId(this.regionId);
    // Resolve eagerly so unknown checkpoint regions fail before any entity state is accepted.
    getWorldAtlas(this.regionId);
    const legacyJohto = this.regionId === 'johto' && checkpoint?.mapVersion === 'johto-atlas-v1';
    const legacyExpansionAtlas = checkpoint ? getLegacyExpansionAtlas(this.regionId, checkpoint.mapVersion) : undefined;
    if (legacyJohto) this.restoringAtlas = getLegacyJohtoAtlas();
    else if (legacyExpansionAtlas) this.restoringAtlas = legacyExpansionAtlas;
    const travelReason = campaignTravelReason(game, this.regionId);
    // Provisional expansion saves may predate campaign travel locks. Validate
    // their old coordinate space first, then return them to an available start.
    if (travelReason && !legacyExpansionAtlas && !(checkpoint && !isPlayableWorldRegion(this.regionId))) throw new Error(travelReason);
    this.player = { ...this.atlas.start, heading: 0 };
    this.spawnAnchor = { ...this.player };
    this.visitedTownIds = this.initialVisitedTowns(this.atlas);
    this.visitedTownsByRegion = { [this.regionId]: [...this.visitedTownIds] };
    this.battleController = new ConnectomeController(this.graph); this.policy = policy ? structuredClone(policy) : undefined;
    if (this.policy && (this.policy.graphId !== graph.id || this.policy.schema !== 1)) throw new Error('Open-world field policy does not match graph');
    if (checkpoint) {
      this.restore(checkpoint);
      this.restoringAtlas = undefined;
      if (!isPlayableWorldRegion(this.regionId)) this.migrateUnavailableRegion();
      else {
        if (!isPlayableAdventureVersion(this.game.adventureVersion ?? 'red')) {
          this.game.adventureVersion = 'national'; this.game.versionCaught ??= {}; this.game.versionCaught.national ??= [];
        }
        if (this.regionId === 'kanto' && !checkpoint.mapVersion) this.migrateLegacyMap();
        else if (this.regionId === 'kanto' && checkpoint.mapVersion !== KANTO_MAP_VERSION) this.migrateKantoBoundaries();
        else if (legacyJohto) this.migrateJohtoMap();
        else if (legacyExpansionAtlas) this.migrateExpansionMap(legacyExpansionAtlas);
      }
      if (legacyExpansionAtlas && travelReason) this.migrateUnavailableRegion(this.game.campaign?.startRegion === 'johto' ? 'johto' : 'kanto');
      this.migrateUnavailableWildSpecies(needsRedEncounterMigration(checkpoint, this.game.adventureVersion));
      // Older and interrupted checkpoints can be short of the current minimum.
      // Keep every validated saved individual and deterministically fill only the missing slots.
      while (this.rosterStatus().total < 12) this.spawnWild();
    }
    else {
      this.entities.push(this.makeCompanion());
      while (this.wildEntities().length < wildCount) this.spawnWild();
      while (this.foods.length < 24) this.spawnFood();
    }
    this.relocateTownWilds();
  }

  movePlayer(position: WorldPosition): boolean {
    if (![position.x, position.z, position.heading].every(finite) || !Number.isInteger(position.heading) || position.heading < 0 || position.heading > 4) throw new Error('Invalid player position');
    const next = { x: clamp(position.x, WORLD_MIN, WORLD_MAX), z: clamp(position.z, WORLD_MIN, WORLD_MAX), heading: position.heading };
    if (this.sampleWorld(next.x, next.z).blocked) return false;
    this.player = next; return true;
  }

  movePartner(position: WorldPosition): boolean {
    if (!this.modelsReady) return false;
    if (this.game.battle?.kind === 'wild' && this.game.battle.canRun && this.controlMode === 'manual') {
      this.requestAction({ type: 'run' }); return false;
    }
    if (this.game.battle || this.game.captureOffer || ![position.x, position.z, position.heading].every(finite) || !Number.isInteger(position.heading) || position.heading < 0 || position.heading > 4) return false;
    const companion = this.entities.find(entity => entity.kind === 'companion'); if (!companion) return false;
    this.lastMovementBlock = undefined;
    if (!getCaveScene(this.sceneId)) {
      const traversal = this.atlas.evaluateTraversal(companion, position, this.regionalBadges);
      if (!traversal.allowed) { this.lastMovementBlock = traversal.reason; return false; }
    }
    const maximum = movementSpeed(companion.speciesId, companion.level) * .35;
    // Manual movement can pass wild creatures; terrain and route gates still block it.
    if (distance(companion, position) > maximum || this.pathBlocked(companion, position.x, position.z, [])) return false;
    this.recordEvolutionWalk(distance(companion, position));
    companion.x = position.x; companion.z = position.z; companion.heading = position.heading; companion.action = position.heading; companion.reward = 0;
    const brain = this.brain(companion.id); brain.state.previous = null;
    this.player = structuredClone(position); this.manualControlRemaining = MANUAL_CONTROL_HOLD; this.recordTownVisit(); return true;
  }

  syncPlayerToCompanion(): WorldPosition {
    const companion = this.entities.find(entity => entity.kind === 'companion'); if (!companion) return structuredClone(this.player);
    this.player = { x: companion.x, z: companion.z, heading: companion.heading }; return structuredClone(this.player);
  }

  private recordTownVisit(): void {
    const town = this.locationAt(this.player.x, this.player.z);
    if (town.kind === 'town' && distance(town, this.player) < 8.5 && !this.visitedTownIds.includes(town.id)) {
      this.visitedTownIds.push(town.id);
      this.visitedTownsByRegion[this.regionId] = [...this.visitedTownIds];
    }
  }

  teleportToTown(townId: string): boolean {
    if (this.game.battle || this.game.captureOffer || !this.visitedTownIds.includes(townId)) return false;
    const arrival = this.atlas.travelPoint(townId, this.regionalBadges);
    if (!arrival) return false;
    this.relocatePartner(arrival); this.game.logs.push(`${this.locationAt(arrival.x, arrival.z).name}으로 순간이동했습니다.`); this.game.logs = this.game.logs.slice(-200); return true;
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
    this.spawnAnchor = { ...this.player }; this.recordTownVisit();
  }

  selectWild(id: string | null, inspectOnly = false): void {
    if (id === null) { this.selectedWildId = undefined; this.selectionPinned = false; this.trackingSelected = false; return; }
    const entity = this.entities.find(item => item.kind === 'wild' && item.id === id); if (!entity) throw new Error('Unknown wild Pokemon');
    this.selectedWildId = id; this.selectionPinned = true; this.trackingSelected = !inspectOnly;
    if (inspectOnly && !this.game.battle) this.setControlMode('manual');
  }

  trackSelected(): boolean {
    if (!this.selectedWildId || this.game.battle || this.game.captureOffer) return false;
    this.setControlMode('auto', true); this.selectionPinned = true; this.trackingSelected = true; return true;
  }

  canEngageWild(id: string): boolean {
    const companion = this.entities.find(entity => entity.kind === 'companion'), wild = this.entities.find(entity => entity.id === id && entity.kind === 'wild');
    return !!companion && !!wild && !this.modelStatus(id) && !this.modelStatus(companion.id)
      && !this.isSafeTown(this.player.x, this.player.z) && !this.isSafeTown(wild.x, wild.z) && distance(companion, wild) <= 4 && !this.pathBlocked(companion, wild.x, wild.z, []);
  }

  setAutoCapture(enabled: boolean): void { if (typeof enabled !== 'boolean') throw new Error('Auto-capture flag must be boolean'); this.autoCapture = enabled; }
  get hasBalls(): boolean { return true; }
  get escaping(): boolean { return this.pendingAction?.type === 'run'; }
  setAutoHunt(enabled: boolean): void { if (typeof enabled !== 'boolean') throw new Error('Auto-hunt flag must be boolean'); this.setControlMode(enabled ? 'auto' : 'manual'); }

  setControlMode(mode: 'auto' | 'manual', keepSelectedTarget = false): void {
    if (mode !== 'auto' && mode !== 'manual') throw new Error('Invalid control mode');
    this.controlMode = mode; this.pendingAction = undefined; this.pendingCapture = false; this.battleElapsed = 0;
    if (mode === 'manual') this.trackingSelected = false;
    else {
      this.manualControlRemaining = 0;
      if (!this.game.battle && !keepSelectedTarget) this.selectWild(null);
    }
    const companion = this.entities.find(entity => entity.kind === 'companion');
    if (companion) { this.brain(companion.id).state.previous = null; companion.action = 4; companion.reward = 0; }
    if (this.game.battle) this.clearPendingLearning(this.game.battle.player.team[this.game.battle.player.activeIndex]);
  }

  captureVictory(ball?: BallItem): boolean { return captureDefeatedWild(this.game, ball ?? this.cheapestBall()); }
  transformBattle(kind: 'mega' | 'tera', option: { instanceId?: string; formIdentifier?: string; teraType?: import('../game/contracts').PokemonType } = {}) {
    const transformed = activateBattleTransformation(this.game, kind, option);
    this.serverTurn = undefined;
    this.syncCompanion();
    return transformed;
  }
  releaseVictory(): void { if (this.game.captureOffer) { this.game.logs.push(`${this.game.captureOffer.nickname}을(를) 놓아주었습니다.`); this.game.logs = this.game.logs.slice(-200); this.game.captureOffer = undefined; } }

  reconcileTeamChange(): void {
    this.pendingAction = undefined; this.syncCompanion(); this.syncPlayerToCompanion();
  }

  get regionalStarterRequired(): boolean { return needsRegionalStarter(this.game, this.regionId); }

  claimRegionalStarter(speciesId: number): Monster {
    const monster = claimStarter(this.game, this.regionId, speciesId);
    this.reconcileTeamChange();
    return monster;
  }

  challengeLocalGym(): boolean {
    if (!isCampaignRegion(this.regionId)) return false;
    const location = this.locationAt(this.player.x, this.player.z), gym = getCampaignGyms(this.game, this.regionId).find(item => item.locationId === location.id);
    if (!gym || this.game.battle || this.game.captureOffer || gym.badge !== this.regionalBadges + 1 || !this.game.player.team.some(monster => monster.hp > 0)) return false;
    challengeCampaignGym(this.game, this.regionId, location.id);
    this.battleWildId = `gym:${this.regionId}:${gym.badge}`; this.resetTrainerTurn();
    return true;
  }

  challengeFieldTrainerById(id: string): boolean {
    if (this.game.battle || this.game.captureOffer || !this.game.player.team.some(monster => monster.hp > 0)) return false;
    const trainer = fieldTrainersAt(this.regionId, this.locationAt(this.player.x, this.player.z).id)
      .find(item => item.id === id && !this.game.defeatedFieldTrainers?.includes(id));
    if (!trainer || campaignTravelReason(this.game, trainer.region)) return false;
    challengeFieldTrainer(this.game, trainer);
    this.battleWildId = `trainer:${trainer.id}`; this.resetTrainerTurn(); this.controlMode = 'auto';
    return true;
  }

  challengeLocalTrainer(id?: string): boolean {
    if (!isCampaignRegion(this.regionId) || this.game.battle || this.game.captureOffer || !this.game.player.team.some(monster => monster.hp > 0)) return false;
    if (id) return this.challengeFieldTrainerById(id);
    const trainer = getNextCampaignTrainer(this.game, this.regionId);
    if (!trainer || this.locationAt(this.player.x, this.player.z).id !== trainer.locationId || this.regionalBadges < 8) return false;
    challengeCampaignTrainer(this.game, this.regionId);
    this.battleWildId = `trainer:${trainer.id}`; this.resetTrainerTurn(); return true;
  }

  private resetTrainerTurn(): void {
    this.battleElapsed = 0; this.lastPlayerReward = null; this.lastEnemyReward = null;
    this.serverTurn = undefined; this.pendingAction = undefined; this.pendingCapture = false; this.pendingBall = undefined;
  }

  traverseCavePortal(): boolean {
    if (this.game.battle || this.game.captureOffer) return false;
    const interiorPortal = getCaveScene(this.sceneId) && cavePortalAtInterior(this.sceneId, this.player.x, this.player.z);
    if (interiorPortal) {
      this.sceneId = interiorPortal.surfaceSceneId; this.surfaceReturn = undefined;
      this.resetScenePopulation(interiorPortal.surfaceArrival); return true;
    }
    const entrance = cavePortalAtSurface(this.regionId, this.player.x, this.player.z);
    if (!entrance) return false;
    this.surfaceReturn = { sceneId: entrance.portal.surfaceSceneId, ...entrance.portal.surfaceArrival };
    this.sceneId = entrance.scene.sceneId;
    this.resetScenePopulation(entrance.portal.interiorArrival); return true;
  }

  caveExits(): Array<{ id: string; label: string; surfaceLocationId: string; distance: number }> {
    const cave = getCaveScene(this.sceneId);
    if (!cave) return [];
    return cave.portals.map(portal => ({
      id: portal.id,
      label: this.atlas.locations.find(location => location.id === portal.surfaceLocationId)?.name ?? portal.surfaceLocationId,
      surfaceLocationId: portal.surfaceLocationId,
      distance: distance(portal.interior, this.player),
    })).sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  }

  /** Immediately leaves the current cave through a selected, or nearest, real portal. */
  exitCave(portalId?: string): boolean {
    if (this.game.battle || this.game.captureOffer) return false;
    const cave = getCaveScene(this.sceneId);
    if (!cave) return false;
    const portal = portalId
      ? cave.portals.find(candidate => candidate.id === portalId)
      : [...cave.portals].sort((a, b) => distance(a.interior, this.player) - distance(b.interior, this.player))[0];
    if (!portal) return false;
    this.sceneId = portal.surfaceSceneId; this.surfaceReturn = undefined;
    this.resetScenePopulation(portal.surfaceArrival);
    return true;
  }

  private resetScenePopulation(arrival: { x: number; z: number }): void {
    this.relocatePartner(arrival);
  }

  traverseTunnel(): boolean {
    if (this.regionId !== 'kanto' || this.game.battle || this.game.captureOffer || this.regionalBadges < 2) return false;
    const entrances = this.atlas.locations.filter(item => item.id === 'diglett-cave-east' || item.id === 'diglett-cave-west');
    const from = entrances.find(item => distance(item, this.player) <= 5); if (!from) return false;
    const to = entrances.find(item => item !== from)!;
    const arrival = this.atlas.safeArrival(to.id, this.regionalBadges); if (!arrival) return false;
    this.relocatePartner(arrival);
    this.game.logs.push(`디그다의 굴을 지나 ${to.name}으로 이동했습니다.`); this.game.logs = this.game.logs.slice(-200); return true;
  }

  requestCapture(ball?: BallItem): boolean {
    if (this.game.battle?.kind !== 'wild' || !this.battleWildId || this.game.battle.awaitingSwitch) return false;
    if (ball !== undefined && !['poke-ball', 'great-ball', 'ultra-ball'].includes(ball)) return false;
    const selected = this.bestBall();
    this.pendingCapture = true; this.pendingBall = selected; this.pendingAction = undefined; return true;
  }

  /** Queues one player-selected action while preserving the simulation's battle reward and cleanup path. */
  requestAction(action: BattleAction): boolean {
    if (!this.game.battle || !this.validRequestedAction(action)) return false;
    const battle = this.game.battle;
    if (battle.awaitingSwitch && action.type !== 'switch') return false;
    if (action.type === 'run' && !battle.canRun) return false;
    if (action.type === 'switch' && (action.index === battle.player.activeIndex || !battle.player.team[action.index]?.hp)) return false;
    if (action.type === 'switch' && battle.policyRegion && monsterRegionalUseReason(this.game, battle.policyRegion, battle.player.team[action.index])) return false;
    if (action.type === 'item') {
      const target = action.targetInstanceId ? battle.player.team.find(monster => monster.instanceId === action.targetInstanceId) : battle.player.team[battle.player.activeIndex];
      if (!target || target.hp <= 0 || target.hp >= target.stats.hp || this.game.inventory[action.item] <= 0) return false;
    }
    if (action.type === 'catch') return this.requestCapture(action.ball);
    this.pendingAction = structuredClone(action); this.pendingCapture = false; this.pendingBall = undefined; return true;
  }

  startEncounter(id: string): boolean {
    if (this.game.battle || this.game.captureOffer || this.isSafeTown(this.player.x, this.player.z)) return false;
    const entity = this.entities.find(item => item.kind === 'wild' && item.id === id); if (!entity) return false;
    if (this.modelStatus(id) || !this.modelsReady) return false;
    if (this.isSafeTown(entity.x, entity.z)) return false;
    const healthy = firstUsableRegionalTeamIndex(this.game, this.regionId);
    if (healthy < 0) return false;
    const wild = createMonster(this.game, entity.speciesId, entity.level, this.regionId);
    this.game.dex.seen = [...new Set([...this.game.dex.seen, entity.speciesId])].sort((a, b) => a - b);
    this.game.battle = { kind: 'wild', regionId: this.game.regionId, policyRegion: this.regionId, player: { team: this.game.player.team, activeIndex: healthy }, enemy: { team: [wild], activeIndex: 0 }, turn: 1, canRun: true };
    this.game.logs.push(`오픈월드에서 ${getSpecies(entity.speciesId).name}을(를) 만났다.`); if (this.game.logs.length > 200) this.game.logs.shift();
    this.battleWildId = id; this.battleElapsed = 0; this.pendingCapture = false; this.pendingBall = undefined; this.pendingAction = undefined; this.lastPlayerReward = null; this.lastEnemyReward = null;
    return true;
  }

  step(options: { deltaSeconds?: number; learning?: boolean; epsilon?: number } = {}): OpenWorldStep {
    const deltaSeconds = options.deltaSeconds ?? .25, learning = options.learning ?? false, epsilon = options.epsilon ?? (learning ? .12 : 0);
    if (!finite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 5 || typeof learning !== 'boolean' || !finite(epsilon) || epsilon < 0 || epsilon > 1) throw new Error('Invalid open-world step options');
    this.worldClockSeconds = (this.worldClockSeconds + deltaSeconds) % (20 * 60);
    replenishBalls(this.game, deltaSeconds);
    const events: OpenWorldEvent[] = [];
    const manualControlActive = this.manualControlRemaining > 0; this.manualControlRemaining = Math.max(0, this.manualControlRemaining - deltaSeconds);
    this.syncCompanion();
    for (const id of this.modelStatuses.keys()) if (this.modelSpecies(id) === undefined) this.modelStatuses.delete(id);
    if (!this.modelsReady) return { tick: this.tick, events, battleActive: !!this.game.battle };
    if (this.game.captureOffer) {
      this.tick++; return { tick: this.tick, events, battleActive: false };
    }
    if (!this.game.battle && needsRegionalStarter(this.game, this.regionId)) {
      this.tick++; return { tick: this.tick, events, battleActive: false };
    }
    if (!this.game.battle) {
      this.streamTravelEncounters();
      this.advanceRespawns(deltaSeconds);
      if (this.controlMode === 'auto' && !this.selectionPinned) this.selectedWildId = this.nearestWildToCompanion()?.id;
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
        if (!this.modelsReady || (usesServerBrain() && !this.serverBattleReady())) {
          this.battleElapsed = BATTLE_INTERVAL - 0.001; break;
        }
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
    this.syncCompanion();
    this.visitedTownsByRegion[this.regionId] = [...this.visitedTownIds];
    const rewardOwners = this.rewardOwnerIds();
    const pack = (entity: OpenWorldEntity): OpenWorldEntitySnapshot => { const { brain: _brain, ...rest } = entity; return { ...structuredClone(rest), brain: stripGraph(this.brain(entity.id).state) }; };
    return { schema: 1, model: OPEN_WORLD_MODEL, graphId: this.graph.id, seed: this.seed, rng: this.rng.state, tick: this.tick,
      serverFinalizations: this.serverFinalizations.length ? structuredClone(this.serverFinalizations) : undefined,
      player: structuredClone(this.player), selectedWildId: this.selectedWildId, autoCapture: this.autoCapture, autoHunt: this.autoHunt, battleWildId: this.battleWildId, worldClockSeconds: this.worldClockSeconds,
      battleElapsed: this.battleElapsed, pendingCapture: this.pendingCapture, pendingBall: this.pendingBall, lastPlayerReward: this.lastPlayerReward, lastEnemyReward: this.lastEnemyReward,
      pendingAction: structuredClone(this.pendingAction), manualControlRemaining: this.manualControlRemaining,
      encounterLayout: this.regionId === 'johto' ? GOLD_ENCOUNTER_LAYOUT : isExpansionRegion(this.regionId) ? EXPANSION_ENCOUNTER_LAYOUT : RED_ENCOUNTER_LAYOUT, spawnAnchor: { ...this.spawnAnchor }, controlMode: this.controlMode, regionId: this.regionId, sceneId: this.sceneId, surfaceReturn: this.surfaceReturn ? { ...this.surfaceReturn } : undefined, mapVersion: this.atlas.mapVersion,
      selectionPinned: this.selectionPinned, trackingSelected: this.trackingSelected, visitedTownIds: [...this.visitedTownIds], visitedTownsByRegion: structuredClone(this.visitedTownsByRegion),
      rewardLedgers: structuredClone(Object.fromEntries(Object.entries(this.rewardLedgers).filter(([id]) => rewardOwners.has(id)))),
      spawnSerial: this.spawnSerial, nextFoodId: this.nextFoodId, foods: structuredClone(this.foods), respawnQueue: structuredClone(this.respawnQueue), entities: this.entities.map(pack), companionMemories: [...this.companionMemories.values()].map(pack) };
  }

  spawnCatalog(): Array<{ speciesId: number; biome: WorldBiome }> { return getPlayableSpeciesIds().map(speciesId => ({ speciesId, biome: biomeForSpecies(speciesId) })); }
  rosterStatus(): { alive: number; pending: number; total: number } { const alive = this.wildEntities().length, pending = this.respawnQueue.length; return { alive, pending, total: alive + pending }; }
  nearbyWildCount(radius = 25): number { if (!finite(radius) || radius <= 0 || radius > 100) throw new Error('Nearby radius must be 0..100'); return this.wildEntities().filter(entity => distance(entity, this.player) <= radius).length; }

  private stepMovement(deltaSeconds: number, learning: boolean, epsilon: number, manualControlActive: boolean, events: OpenWorldEvent[]): void {
    const occupied: Array<{ x: number; z: number }> = [];
    for (const entity of this.entities) {
      const target = this.targetFor(entity); entity.target = target;
      const speed = movementSpeed(entity.speciesId, entity.level);
      const before = target ? distance(entity, target) : 0; entity.observation = this.observe(entity, target, occupied, speed * deltaSeconds);
      if (this.modelStatus(entity.id)) {
        entity.action = 4; entity.reward = 0; occupied.push({ x: entity.x, z: entity.z });
        events.push({ type: 'wait', entityId: entity.id, x: entity.x, z: entity.z, reward: 0 }); continue;
      }
      if (entity.kind === 'companion' && (manualControlActive || this.controlMode === 'manual')) {
        entity.action = 4;
        entity.reward = 0; occupied.push({ x: entity.x, z: entity.z }); events.push({ type: 'wait', entityId: entity.id, x: entity.x, z: entity.z, reward: 0 }); continue;
      }
      const brain = this.brain(entity.id), action = brain.act(entity.observation, this.tick ? entity.reward : null, learning, epsilon, 4);
      let reward = -.005, type: 'move' | 'wait' | 'collision' | 'food' = 'wait';
      if (action < 4 && deltaSeconds > 0) {
        const direction = DIRECTIONS[action as 0 | 1 | 2 | 3], stepDistance = speed * deltaSeconds;
        const x = entity.x + direction.x * stepDistance, z = entity.z + direction.z * stepDistance;
        entity.heading = action;
        if (this.pathBlocked(entity, x, z, occupied)) { reward -= .2; entity.collisions++; type = 'collision'; }
        else { if (entity.kind === 'companion') this.recordEvolutionWalk(stepDistance); entity.x = x; entity.z = z; entity.energy = Math.max(0, entity.energy - .035 * stepDistance); type = 'move'; }
      } else entity.energy = Math.min(100, entity.energy + .025);
      if (target) {
        const maxProgress = speed * deltaSeconds;
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
    const captureBall = this.pendingCapture ? this.pendingBall ?? this.bestBall() : undefined;
    let action: BattleAction, learnedPlayerAction = false, source: RewardDecisionSource = 'manual';
    if (battle.awaitingSwitch) {
      const requested = this.pendingAction; this.pendingAction = undefined;
      const index = requested?.type === 'switch' ? requested.index : battle.policyRegion
        ? firstUsableRegionalTeamIndex(this.game, battle.policyRegion)
        : battle.player.team.findIndex(monster => monster.hp > 0);
      action = { type: 'switch', index };
    } else if (this.pendingAction) {
      action = this.pendingAction; this.pendingAction = undefined;
    } else if (this.pendingCapture && captureBall) {
      action = { type: 'catch', ball: captureBall }; this.pendingCapture = false; this.pendingBall = undefined;
    } else {
      const decision = this.chooseBattle(player, enemy, battle, this.lastPlayerReward, learning);
      if (decision.action < 4) { action = { type: 'move', index: decision.action }; learnedPlayerAction = decision.rawAction === decision.action; }
      else if (this.controlMode === 'auto' && !this.serverTurn?.decisions.has(player.instanceId)) action = { type: 'move', index: this.fallbackAttack(player, battle) };
      else { action = { type: 'wait' }; learnedPlayerAction = true; }
      source = learnedPlayerAction ? 'connectome' : 'fallback';
    }
    if (!learnedPlayerAction) this.clearPendingLearning(player);
    const playerHp = player.hp, enemyHp = enemy.hp, playerLevel = player.level, enemyLevel = enemy.level;
    const playerMaxBefore = battle.transformations?.[player.instanceId]?.stats.hp ?? player.stats.hp, enemyMaxBefore = battle.transformations?.[enemy.instanceId]?.stats.hp ?? enemy.stats.hp;
    const playerTypes = battleMonsterTypes(this.game, player);
    const enemyTypes = battleMonsterTypes(this.game, enemy);
    const enemyDecision = this.chooseBattle(enemy, player, battle, this.lastEnemyReward, learning);
    const enemySource: RewardDecisionSource = enemyDecision.rawAction === enemyDecision.action ? 'connectome' : 'fallback';
    const playerMoveId = action.type === 'move' ? (battle.transformations?.[player.instanceId]?.moves ?? player.moves)[action.index]?.moveId : undefined;
    const enemyMoveId = (battle.transformations?.[enemy.instanceId]?.moves ?? enemy.moves)[enemyDecision.action]?.moveId;
    const result = actBattle(this.game, action, enemyDecision.action);
    if (result.battleEnded && result.outcome === 'won') this.autoEvolve(events);
    const playerAttack = result.executedMoves.find(move => move.actorInstanceId === player.instanceId), enemyAttack = result.executedMoves.find(move => move.actorInstanceId === enemy.instanceId);
    const playerMaxHp = Math.max(playerMaxBefore, player.stats.hp), enemyMaxHp = Math.max(enemyMaxBefore, enemy.stats.hp);
    const resolvedPlayerHp = result.outcome === 'lost' ? 0 : player.hp;
    const playerReward = rewardBattleTurn({ individualId: player.instanceId, decisionSource: source, learningEnabled: learning,
      selfHpBefore: playerHp, selfHpAfter: resolvedPlayerHp, selfMaxHp: playerMaxHp, opponentHpBefore: enemyHp, opponentHpAfter: enemy.hp, opponentMaxHp: enemyMaxHp,
      chosenAttackType: playerAttack?.moveType, defenderTypes: enemyTypes, damagingMove: playerAttack?.damagingMove, actionExecuted: playerAttack?.executed, attackHit: playerAttack?.hit, typeEffectiveness: playerAttack?.typeMultiplier,
      moveCategory: playerAttack?.category, hpRecovered: playerAttack?.hpRecovered, statStageDelta: playerAttack?.statStageDelta, ailmentApplied: playerAttack?.ailmentApplied, strategicEffect: playerAttack?.strategicEffect,
      outcome: result.outcome, levelsGained: player.level - playerLevel, evolved: events.some(event => event.type === 'evolved' && event.entityId === player.instanceId) });
    const enemyReward = rewardBattleTurn({ individualId: enemy.instanceId, decisionSource: enemySource, learningEnabled: learning,
      selfHpBefore: enemyHp, selfHpAfter: enemy.hp, selfMaxHp: enemyMaxHp, opponentHpBefore: playerHp, opponentHpAfter: resolvedPlayerHp, opponentMaxHp: playerMaxHp,
      chosenAttackType: enemyAttack?.moveType, defenderTypes: playerTypes, damagingMove: enemyAttack?.damagingMove, actionExecuted: enemyAttack?.executed, attackHit: enemyAttack?.hit, typeEffectiveness: enemyAttack?.typeMultiplier,
      moveCategory: enemyAttack?.category, hpRecovered: enemyAttack?.hpRecovered, statStageDelta: enemyAttack?.statStageDelta, ailmentApplied: enemyAttack?.ailmentApplied, strategicEffect: enemyAttack?.strategicEffect,
      outcome: result.outcome === 'won' ? 'lost' : result.outcome === 'lost' ? 'won' : result.outcome, levelsGained: enemy.level - enemyLevel });
    this.recordReward(playerReward, 'battle', source); this.recordReward(enemyReward, 'battle', enemySource);
    if (playerReward.learningEligible && playerMoveId !== undefined) this.recordMoveLearning(player, playerMoveId, playerAttack, playerReward.total);
    if (enemyReward.learningEligible && enemyMoveId !== undefined) this.recordMoveLearning(enemy, enemyMoveId, enemyAttack, enemyReward.total);
    for (const gain of result.experienceGains.filter(gain => gain.shared && gain.levelsGained > 0)) {
      const member = this.game.player.team.find(monster => monster.instanceId === gain.instanceId)!;
      this.recordReward(rewardBattleTurn({ individualId: member.instanceId, decisionSource: 'fallback', learningEnabled: false,
        selfHpBefore: member.hp, selfHpAfter: member.hp, selfMaxHp: member.stats.hp, opponentHpBefore: 0, opponentHpAfter: 0, opponentMaxHp: 1,
        levelsGained: gain.levelsGained, evolved: events.some(event => event.type === 'evolved' && event.entityId === member.instanceId) }), 'battle', 'fallback');
    }
    this.lastPlayerReward = playerReward.learningEligible ? playerReward.total : null; this.lastEnemyReward = enemyReward.learningEligible ? enemyReward.total : null;
    if (result.battleEnded) {
      if (usesServerBrain()) {
        const episode = this.serverBattleId(battle), turn = battle.turn;
        for (const [self, other, reward, eligible] of [[player, enemy, playerReward.total, playerReward.learningEligible], [enemy, player, enemyReward.total, enemyReward.learningEligible]] as const) {
          const savedSelf = structuredClone(self), savedOther = structuredClone(other);
          delete savedSelf.brain; delete savedOther.brain;
          this.serverFinalizations.push({ self: savedSelf, other: savedOther, turn, reward, learning: eligible, episode });
        }
      } else {
        this.battleController.finish(player, playerReward.total, playerReward.learningEligible);
        this.battleController.finish(enemy, enemyReward.total, enemyReward.learningEligible);
      }
      const removed = this.entities.find(entity => entity.id === entityId);
      if (removed) this.removeWild(entityId);
      if (result.outcome === 'won' && battle.kind === 'wild') {
        this.game.captureOffer = structuredClone(enemy); this.game.captureOffer.hp = 0;
        this.game.captureOffer.status = undefined; this.game.captureOffer.statusTurns = undefined;
        if (this.autoCapture) this.captureVictory();
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
    const remote = this.serverTurn?.battle === battle && this.serverTurn.turn === battle.turn ? this.serverTurn.decisions.get(monster.instanceId) : undefined;
    if (usesServerBrain()) {
      if (!remote) throw new Error('서버 회로의 해당 턴 결정을 기다리고 있습니다.');
      return { ...remote, rawAction: remote.action };
    }
    const self = battleMonsterView(battle, monster), foe = battleMonsterView(battle, other);
    const decision = this.battleController.choose(self, foe, battle.turn, reward, learning, {
      automatic: true, selfStatStages: battle.statStages?.[monster.instanceId], otherStatStages: battle.statStages?.[other.instanceId],
    }); monster.brain = self.brain; return decision;
  }

  private recordMoveLearning(monster: Monster, moveId: number, executed: BattleTurnResult['executedMoves'][number] | undefined, reward: number): void {
    monster.moveLearning ??= {};
    const stats = monster.moveLearning[String(moveId)] ?? { choices: 0, executed: 0, effective: 0, reward: 0 };
    stats.choices = Math.min(1e9, stats.choices + 1);
    if (executed) stats.executed = Math.min(1e9, stats.executed + 1);
    if (executed?.damage || executed?.strategicEffect) stats.effective = Math.min(1e9, stats.effective + 1);
    stats.reward = clamp(stats.reward + reward, -1e9, 1e9);
    monster.moveLearning[String(moveId)] = stats;
  }

  private clearPendingLearning(monster: Monster): void {
    const brain = this.battleController.ensure(monster); brain.state.previous = null; monster.brain = brain.snapshot(); this.lastPlayerReward = null;
  }

  private fallbackAttack(monster: Monster, battle: NonNullable<GameState['battle']>): number {
    const moves = battle.transformations?.[monster.instanceId]?.moves ?? monster.moves;
    const damaging = moves.map((slot, index) => ({ index, move: getMove(slot.moveId) })).filter(candidate => candidate.move.power > 0 || [12, 32, 49, 69, 82, 90, 101, 149, 162].includes(candidate.move.id));
    damaging.sort((a, b) => b.move.power - a.move.power || a.index - b.index);
    return damaging[0]?.index ?? 0;
  }

  private autoEvolve(events: OpenWorldEvent[]): void {
    for (const monster of this.game.player.team) {
      for (;;) {
        const candidate = availableEvolutions(this.game, monster.instanceId).find(option => option.method === 'level' && !evolutionRoute(this.game, monster, option)?.item); if (!candidate) break;
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
    const ownedIds = new Set([...this.game.player.team, ...this.game.player.box].map(monster => `companion:${monster.instanceId}`));
    for (const id of this.companionMemories.keys()) if (!ownedIds.has(id)) { this.companionMemories.delete(id); this.brains.delete(id); }
    const usable = firstUsableRegionalTeamIndex(this.game, this.regionId);
    const lead = this.game.player.team[usable >= 0 ? usable : 0];
    let companion = this.entities.find(entity => entity.kind === 'companion');
    const expectedId = `companion:${lead.instanceId}`;
    if (!companion || companion.id !== expectedId) {
      if (companion) { this.entities.splice(this.entities.indexOf(companion), 1); if (ownedIds.has(companion.id)) this.companionMemories.set(companion.id, companion); else this.brains.delete(companion.id); }
      companion = this.companionMemories.get(expectedId);
      const position = this.companionPosition();
      if (companion) { this.companionMemories.delete(expectedId); companion.x = position.x; companion.z = position.z; }
      else companion = this.makeEntity(expectedId, 'companion', lead.speciesId, lead.level, position);
      this.entities.unshift(companion);
    }
    companion.speciesId = lead.speciesId; companion.level = lead.level;
  }

  private encounterAt(position: { x: number; z: number }): { speciesId: number; level: number } {
    const location = this.locationAt(position.x, position.z);
    const levels = regionalWildLevels(this.game, this.regionId, location);
    const encounterRegion = this.regionId === 'johto' ? 'johto' : 'kanto';
    const biome = this.sampleWorld(position.x, position.z).biome;
    const encounter = isExpansionRegion(this.regionId)
      ? chooseExpansionEncounter(this.regionId, location.id, this.dayPeriod, biome, this.regionalBadges, this.spawnSerial, () => this.rng.next(), { min: levels.minLevel, max: levels.maxLevel })
      : chooseRegionalEncounter(encounterRegion, location.id, this.dayPeriod, biome, this.regionalBadges, this.spawnSerial, () => this.rng.next(), { min: levels.minLevel, max: levels.maxLevel });
    const min = Math.max(1, encounter.origin==='source'?levels.minLevel:encounter.minLevel), max = Math.max(min, encounter.origin==='source'?levels.maxLevel:encounter.maxLevel);
    return { speciesId: encounter.speciesId, level: min + this.rng.int(max - min + 1) };
  }

  private spawnPool(locationId: string, biome?: string): number[] {
    const version = this.game.adventureVersion ?? 'red';
    const caught = this.game.versionCaught?.[version] ?? this.game.dex.caught;
    const encounterRegion = this.regionId === 'johto' ? 'johto' : 'kanto';
    const candidates = isExpansionRegion(this.regionId) ? expansionEncounterSpecies(this.regionId, locationId, this.regionalBadges, this.dayPeriod, biome, this.spawnSerial)
      : biome === undefined ? regionalEncounters(locationId, this.regionalBadges, this.regionId)
      : [...regionalRuntimePools(encounterRegion, locationId, this.dayPeriod, biome).flatMap(pool => pool.slots.map(slot => slot.speciesId)),
        ...(this.spawnSerial % 20 === 0 ? supplementalEncounterRules(encounterRegion).filter(rule => rule.locationId === locationId && rule.biome === biome && rule.requiredBadges <= this.regionalBadges).map(rule => rule.speciesId) : [])];
    return [...new Set(candidates)].filter(speciesId => !UNIQUE_SPECIES.has(speciesId)
      || (!caught.includes(speciesId) && !this.entities.some(entity => entity.kind === 'wild' && entity.speciesId === speciesId) && !this.respawnQueue.some(pending => pending.speciesId === speciesId)));
  }

  changeVersion(version: string): void {
    if (this.game.battle || this.game.captureOffer) throw new Error('배틀과 포획 선택을 마친 뒤 버전을 바꿀 수 있습니다.');
    if (!getVersionSpeciesIds(version).length) throw new Error('도감 자료가 없는 버전입니다.');
    if (!isPlayableAdventureVersion(version)) throw new Error('실제 3D 지역 지도가 확보되지 않은 버전입니다.');
    if (version === this.game.adventureVersion) return;
    // Collection records may change; region, fixed encounters and living individuals do not.
    this.game.adventureVersion = version;
    this.game.versionCaught ??= {}; this.game.versionCaught[version] ??= [];
  }

  changeRegion(regionId: WorldRegionId): void {
    if (!isPlayableWorldRegion(regionId)) throw new Error('실제 3D 지역 지도가 확보되지 않은 지역입니다.');
    const reason = campaignTravelReason(this.game, regionId); if (reason) throw new Error(reason);
    this.changeRegionInternal(regionId, getWorldAtlas(regionId).defaultVersion);
  }

  private changeRegionInternal(regionId: WorldRegionId, version: string): void {
    if (this.game.battle || this.game.captureOffer) throw new Error('배틀과 포획 선택을 마친 뒤 지역을 바꿀 수 있습니다.');
    const next = getWorldAtlas(regionId);
    if (regionId === this.regionId) {
      if (version !== this.game.adventureVersion) this.changeVersion(version);
      return;
    }
    const count = this.rosterStatus().total;
    this.visitedTownsByRegion[this.regionId] = [...this.visitedTownIds];
    this.regionId = regionId;
    this.sceneId = surfaceSceneId(regionId); this.surfaceReturn = undefined;
    this.game.adventureVersion = version;
    this.game.versionCaught ??= {};
    this.game.versionCaught[version] ??= [];
    this.visitedTownIds = [...(this.visitedTownsByRegion[regionId] ?? this.initialVisitedTowns(next))];
    this.visitedTownsByRegion[regionId] = [...this.visitedTownIds];
    this.player = { ...next.start, heading: 0 };
    this.spawnAnchor = { ...this.player };
    const companion = this.entities.find(entity => entity.kind === 'companion');
    if (companion) { Object.assign(companion, this.player); companion.target = undefined; }
    for (const entity of this.wildEntities()) { this.entities.splice(this.entities.indexOf(entity), 1); this.brains.delete(entity.id); }
    this.respawnQueue = []; this.foods = []; this.selectWild(null); this.battleWildId = undefined;
    this.serverTurn = undefined; this.pendingAction = undefined; this.pendingCapture = false; this.pendingBall = undefined;
    this.battleElapsed = 0; this.lastPlayerReward = null; this.lastEnemyReward = null;
    while (this.wildEntities().length < count) this.spawnWild();
    while (this.foods.length < 24) this.spawnFood();
    this.spawnAnchor = { ...this.player }; this.manualControlRemaining = 0; this.recordTownVisit();
  }

  private initialVisitedTowns(atlas: WorldAtlas): string[] {
    const start = atlas.locationAt(atlas.start.x, atlas.start.z);
    return start.kind === 'town' ? [start.id] : [];
  }

  private localSpawnPosition(): { x: number; z: number } {
    // Stream nearby zones: the location under the spawn controls species and level.
    const current = this.locationAt(this.player.x, this.player.z);
    for (let attempt = 0; attempt < 2500; attempt++) {
      const radius = 6 + this.rng.next() * (attempt < 1000 ? 18 : 35), angle = this.rng.next() * Math.PI * 2;
      const x = this.player.x + Math.cos(angle) * radius, z = this.player.z + Math.sin(angle) * radius;
      const location = this.locationAt(x, z);
      const sample = this.sampleWorld(x, z);
      if (!sample.blocked && !this.isSafeTown(x, z) && location.minLevel <= current.maxLevel + 4 && this.spawnPool(location.id, sample.biome).length && !this.entities.some(entity => distance(entity, { x, z }) < 2)) return { x, z };
    }
    for (const location of [...this.atlas.locations].sort((a, b) => distance(a, this.player) - distance(b, this.player))) {
      if (location.kind === 'town' || !this.spawnPool(location.id).length) continue;
      for (let radius = 0; radius <= 18; radius += 2) for (let step = 0; step < 16; step++) {
        const angle = step / 16 * Math.PI * 2, point = { x: location.x + Math.cos(angle) * radius, z: location.z + Math.sin(angle) * radius };
        const sample = this.sampleWorld(point.x, point.z);
        if (this.locationAt(point.x, point.z).id === location.id && !sample.blocked && !this.isSafeTown(point.x, point.z) && this.spawnPool(location.id, sample.biome).length
          && !this.entities.some(entity => distance(entity, point) < 2)) return point;
      }
    }
    throw new Error(`No unlocked ${this.regionId} spawn position`);
  }

  private spawnWild(): OpenWorldEntity {
    return this.spawnWildAt(this.localSpawnPosition());
  }

  private spawnWildAt(position: { x: number; z: number }): OpenWorldEntity {
    if (this.sampleWorld(position.x,position.z).blocked || this.isSafeTown(position.x, position.z)) throw new Error('Wild spawn position is blocked or inside a safe town');
    const { speciesId, level } = this.encounterAt(position);
    const entity = this.makeEntity(`wild-${this.spawnSerial++}`, 'wild', speciesId, level, position); this.entities.push(entity); return entity;
  }

  private removeWild(id: string): void {
    const index = this.entities.findIndex(entity => entity.id === id && entity.kind === 'wild'); if (index < 0) return;
    const [removed] = this.entities.splice(index, 1); this.brains.delete(id);
    this.respawnQueue.push({ id: `respawn:${id}`, speciesId: removed.speciesId, level: removed.level, biome: biomeForSpecies(removed.speciesId), originX: removed.x, originZ: removed.z, remainingSeconds: 4 + this.rng.next() * 2 });
  }

  private advanceRespawns(deltaSeconds: number): void {
    this.relocateTownWilds();
    for (const pending of this.respawnQueue) pending.remainingSeconds = Math.max(0, pending.remainingSeconds - deltaSeconds);
    const ready = this.respawnQueue.filter(pending => pending.remainingSeconds === 0);
    this.respawnQueue = this.respawnQueue.filter(pending => pending.remainingSeconds > 0);
    for (const _pending of ready) this.spawnWild();
  }

  /** Preserve saved identity and brain state while remapping illegal town spawns to a route pool. */
  private relocateTownWilds(): void {
    for (const entity of this.wildEntities()) {
      if (entity.id === this.battleWildId || !this.isSafeTown(entity.x, entity.z)) continue;
      const point = this.localSpawnPosition();
      Object.assign(entity, point, this.encounterAt(point));
      entity.target = undefined;
    }
  }

  private streamTravelEncounters(): void {
    // Movement opens the next area. Standing still never rerolls distant individuals.
    if (distance(this.player, this.spawnAnchor) < SPAWN_TRAVEL_DISTANCE) return;
    this.spawnAnchor = { ...this.player };
    const candidates = this.wildEntities().filter(entity => distance(entity, this.player) > WILD_UNLOAD_DISTANCE && entity.id !== this.selectedWildId && entity.id !== this.battleWildId);
    for (const donor of candidates) {
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
      if (selected && (!this.selectionPinned || this.trackingSelected)) return { kind: 'wild', id: selected.id, x: selected.x, z: selected.z };
      if (this.controlMode === 'auto' && !this.selectionPinned) return this.explorationTarget(entity);
      return { kind: 'player', id: 'player', x: this.player.x, z: this.player.z };
    }
    let nearestFood: WorldFood | undefined, nearestDistance = Infinity;
    for (const food of this.foods) {
      if (this.isSafeTown(food.x, food.z)) continue;
      const candidateDistance = distance(entity, food);
      if (candidateDistance < nearestDistance || candidateDistance === nearestDistance && food.id < nearestFood!.id) {
        nearestFood = food; nearestDistance = candidateDistance;
      }
    }
    return nearestFood ? { kind: 'food', id: String(nearestFood.id), x: nearestFood.x, z: nearestFood.z } : undefined;
  }

  /** Game-designed waypoints feed the existing sensory inputs. The circuit
   * still selects each movement; the target is included in the entity save. */
  private explorationTarget(entity: OpenWorldEntity): WorldTarget {
    const previous = entity.target;
    const created = previous?.kind === 'explore' && /^explore:\d+$/.test(previous.id) ? Number(previous.id.slice(8)) : -1;
    if (previous && created >= 0 && this.tick >= created && this.tick - created < 80
      && finite(previous.x) && finite(previous.z) && distance(entity, previous) > 2 && distance(entity, previous) <= 40
      && !this.pathBlocked(entity, previous.x, previous.z, [])) return previous;
    const start = hash(`${this.seed}:${this.tick}:${entity.id}`) % 16;
    for (const radius of [28, 20, 12, 6]) for (let index = 0; index < 16; index++) {
      const angle = (start + index) * Math.PI / 8;
      const target = { kind: 'explore' as const, id: `explore:${this.tick}`, x: entity.x + Math.cos(angle) * radius, z: entity.z + Math.sin(angle) * radius };
      if (!this.pathBlocked(entity, target.x, target.z, [])) return target;
    }
    return { kind: 'player', id: 'player', x: entity.x, z: entity.z };
  }

  private observe(entity: OpenWorldEntity, target: WorldTarget | undefined, occupied: Array<{ x: number; z: number }>, lookahead: number): number[] {
    const dx = target ? target.x - entity.x : 0, dz = target ? target.z - entity.z : 0;
    const blocked = DIRECTIONS.map(direction => {
      const x = entity.x + direction.x * lookahead, z = entity.z + direction.z * lookahead;
      return this.pathBlocked(entity, x, z, occupied) ? 1 : 0;
    });
    return [1, clamp(dx / 16, -1, 1), clamp(dz / 10, -1, 1), Math.sign(dx), Math.sign(dz), Math.min(Math.abs(dx) / 16, 1), Math.min(Math.abs(dz) / 10, 1), ...blocked, entity.energy / 100];
  }

  private pathBlocked(from: { x: number; z: number; kind?: OpenWorldEntity['kind'] }, x: number, z: number, occupied: Array<{ x: number; z: number }>): boolean {
    if (!getCaveScene(this.sceneId) && !this.atlas.evaluateTraversal(from, { x, z }, this.regionalBadges).allowed) return true;
    const length = Math.hypot(x - from.x, z - from.z), samples = Math.max(1, Math.ceil(length / PATH_SAMPLE_DISTANCE));
    for (let sample = 1; sample <= samples; sample++) {
      const ratio = sample / samples, px = from.x + (x - from.x) * ratio, pz = from.z + (z - from.z) * ratio;
      if (this.sampleWorld(px, pz).blocked || from.kind === 'wild' && this.isSafeTown(px, pz) || occupied.some(point => Math.hypot(point.x - px, point.z - pz) < 1)) return true;
    }
    return false;
  }

  private companionPosition(): { x: number; z: number } {
    for (const offset of [{ x: 0, z: 0 }, { x: -2, z: 2 }, { x: 2, z: 2 }, { x: -2, z: -2 }, { x: 2, z: -2 }]) {
      const position = { x: this.player.x + offset.x, z: this.player.z + offset.z };
      if (!this.sampleWorld(position.x, position.z).blocked) return position;
    }
    return { x: this.player.x, z: this.player.z };
  }

  private spawnFood(): void {
    for (let attempt = 0; attempt < 5000; attempt++) {
      const anchor = this.entities[this.rng.int(this.entities.length)] ?? this.player;
      const radius = 3 + this.rng.next() * 25, angle = this.rng.next() * Math.PI * 2;
      const point = { x: anchor.x + Math.cos(angle) * radius, z: anchor.z + Math.sin(angle) * radius };
      if (!this.sampleWorld(point.x, point.z).blocked && !this.foods.some(food => distance(food, point) < 1.5)) { this.foods.push({ id: this.nextFoodId++, ...point }); return; }
    }
    throw new Error(`No nearby food position inside ${this.regionId} paths`);
  }

  private brain(id: string): Brain { const brain = this.brains.get(id); if (!brain) throw new Error(`Missing open-world brain ${id}`); return brain; }
  private wildEntities(): OpenWorldEntity[] { return this.entities.filter(entity => entity.kind === 'wild'); }
  private nearestWildToCompanion(): OpenWorldEntity | undefined {
    const companion = this.entities.find(entity => entity.kind === 'companion');
    if (!companion) return undefined;
    let nearest: OpenWorldEntity | undefined, nearestDistance = Infinity;
    for (const entity of this.entities) {
      if (entity.kind !== 'wild') continue;
      const candidateDistance = distance(entity, companion);
      if (candidateDistance < nearestDistance || candidateDistance === nearestDistance && entity.id.localeCompare(nearest!.id) < 0) {
        nearest = entity; nearestDistance = candidateDistance;
      }
    }
    return nearest;
  }
  private cheapestBall(): BallItem { return 'poke-ball'; }
  private bestBall(): BallItem { return 'poke-ball'; }
  private validRequestedAction(action: BattleAction): boolean {
    if (!action || typeof action !== 'object') return false;
    if (action.type === 'move') return Number.isInteger(action.index) && action.index >= 0 && action.index < 4;
    if (action.type === 'switch') return Number.isInteger(action.index) && action.index >= 0 && action.index < this.game.player.team.length;
    if (action.type === 'item') return ['potion', 'super-potion'].includes(action.item) && (action.targetInstanceId === undefined || typeof action.targetInstanceId === 'string');
    if (action.type === 'catch') return ['poke-ball', 'great-ball', 'ultra-ball'].includes(action.ball);
    return action.type === 'wait' || action.type === 'run';
  }
  private priority(entity: OpenWorldEntity): number { return entity.id === this.battleWildId ? 0 : entity.id === this.selectedWildId ? 1 : entity.kind === 'companion' ? 2 : 3; }

  private migrateUnavailableRegion(targetRegion: 'kanto' | 'johto' = 'kanto'): void {
    const previousRegion = this.regionId, destination = getWorldAtlas(targetRegion);
    this.visitedTownsByRegion[previousRegion] = [...this.visitedTownIds];
    this.regionId = targetRegion;
    this.sceneId = surfaceSceneId(targetRegion);
    this.surfaceReturn = undefined;
    this.game.adventureVersion = 'national';
    this.game.versionCaught ??= {}; this.game.versionCaught.national ??= [];
    this.visitedTownIds = [...(this.visitedTownsByRegion[targetRegion] ?? this.initialVisitedTowns(destination))];
    this.visitedTownsByRegion[targetRegion] = [...this.visitedTownIds];
    this.player = { ...destination.start, heading: 0 };

    const nearest = (point: { x: number; z: number }) => destination.nearestWalkable(point.x, point.z, this.regionalBadges) ?? destination.start;
    for (const entity of this.entities) {
      const arrival = entity.kind === 'companion' ? destination.start : nearest(entity);
      entity.x = arrival.x; entity.z = arrival.z; entity.target = undefined;
    }
    const usedFood = new Set<string>();
    for (let index = 0; index < this.foods.length; index++) {
      const food = this.foods[index], nearestCandidate = nearest(food);
      let arrival: { x: number; z: number } | undefined = usedFood.has(key(nearestCandidate.x, nearestCandidate.z)) ? undefined : nearestCandidate;
      if (!arrival) for (const location of destination.locations) {
        for (let dx = -8; dx <= 8 && !arrival; dx += .5) for (let dz = -8; dz <= 8 && !arrival; dz += .5) {
          const candidate = { x: location.x + dx, z: location.z + dz };
          if (!destination.sample(candidate.x, candidate.z).blocked && !usedFood.has(key(candidate.x, candidate.z))) arrival = candidate;
        }
        if (arrival) break;
      }
      if (!arrival) throw new Error(`${destination.name} migration could not place saved food safely`);
      food.x = arrival.x; food.z = arrival.z; usedFood.add(key(food.x, food.z));
    }
    for (const pending of this.respawnQueue) {
      const arrival = nearest({ x: pending.originX, z: pending.originZ });
      pending.originX = arrival.x; pending.originZ = arrival.z;
    }
    this.recordTownVisit();
    this.game.logs.push(`${getWorldAtlas(previousRegion).name} 저장을 실제 지도가 있는 관동으로 옮겼습니다. 보유 포켓몬과 개체 기억은 유지했습니다.`);
    this.game.logs = this.game.logs.slice(-200);
  }

  /** Replace obsolete wild-only snapshots without touching owned monsters or an active battle. */
  private migrateUnavailableWildSpecies(resetLayout = false): void {
    const regionalSpecies = new Set(getVersionSpeciesIds(this.atlas.defaultVersion));
    if (!isPlayableWorldRegion(this.regionId)) return;
    let changed = false;
    const replacement = (x: number, z: number, level: number, identity: string) => {
      let location = this.locationAt(x, z);
      let pool = regionalEncounters(location.id, this.regionalBadges, this.regionId);
      if (!pool.length) {
        const nearest = [...this.atlas.locations].sort((a, b) => distance(a, { x, z }) - distance(b, { x, z }))
          .find(item => regionalEncounters(item.id, this.regionalBadges, this.regionId).length > 0 && !this.sampleWorld(item.x, item.z).blocked);
        if (!nearest) throw new Error('No unlocked Red replacement encounters');
        location = nearest; x = nearest.x; z = nearest.z;
        pool = regionalEncounters(location.id, this.regionalBadges, this.regionId);
      }
      return { x, z, speciesId: pool[hash(`playable:${identity}`) % pool.length], level: Math.max(location.minLevel, Math.min(location.maxLevel, level)) };
    };
    for (const entity of this.wildEntities()) {
      if (entity.id === this.battleWildId) continue;
      if (regionalSpecies.has(entity.speciesId) && (!resetLayout || regionalEncounters(this.locationAt(entity.x, entity.z).id, this.regionalBadges, this.regionId).includes(entity.speciesId))) continue;
      Object.assign(entity, replacement(entity.x, entity.z, entity.level, entity.id)); changed = true;
    }
    for (const pending of this.respawnQueue) {
      if (regionalSpecies.has(pending.speciesId) && (!resetLayout || regionalEncounters(this.locationAt(pending.originX, pending.originZ).id, this.regionalBadges, this.regionId).includes(pending.speciesId))) continue;
      const next = replacement(pending.originX, pending.originZ, pending.level, pending.id);
      pending.originX = next.x; pending.originZ = next.z;
      pending.speciesId = next.speciesId; pending.level = next.level; pending.biome = biomeForSpecies(next.speciesId); changed = true;
    }
    if (changed) {
      this.game.logs.push('현재 제공하는 지역 지도에 맞춰 저장된 야생 포켓몬을 다시 배치했습니다. 보유 포켓몬과 도감 기록은 유지했습니다.');
      this.game.logs = this.game.logs.slice(-200);
    }
  }

  private migrateJohtoMap(): void {
    const previous = getLegacyJohtoAtlas();
    // The rebuilt map moved its towns. Reusing old coordinates can turn a New
    // Bark save into an accidental Cianwood visit even when both points are land.
    const remap = (point: { x: number; z: number }) => {
      const oldPlace = previous.locationAt(point.x, point.z);
      const next = this.atlas.locations.find(place => place.id === oldPlace.id);
      const x = next ? next.x + clamp(point.x - oldPlace.x, -4, 4) : this.atlas.start.x;
      const z = next ? next.z + clamp(point.z - oldPlace.z, -4, 4) : this.atlas.start.z;
      point.x = x; point.z = z;
    };
    remap(this.player);
    for (const entity of [...this.entities, ...this.companionMemories.values()]) remap(entity);
    for (const food of this.foods) remap(food);
    for (const pending of this.respawnQueue) { const point = { x: pending.originX, z: pending.originZ }; remap(point); pending.originX = point.x; pending.originZ = point.z; }
    this.migrateKantoBoundaries();
  }

  private migrateExpansionMap(previous: WorldAtlas): void {
    const coordinateScale = previous.mapVersion.endsWith('-v1') ? WORLD_SCALE : 1;
    const remap = (point: { x: number; z: number }) => {
      const oldPlace = previous.locationAt(point.x, point.z);
      const nextId = migrateLegacyExpansionLocationId(this.regionId, oldPlace.id);
      const next = this.atlas.locations.find(place => place.id === nextId);
      point.x = next ? next.x + clamp((point.x - oldPlace.x) * coordinateScale, -4, 4) : this.atlas.start.x;
      point.z = next ? next.z + clamp((point.z - oldPlace.z) * coordinateScale, -4, 4) : this.atlas.start.z;
    };
    remap(this.player);
    for (const entity of [...this.entities, ...this.companionMemories.values()]) remap(entity);
    for (const food of this.foods) remap(food);
    for (const pending of this.respawnQueue) {
      const point = { x: pending.originX, z: pending.originZ }; remap(point);
      pending.originX = point.x; pending.originZ = point.z;
    }
    const migrateVisits = (ids: readonly string[]) => [...new Set(ids.map(id => migrateLegacyExpansionLocationId(this.regionId, id)))]
      .filter(id => this.atlas.locations.some(place => place.id === id && place.kind === 'town'));
    this.visitedTownIds = migrateVisits(this.visitedTownIds);
    this.visitedTownsByRegion[this.regionId] = migrateVisits(this.visitedTownsByRegion[this.regionId] ?? this.visitedTownIds);
    this.migrateKantoBoundaries();
  }

  private migrateKantoBoundaries(): void {
    const relocate = (point: { x: number; z: number }) => {
      const arrival = this.atlas.nearestWalkable(point.x, point.z, this.regionalBadges) ?? this.atlas.start;
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
    for (const gym of getCampaignGyms(this.game, this.regionId).filter(gym => gym.badge <= this.regionalBadges)) if (!this.visitedTownIds.includes(gym.locationId)) this.visitedTownIds.push(gym.locationId);
    this.spawnAnchor = { ...this.player };
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
    checkpoint = structuredClone(checkpoint);
    const legacyKantoMap = this.regionId === 'kanto' && (checkpoint.mapVersion === undefined || checkpoint.mapVersion === 'kanto-v1');
    const legacySurface = !checkpoint.sceneId || checkpoint.sceneId.startsWith('surface:');
    const legacyVersions: Set<string | undefined> = this.regionId === 'kanto' ? new Set([undefined, 'kanto-v1', 'kanto-v2', 'kanto-atlas-v1'])
      : new Set([undefined, 'johto-v1', 'johto-v2', 'johto-atlas-v1']);
    if (legacySurface && checkpoint.mapVersion !== this.atlas.mapVersion && legacyVersions.has(checkpoint.mapVersion)) {
      migrateSurfaceSnapshotCoordinates(checkpoint);
      checkpoint.mapVersion = this.atlas.mapVersion; checkpoint.sceneId = surfaceSceneId(this.regionId);
    }
    this.sceneId = checkpoint.sceneId ?? surfaceSceneId(this.regionId);
    this.surfaceReturn = checkpoint.surfaceReturn ? { ...checkpoint.surfaceReturn } : undefined;
    const cave = getCaveScene(this.sceneId);
    if (!cave && this.sceneId !== surfaceSceneId(this.regionId)) throw new Error('Unknown open-world scene');
    if (cave && cave.regionId !== this.regionId) throw new Error('Scene region mismatch');
    if (this.regionId === 'kanto') {
      if (checkpoint.mapVersion !== undefined && !['kanto-v1', KANTO_MAP_VERSION].includes(checkpoint.mapVersion)) throw new Error('Unknown Kanto map version');
    } else if (checkpoint.mapVersion !== this.atlas.mapVersion) throw new Error(`Unknown ${this.regionId} map version`);
    // v1 saves predate collision geometry. Current snapshots are checked against the
    // atlas selected above so coordinates cannot be relabeled as another region.
    const invalidTerrain = (x: number, z: number) => legacyKantoMap
      ? Math.abs(x) > WORLD_MAX || Math.abs(z) > WORLD_MAX
      : this.sampleWorld(x, z).blocked;
    if (!checkpoint || checkpoint.schema !== 1 || checkpoint.model !== OPEN_WORLD_MODEL || checkpoint.graphId !== this.graph.id || checkpoint.seed !== this.seed || !Number.isInteger(checkpoint.rng) || checkpoint.rng < 0 || checkpoint.rng > 0xffffffff || !Number.isSafeInteger(checkpoint.tick) || checkpoint.tick < 0 || !finite(checkpoint.battleElapsed) || checkpoint.battleElapsed < 0 || checkpoint.battleElapsed >= BATTLE_INTERVAL || typeof checkpoint.autoCapture !== 'boolean' || typeof checkpoint.pendingCapture !== 'boolean' || (checkpoint.pendingBall !== undefined && !['poke-ball', 'great-ball', 'ultra-ball'].includes(checkpoint.pendingBall)) || (checkpoint.pendingAction !== undefined && !this.validRequestedAction(checkpoint.pendingAction)) || ![checkpoint.lastPlayerReward, checkpoint.lastEnemyReward].every(value => value === null || (finite(value) && Math.abs(value) <= 2)) || !Number.isSafeInteger(checkpoint.spawnSerial) || checkpoint.spawnSerial < 1 || !Number.isSafeInteger(checkpoint.nextFoodId) || checkpoint.nextFoodId < 1 || !Array.isArray(checkpoint.foods) || !Array.isArray(checkpoint.entities) || (checkpoint.companionMemories !== undefined && !Array.isArray(checkpoint.companionMemories))) throw new Error('Invalid open-world checkpoint');
    if ((checkpoint.worldClockSeconds !== undefined && (!finite(checkpoint.worldClockSeconds) || checkpoint.worldClockSeconds < 0 || checkpoint.worldClockSeconds >= 20 * 60))) throw new Error('Invalid world clock checkpoint');
    if (checkpoint.surfaceReturn !== undefined && (!checkpoint.surfaceReturn || typeof checkpoint.surfaceReturn.sceneId !== 'string' || ![checkpoint.surfaceReturn.x, checkpoint.surfaceReturn.z].every(finite))) throw new Error('Invalid cave return checkpoint');
    if ((checkpoint.autoHunt !== undefined && typeof checkpoint.autoHunt !== 'boolean') || (checkpoint.respawnQueue !== undefined && !Array.isArray(checkpoint.respawnQueue))) throw new Error('Invalid open-world automation checkpoint');
    if (checkpoint.encounterLayout !== undefined && ![RED_ENCOUNTER_LAYOUT, GOLD_ENCOUNTER_LAYOUT, EXPANSION_ENCOUNTER_LAYOUT].includes(checkpoint.encounterLayout)) throw new Error('Unknown encounter layout');
    if (checkpoint.manualControlRemaining !== undefined && (!finite(checkpoint.manualControlRemaining) || checkpoint.manualControlRemaining < 0 || checkpoint.manualControlRemaining > MANUAL_CONTROL_HOLD)) throw new Error('Invalid manual-control hold');
    if (checkpoint.nextBattleTeamIndex !== undefined && (!Number.isInteger(checkpoint.nextBattleTeamIndex) || checkpoint.nextBattleTeamIndex < 0 || checkpoint.nextBattleTeamIndex > 5)) throw new Error('Invalid automatic battle rotation');
    if (checkpoint.densityRemaining !== undefined && (!finite(checkpoint.densityRemaining) || checkpoint.densityRemaining < 0 || checkpoint.densityRemaining > 3)) throw new Error('Invalid density timer');
    if (checkpoint.spawnAnchor !== undefined && (!checkpoint.spawnAnchor || ![checkpoint.spawnAnchor.x, checkpoint.spawnAnchor.z].every(value => finite(value) && value >= WORLD_MIN && value <= WORLD_MAX))) throw new Error('Invalid encounter streaming anchor');
    if (![checkpoint.player?.x, checkpoint.player?.z, checkpoint.player?.heading].every(finite) || !Number.isInteger(checkpoint.player.heading) || checkpoint.player.heading < 0 || checkpoint.player.heading > 4 || invalidTerrain(checkpoint.player.x, checkpoint.player.z)) throw new Error('Invalid open-world player');
    const memories = checkpoint.companionMemories ?? [], respawns = checkpoint.respawnQueue ?? [], savedEntities = [...checkpoint.entities, ...memories];
    const wildCount = checkpoint.entities.filter(entity => entity.kind === 'wild').length;
    if (wildCount + respawns.length > 18 || checkpoint.entities.filter(entity => entity.kind === 'companion').length !== 1 || memories.some(entity => entity.kind !== 'companion') || new Set(savedEntities.map(entity => entity.id)).size !== savedEntities.length) throw new Error('Invalid open-world roster');
    if (new Set(respawns.map(respawn => respawn.id)).size !== respawns.length || respawns.some(respawn => !respawn || typeof respawn.id !== 'string' || !respawn.id || !Number.isInteger(respawn.speciesId) || respawn.speciesId < 1 || !POKEMON.some(species => species.id === respawn.speciesId) || !Number.isInteger(respawn.level) || respawn.level < 1 || respawn.level > 100 || respawn.biome !== biomeForSpecies(respawn.speciesId) || !finite(respawn.originX) || !finite(respawn.originZ) || invalidTerrain(respawn.originX, respawn.originZ) || !finite(respawn.remainingSeconds) || respawn.remainingSeconds <= 0 || respawn.remainingSeconds > 6)) throw new Error('Invalid open-world respawn queue');
    const ownedIds = new Set([...this.game.player.team, ...this.game.player.box].map(monster => `companion:${monster.instanceId}`));
    if (savedEntities.filter(entity => entity.kind === 'companion').some(entity => !ownedIds.has(entity.id))) throw new Error('Open-world companion memory is not owned');
    for (const food of checkpoint.foods) if (!Number.isSafeInteger(food.id) || food.id < 1 || food.id >= checkpoint.nextFoodId || !finite(food.x) || !finite(food.z) || invalidTerrain(food.x, food.z)) throw new Error('Invalid open-world food');
    if (new Set(checkpoint.foods.map(food => food.id)).size !== checkpoint.foods.length || new Set(checkpoint.foods.map(food => key(food.x, food.z))).size !== checkpoint.foods.length) throw new Error('Duplicate open-world food');
    for (const saved of savedEntities) {
      const inactiveMemory = memories.includes(saved);
      const invalidPosition = !finite(saved?.x) || !finite(saved?.z) || Math.abs(saved.x) > WORLD_MAX || Math.abs(saved.z) > WORLD_MAX
        || (!inactiveMemory && invalidTerrain(saved.x, saved.z));
      if (!saved || typeof saved.id !== 'string' || !saved.id || !['wild', 'companion'].includes(saved.kind) || !Number.isInteger(saved.speciesId) || saved.speciesId < 1 || !POKEMON.some(species => species.id === saved.speciesId) || !Number.isInteger(saved.level) || saved.level < 1 || saved.level > 100 || invalidPosition || !Number.isInteger(saved.heading) || saved.heading < 0 || saved.heading > 4 || !Number.isInteger(saved.action) || saved.action < 0 || saved.action > 4 || !finite(saved.energy) || saved.energy < 0 || saved.energy > 100 || !finite(saved.reward) || Math.abs(saved.reward) > 10 || !Number.isSafeInteger(saved.foods) || saved.foods < 0 || !Number.isSafeInteger(saved.collisions) || saved.collisions < 0 || !Array.isArray(saved.observation) || saved.observation.length !== 12 || !saved.observation.every(finite) || saved.brain?.graphId !== this.graph.id || saved.brain.sensoryBypass !== false) throw new Error('Invalid open-world entity');
      const { graphId: _graphId, ...state } = structuredClone(saved.brain), brain = Brain.restore({ ...state, graph: this.graph }); brain.state.graph = this.graph; this.brains.set(saved.id, brain);
      const { brain: _savedBrain, ...rest } = structuredClone(saved), entity = { ...rest, brain: brain.state };
      if (memories.includes(saved)) this.companionMemories.set(entity.id, entity); else this.entities.push(entity);
    }
    if (checkpoint.selectedWildId !== undefined && !this.entities.some(entity => entity.kind === 'wild' && entity.id === checkpoint.selectedWildId)) throw new Error('Invalid selected wild Pokemon');
    if ((checkpoint.battleWildId !== undefined) !== !!this.game.battle || (checkpoint.battleWildId && this.game.battle?.kind === 'wild' && !this.entities.some(entity => entity.kind === 'wild' && entity.id === checkpoint.battleWildId))) throw new Error('Open-world battle does not match game');
    if (checkpoint.controlMode !== undefined && !['auto', 'manual'].includes(checkpoint.controlMode)) throw new Error('Invalid control mode checkpoint');
    if ((checkpoint.selectionPinned !== undefined && typeof checkpoint.selectionPinned !== 'boolean') || (checkpoint.trackingSelected !== undefined && typeof checkpoint.trackingSelected !== 'boolean')) throw new Error('Invalid target selection');
    const validTownList = (atlas: WorldAtlas, ids: unknown): ids is string[] => Array.isArray(ids)
      && ids.length <= atlas.locations.length
      && ids.every(id => typeof id === 'string')
      && new Set(ids).size === ids.length
      && ids.every(id => atlas.locations.some(place => place.id === id && place.kind === 'town'));
    if (checkpoint.visitedTownIds !== undefined && !validTownList(this.atlas, checkpoint.visitedTownIds)) throw new Error('Invalid visited towns');
    const visitedByRegion: Record<string, string[]> = {};
    if (checkpoint.visitedTownsByRegion !== undefined) {
      if (!checkpoint.visitedTownsByRegion || typeof checkpoint.visitedTownsByRegion !== 'object' || Array.isArray(checkpoint.visitedTownsByRegion)
        || Object.keys(checkpoint.visitedTownsByRegion).length > 10) throw new Error('Invalid regional visited towns');
      for (const [regionId, ids] of Object.entries(checkpoint.visitedTownsByRegion)) {
        let atlas: WorldAtlas; try { atlas = getWorldAtlas(regionId); } catch { throw new Error('Invalid regional visited towns'); }
        if (!Array.isArray(ids) || ids.length > atlas.locations.length || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length)
          throw new Error('Invalid regional visited towns');
        const normalized = [...new Set(ids.map(id => migrateLegacyExpansionLocationId(regionId, id)))];
        if (!validTownList(atlas, normalized)) throw new Error('Invalid regional visited towns');
        visitedByRegion[regionId] = normalized;
      }
    }
    const currentVisited = visitedByRegion[this.regionId] ?? checkpoint.visitedTownIds ?? this.initialVisitedTowns(this.atlas);
    this.visitedTownIds = [...currentVisited];
    visitedByRegion[this.regionId] = [...currentVisited];
    this.visitedTownsByRegion = visitedByRegion;
    this.selectionPinned = checkpoint.selectionPinned ?? false; this.trackingSelected = checkpoint.trackingSelected ?? Boolean(checkpoint.selectedWildId);
    if (checkpoint.rewardLedgers !== undefined) {
      if (!checkpoint.rewardLedgers || typeof checkpoint.rewardLedgers !== 'object' || Array.isArray(checkpoint.rewardLedgers)) throw new Error('Invalid reward ledgers');
      const owners = this.rewardOwnerIds();
      for (const [id, ledger] of Object.entries(checkpoint.rewardLedgers)) { validateRewardLedger(ledger); if (ledger.individualId !== id || !owners.has(id)) throw new Error('Reward ledger owner mismatch'); }
      this.rewardLedgers = structuredClone(checkpoint.rewardLedgers);
    }
    this.controlMode = checkpoint.controlMode ?? 'auto';
    this.rng = new Random(checkpoint.rng); this.tick = checkpoint.tick; this.player = structuredClone(checkpoint.player); this.foods = structuredClone(checkpoint.foods);
    if (checkpoint.serverFinalizations !== undefined) {
      if (!Array.isArray(checkpoint.serverFinalizations) || checkpoint.serverFinalizations.length > 12 || checkpoint.serverFinalizations.some(task =>
        !task || !task.self?.instanceId || !task.other?.instanceId || !Number.isSafeInteger(task.turn) || typeof task.learning !== 'boolean' || !Number.isFinite(task.reward) || Math.abs(task.reward) > 4 || typeof task.episode !== 'string')) throw new Error('서버 보상 대기 기록이 손상되었습니다.');
      this.serverFinalizations = structuredClone(checkpoint.serverFinalizations);
    }
    this.selectedWildId = checkpoint.selectedWildId; this.autoCapture = checkpoint.autoCapture; this.worldClockSeconds = checkpoint.worldClockSeconds ?? 0; this.battleWildId = checkpoint.battleWildId; this.battleElapsed = checkpoint.battleElapsed;
    this.pendingCapture = checkpoint.pendingCapture; this.pendingBall = checkpoint.pendingBall === undefined ? undefined : 'poke-ball'; this.lastPlayerReward = checkpoint.lastPlayerReward; this.lastEnemyReward = checkpoint.lastEnemyReward;
    this.pendingAction = structuredClone(checkpoint.pendingAction);
    if (this.pendingAction?.type === 'catch') this.pendingAction.ball = 'poke-ball';
    this.spawnSerial = checkpoint.spawnSerial; this.nextFoodId = checkpoint.nextFoodId; this.respawnQueue = structuredClone(respawns); this.manualControlRemaining = checkpoint.manualControlRemaining ?? 0; this.spawnAnchor = { ...(checkpoint.spawnAnchor ?? checkpoint.player) };
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

/** All playable collection versions share the project's authored Red map encounters. */
export function redEncounters(locationId: string, badges: number, regionId: WorldRegionId = 'kanto'): number[] {
  if (regionId !== 'kanto') return [];
  return getWorldAtlas('kanto').encounters(locationId, badges);
}

/** Region geography determines encounters; collection version never reshuffles them. */
export function regionalEncounters(locationId: string, _badges: number, regionId: WorldRegionId = 'kanto', period?: EncounterPeriod, biome?: string): number[] {
  if (isExpansionRegion(regionId)) return expansionEncounterSpecies(regionId, locationId, _badges, period, biome);
  if (regionId !== 'kanto' && regionId !== 'johto') return [];
  const source = (biome === undefined
    ? [...regionalRuntimePools(regionId, locationId, period ?? 'day', 'meadow'), ...regionalRuntimePools(regionId, locationId, period ?? 'day', 'lake')]
    : regionalRuntimePools(regionId, locationId, period ?? 'day', biome)).flatMap(pool => pool.slots.map(slot => slot.speciesId));
  const supplemental=supplementalEncounterRules(regionId).filter(rule=>rule.locationId===locationId&&rule.requiredBadges<=_badges&&(!biome||rule.biome===biome)).map(rule=>rule.speciesId);
  return [...new Set([...source, ...supplemental])].sort((a, b) => a - b);
}

/** Compatibility entry point: selecting a collection version never broadens the layout. */
export function versionEncounters(locationId: string, version: string, badges: number, regionId: WorldRegionId = 'kanto'): number[] {
  if (!getPlayableSpeciesIds(version).length) return [];
  return regionalEncounters(locationId, badges, regionId);
}
