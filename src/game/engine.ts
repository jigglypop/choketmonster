import { Brain, type BrainState } from '../core/brain';
import { getMove, getSpecies, POKEMON } from '../data/pokemon';
import { getExperienceForLevel, EXPERIENCE_BY_GROWTH_RATE } from '../data/pokemon-experience';
import { getVersionSpeciesIds } from '../data/pokemon-versions';
import type { BaseStats, Evolution, PokemonMove, PokemonSpecies, PokemonType } from './contracts';
import { calculateDamage, catchProbability, turnOrder, typeMultiplier } from './battle';
import { getMoveLayout, reconcileMoveOrder } from './move-layout';
import { getRegion, REGIONS } from './regions';
import { CAMPAIGN_REGIONS, CAMPAIGN_TRAINERS, campaignProgress, campaignTravelReason, canChallengeRed, getRegionalBadges, getNextCampaignTrainer, getCampaignGyms, recordCampaignGymVictory, recordCampaignLeagueVictory, validateExpansionCampaign, type CampaignRegion, type CampaignProgress } from './campaign';
import { duplicateMergeValue } from './growth';
import { EXTRA_EVOLUTION_ITEM_IDS, EXTRA_EVOLUTION_PRICES, EXTRA_EVOLUTION_LABELS, emptyExtraEvolutionInventory, ITEM_EVOLUTION_RULES, type ExtraEvolutionItem } from './evolution-items';
import { initialEvolutionProgress, evolutionProgress, validateEvolutionProgress, validateEvolutionContext, type EvolutionProgress, type EvolutionContext } from './evolution-progress';
import { feedEvolutionTreat, naturalEvolution, needsSpecialEvolution, sourceEvolutionItems, sourceEvolutionRules, specialEvolutionLevel } from './evolution-conditions';
import { getFieldTrainer, type FieldTrainer } from '../data/field-trainers';
import { genderFor, isValidGender, validateEgg, type Egg, type MonsterGender } from './breeding';
import { abilityForSpecies, abilityImmunity, canonicalAbility, createIndividualTraits, hasSturdy, isValidIndividualValues,
  legacyIndividualTraits, statsWithIndividualValues, type IndividualValues, type MonsterAbility } from './individual-traits';
import { REGIONAL_STARTERS, claimedRegionalStarters, isCampaignRegion, monsterRegionalUseReason, needsRegionalStarter, regionalLevelCap } from './regional-policy';
export { duplicateMergeValue } from './growth';
export { abilityForSpecies, createIndividualTraits, speciesAbilities, type IndividualValues, type MonsterAbility } from './individual-traits';

export const SAVE_SCHEMA_VERSION = 2 as const;
export type BallItem = 'poke-ball' | 'great-ball' | 'ultra-ball';
export type InventoryItem = BallItem | 'potion' | 'super-potion' | 'rare-candy' | 'fire-stone' | 'water-stone' | 'thunder-stone' | 'leaf-stone' | 'moon-stone' | 'link-cable' | ExtraEvolutionItem;
export type BattleKind = 'wild' | 'gym' | 'trainer' | 'champion' | 'elite' | 'red';

export type MonsterStats = BaseStats;
export type MonsterMove = { moveId: number; pp: number };
export type MoveLearningStat = { choices: number; executed: number; effective: number; reward: number };
export type Monster = {
  instanceId: string;
  speciesId: number;
  nickname: string;
  /** Region where this individual was obtained. It survives evolution, trade and merging. */
  originRegion?: CampaignRegion;
  gender?: MonsterGender;
  level: number;
  xp: number;
  hp: number;
  stats: MonsterStats;
  /** Six persistent 0..31 values belonging to this individual. Absent only in legacy input before validation. */
  ivs?: IndividualValues;
  /** Source ability slot and current species ability. Absent only in legacy input before validation. */
  ability?: MonsterAbility;
  moves: MonsterMove[];
  /** Presentation order by move ID. Engine and neural slots remain in `moves`. */
  moveOrder?: number[];
  /** Legacy save data; move uses are unlimited, including unequipped moves. */
  movePpReserve?: Record<string, number>;
  status?: string;
  statusTurns?: number;
  brain?: BrainState;
  /** Persisted game-learning telemetry, keyed by move ID; it does not contain graph data. */
  moveLearning?: Record<string, MoveLearningStat>;
  evolutionProgress?: EvolutionProgress;
};

export type BattleSide = { team: Monster[]; activeIndex: number };
export type BattleStat = 'attack' | 'defense' | 'specialAttack' | 'specialDefense' | 'speed' | 'accuracy' | 'evasion';
export type BattleStatStages = Partial<Record<BattleStat, number>>;
export type BattleTransformation = { speciesId: number; stats: MonsterStats; moves: MonsterMove[] };
export type BattleState = {
  kind: BattleKind;
  regionId: string;
  player: BattleSide;
  enemy: BattleSide;
  turn: number;
  canRun: boolean;
  /** Region policy applied when this battle began. Absent only in legacy active battles. */
  policyRegion?: CampaignRegion;
  awaitingSwitch?: 'player';
  gymBadge?: number;
  campaignRegion?: CampaignRegion;
  trainerId?: string;
  statStages?: Record<string, BattleStatStages>;
  transformations?: Record<string, BattleTransformation>;
};

export type BattleAction =
  | { type: 'move'; index: number }
  | { type: 'wait' }
  | { type: 'switch'; index: number }
  | { type: 'item'; item: 'potion' | 'super-potion'; targetInstanceId?: string }
  | { type: 'catch'; ball: BallItem }
  | { type: 'run' };

export type BattleLogEntry = { turn: number; text: string; kind: 'info' | 'damage' | 'status' | 'capture' | 'reward' };
export type ExecutedMove = {
  actorInstanceId: string;
  targetInstanceId: string;
  moveId: number;
  moveType: PokemonType;
  damageClass: PokemonMove['damageClass'];
  damagingMove: boolean;
  executed: true;
  hit: boolean;
  typeMultiplier: number;
  damage: number;
  category: 'damage' | 'healing' | 'buff' | 'status' | 'mixed';
  hpRecovered: number;
  statStageDelta: number;
  ailmentApplied: boolean;
  strategicEffect: boolean;
  result: 'hit' | 'missed' | 'immune' | 'failed' | 'status' | 'struggle';
};
export type ExperienceGain = { instanceId: string; amount: number; levelsGained: number; shared: boolean };
export type GymVictory = { badge: number; money: number; region?: CampaignRegion };
export type BattleTurnResult = {
  battleEnded: boolean;
  outcome?: 'won' | 'lost' | 'caught' | 'escaped';
  gymVictory?: GymVictory;
  playerAction: BattleAction;
  enemyAction?: { type: 'move'; index: number } | { type: 'wait' };
  events: BattleLogEntry[];
  /** Moves that passed pre-action status/faint gates and were actually resolved. */
  executedMoves: ExecutedMove[];
  /** Per-individual XP actually applied for opponents defeated during this turn. */
  experienceGains: ExperienceGain[];
  decisionSource: 'external-brain' | 'seeded-random';
};

export type GameState = {
  schemaVersion: typeof SAVE_SCHEMA_VERSION;
  seed: string;
  rngState: number;
  nextInstanceId: number;
  player: { money: number; badges: number; team: Monster[]; box: Monster[] };
  nursery?: Egg[];
  inventory: Record<InventoryItem, number>;
  dex: { seen: number[]; caught: number[] };
  regionId: string;
  defeatedGyms: number[];
  defeatedFieldTrainers?: string[];
  championDefeated: boolean;
  campaign?: CampaignProgress;
  /** Regions whose one-time starter choice has already been claimed. */
  claimedRegionalStarters?: CampaignRegion[];
  /** Undefined in legacy schema-v2 saves is migrated to enabled by validateGame. */
  experienceShare?: boolean;
  adventureVersion?: string;
  versionCaught?: Record<string, number[]>;
  /** Active-play seconds toward one free ball; this is an engineered game rule. */
  ballRefillSeconds?: number;
  evolutionContext?: EvolutionContext;
  battle?: BattleState;
  /** Open-world victory reward, held until the player catches or releases it. */
  captureOffer?: Monster;
  logs: string[];
};

export type ExploreResult = { kind: 'encounter' | 'item' | 'money'; speciesId?: number; item?: InventoryItem; amount: number; text: string };

export const ITEM_PRICES: Readonly<Record<InventoryItem, number>> = {
  'poke-ball': 20, 'great-ball': 60, 'ultra-ball': 120,
  potion: 300, 'super-potion': 700, 'rare-candy': 2400,
  'fire-stone': 3000, 'water-stone': 3000, 'thunder-stone': 3000,
  'leaf-stone': 3000, 'moon-stone': 3000, 'link-cable': 4000,
  ...EXTRA_EVOLUTION_PRICES,
};
export const ITEM_LABELS: Readonly<Record<InventoryItem, string>> = {
  'poke-ball': '몬스터볼', 'great-ball': '슈퍼볼', 'ultra-ball': '하이퍼볼',
  potion: '상처약', 'super-potion': '좋은상처약', 'rare-candy': '이상한사탕',
  'fire-stone': '불꽃의돌', 'water-stone': '물의돌', 'thunder-stone': '천둥의돌',
  'leaf-stone': '리프의돌', 'moon-stone': '달의돌', 'link-cable': '연결의끈',
  ...EXTRA_EVOLUTION_LABELS,
};
const INVENTORY_ITEMS = Object.keys(ITEM_PRICES) as InventoryItem[];
export const SHOP_ITEMS: readonly InventoryItem[] = INVENTORY_ITEMS.filter(item => item !== 'great-ball' && item !== 'ultra-ball' && item !== 'friendship-treat');

/** Legacy ball counts are conserved, and subsequent saves keep legacy keys at zero. */
export function normalizeBalls(state: GameState): void {
  const balls = ['poke-ball', 'great-ball', 'ultra-ball'] as const;
  if (balls.some(ball => !Number.isSafeInteger(state.inventory[ball]) || state.inventory[ball] < 0)) throw new Error('볼 수량이 올바르지 않습니다.');
  const total = balls.reduce((sum, ball) => sum + state.inventory[ball], 0);
  if (total > 1_000_000_000) throw new Error('볼 수량이 너무 많습니다.');
  state.inventory['poke-ball'] = total; state.inventory['great-ball'] = 0; state.inventory['ultra-ball'] = 0;
}

function hashSeed(seed: number | string): number {
  let hash = 2166136261;
  for (const character of String(seed)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 0x6d2b79f5;
}

function random(state: GameState): number {
  let value = state.rngState >>> 0;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  state.rngState = value >>> 0;
  return state.rngState / 0x100000000;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function addLog(state: GameState, text: string): void {
  state.logs.push(text);
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
}

export function statsFor(species: PokemonSpecies, level: number, ivs?: IndividualValues): MonsterStats {
  return statsWithIndividualValues(species, level, ivs);
}

export function individualValues(monster: Pick<Monster, 'ivs'>): IndividualValues {
  return monster.ivs ?? { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 };
}

export function monsterAbility(monster: Pick<Monster, 'instanceId' | 'speciesId' | 'ability'>): MonsterAbility {
  return monster.ability ?? legacyIndividualTraits(monster.instanceId, monster.speciesId).ability;
}

export function experienceAtLevel(level: number, growthRate: string): number {
  const n = Math.max(1, Math.min(100, Math.floor(level)));
  const rate = growthRate.toLowerCase();
  return getExperienceForLevel(Object.hasOwn(EXPERIENCE_BY_GROWTH_RATE, rate) ? rate : 'medium', n);
}

const ENGINE_DAMAGE_MOVE_IDS = new Set([12, 32, 49, 69, 82, 90, 101, 149, 162]);
const PRE_EVOLUTIONS = new Map<number, number[]>();
for (const species of POKEMON) for (const evolution of species.evolutions) {
  const parents = PRE_EVOLUTIONS.get(evolution.target);
  if (parents) parents.push(species.id);
  else PRE_EVOLUTIONS.set(evolution.target, [species.id]);
}

function canDealEngineDamage(moveId: number): boolean {
  const move = getMove(moveId);
  return move.damageClass !== 'status' && (move.power > 0 || ENGINE_DAMAGE_MOVE_IDS.has(moveId));
}

/** Latest-first legal recovery choices for a monster whose current set cannot deal damage. */
export function recoverableAttackMoveIds(monster: Monster): number[] {
  if (monster.moves.some((slot) => canDealEngineDamage(slot.moveId))) return [];
  const learned = getSpecies(monster.speciesId).moves
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.level <= monster.level && canDealEngineDamage(entry.moveId))
    .sort((a, b) => b.level - a.level || b.index - a.index);
  const seen = new Set<number>();
  return learned.map((entry) => entry.moveId).filter((moveId) => {
    if (seen.has(moveId)) return false;
    seen.add(moveId);
    return true;
  });
}

/** Every distinct level-up move available to this species or an earlier form. */
export function availableMonsterMoveIds(monster: Pick<Monster, 'speciesId' | 'level'>): number[] {
  const forms = [monster.speciesId], visited = new Set<number>(), entries: Array<{ moveId: number; level: number; order: number }> = [];
  let order = 0;
  while (forms.length) {
    const form = forms.shift()!;
    if (visited.has(form)) continue;
    visited.add(form);
    const species = getSpecies(form);
    for (const learned of species.moves) if (learned.level <= monster.level) entries.push({ ...learned, order: order++ });
    forms.push(...(PRE_EVOLUTIONS.get(form) ?? []));
  }
  entries.sort((a, b) => a.level - b.level || a.order - b.order);
  return [...new Set(entries.map((entry) => entry.moveId))];
}

function takeStoredMovePp(monster: Monster, moveId: number): number {
  const stored = monster.movePpReserve?.[String(moveId)];
  if (monster.movePpReserve) {
    delete monster.movePpReserve[String(moveId)];
    if (!Object.keys(monster.movePpReserve).length) delete monster.movePpReserve;
  }
  return stored ?? getMove(moveId).pp;
}

function storeMovePp(monster: Monster, slot: MonsterMove): void {
  monster.movePpReserve ??= {};
  monster.movePpReserve[String(slot.moveId)] = slot.pp;
}

function knownMoves(species: PokemonSpecies, level: number): MonsterMove[] {
  const seen = new Set<number>();
  const learned = species.moves
    .filter((entry) => entry.level <= level)
    .sort((a, b) => a.level - b.level)
    .filter((entry) => !seen.has(entry.moveId) && Boolean(seen.add(entry.moveId)));
  const selected = learned.slice(-4);
  if (selected.length && !selected.some((entry) => canDealEngineDamage(entry.moveId))) {
    const damaging = learned.findLast((entry) => canDealEngineDamage(entry.moveId));
    if (damaging) selected.splice(0, 1, damaging);
  }
  return selected.map(({ moveId }) => ({ moveId, pp: getMove(moveId).pp }));
}

function learnMove(monster: Monster, moveId: number): void {
  if (monster.moves.some((slot) => slot.moveId === moveId)) return;
  if (monster.moves.length === 4) {
    let replacement = 0;
    if (!canDealEngineDamage(moveId)) {
      const damaging = monster.moves.filter((slot) => canDealEngineDamage(slot.moveId));
      if (damaging.length === 1) {
        const statusIndex = monster.moves.findIndex((slot) => !canDealEngineDamage(slot.moveId));
        if (statusIndex >= 0) replacement = statusIndex;
      }
    }
    const [removed] = monster.moves.splice(replacement, 1);
    if (removed) storeMovePp(monster, removed);
  }
  monster.moves.push({ moveId, pp: takeStoredMovePp(monster, moveId) });
  reconcileMoveOrder(monster);
}

export function createMonster(state: Pick<GameState, 'nextInstanceId'> & Partial<Pick<GameState, 'seed' | 'campaign'>>, speciesId: number, level: number, originRegion?: CampaignRegion): Monster {
  const species = getSpecies(speciesId);
  const normalizedLevel = Math.max(1, Math.min(100, Math.floor(level)));
  const instanceId = `mon-${state.nextInstanceId++}`;
  const traits = createIndividualTraits(state.seed ?? 'unseeded', instanceId, speciesId);
  const stats = statsFor(species, normalizedLevel, traits.ivs);
  const monster: Monster = {
    instanceId,
    speciesId,
    nickname: species.name,
    originRegion: originRegion ?? state.campaign?.startRegion ?? 'kanto',
    gender: genderFor(speciesId, instanceId),
    level: normalizedLevel,
    xp: experienceAtLevel(normalizedLevel, species.growthRate),
    hp: stats.hp,
    stats,
    ...traits,
    moves: knownMoves(species, normalizedLevel),
  };
  monster.evolutionProgress = initialEvolutionProgress(monster);
  monster.evolutionProgress.gender = monster.gender!;
  return monster;
}

export function createGame(starterId: 1 | 4 | 7 | 152 | 155 | 158, seed: number | string): GameState {
  if (![1, 4, 7, 152, 155, 158].includes(starterId)) throw new Error('관동 또는 성도 스타터를 선택하세요.');
  if (!POKEMON.length) throw new Error('포켓몬 데이터를 불러오지 못했습니다.');
  const state: GameState = {
    schemaVersion: SAVE_SCHEMA_VERSION,
    seed: String(seed), rngState: hashSeed(seed), nextInstanceId: 1,
    player: { money: 3000, badges: 0, team: [], box: [] }, nursery: [],
    inventory: {
      'poke-ball': 8, 'great-ball': 0, 'ultra-ball': 0, potion: 3, 'super-potion': 0,
      'rare-candy': 0, 'fire-stone': 0, 'water-stone': 0, 'thunder-stone': 0,
      'leaf-stone': 0, 'moon-stone': 0, 'link-cable': 0,
      ...emptyExtraEvolutionInventory(),
    },
    dex: { seen: [starterId], caught: [starterId] }, regionId: REGIONS[0].id,
    defeatedGyms: [], defeatedFieldTrainers: [], championDefeated: false, experienceShare: true, adventureVersion: 'red', versionCaught: { red: [starterId] }, ballRefillSeconds: 0, logs: [],
  };
  const startRegion = starterId >= 152 ? 'johto' : 'kanto';
  state.campaign = { startRegion, johtoBadges: [], johtoLeague: 0, kantoLeague: 0, redDefeated: false };
  state.claimedRegionalStarters = [startRegion];
  if (startRegion === 'johto') { state.adventureVersion = 'gold'; state.versionCaught = { gold: [starterId] }; }
  state.player.team.push(createMonster(state, starterId, 5));
  addLog(state, `${getSpecies(starterId).name}와 모험을 시작했다.`);
  return state;
}

function minimumWildLevel(speciesId: number): number {
  let minimum = 2;
  for (const species of POKEMON) {
    for (const evolution of species.evolutions) {
      if (evolution.target === speciesId) minimum = Math.max(minimum, evolution.method === 'level' ? evolution.level ?? 16 : 25);
    }
  }
  return minimum;
}

function encounterLevel(state: GameState, minBadges: number, speciesId: number): number {
  const lead = state.player.team.find((monster) => monster.hp > 0)?.level ?? 5;
  const variance = Math.floor(random(state) * 7) - 3;
  return Math.max(minimumWildLevel(speciesId), Math.min(85, Math.max(3 + minBadges * 7, lead + variance)));
}

export function explore(state: GameState, regionId: string): ExploreResult {
  assertPlayable(state);
  if (state.battle) throw new Error('전투 중에는 탐험할 수 없습니다.');
  const region = getRegion(regionId);
  if (state.player.badges < region.minBadges) throw new Error(`배지 ${region.minBadges}개가 필요합니다.`);
  state.regionId = regionId;
  const roll = random(state);
  if (roll < .72) {
    const leadLevel = state.player.team.find((monster) => monster.hp > 0)?.level ?? 5;
    const fair = region.encounterIds.filter((id) => minimumWildLevel(id) <= leadLevel + 5);
    const candidates = fair.length ? fair : region.encounterIds.filter((id) => minimumWildLevel(id) <= 10);
    const pool = candidates.length ? candidates : region.encounterIds;
    const speciesId = pool[Math.floor(random(state) * pool.length)];
    const wild = createMonster(state, speciesId, encounterLevel(state, region.minBadges, speciesId), 'kanto');
    state.dex.seen = uniqueSorted([...state.dex.seen, speciesId]);
    state.battle = {
      kind: 'wild', regionId, policyRegion: 'kanto', player: { team: state.player.team, activeIndex: firstRegionalHealthy(state, 'kanto') },
      enemy: { team: [wild], activeIndex: 0 }, turn: 1, canRun: true,
    };
    const text = `야생 ${getSpecies(speciesId).name}이(가) 나타났다.`;
    addLog(state, text);
    return { kind: 'encounter', speciesId, amount: 1, text };
  }
  if (roll < .88) {
    const available: InventoryItem[] = ['poke-ball', 'potion', 'rare-candy'];
    if (state.player.badges >= 3) available.push('super-potion');
    const item = available[Math.floor(random(state) * available.length)];
    state.inventory[item]++;
    const text = `${item} 1개를 찾았다.`; addLog(state, text);
    return { kind: 'item', item, amount: 1, text };
  }
  const amount = 100 + state.player.badges * 50;
  state.player.money += amount;
  const text = `${amount}원을 찾았다.`; addLog(state, text);
  return { kind: 'money', amount, text };
}

export function challengeGym(state: GameState, regionId: string): BattleState {
  assertPlayable(state);
  const reason = campaignTravelReason(state, 'kanto'); if (reason) throw new Error(reason);
  if (state.battle) throw new Error('이미 전투 중입니다.');
  const region = getRegion(regionId);
  if (!region.gym) throw new Error('이 지역에는 체육관이 없습니다.');
  if (state.defeatedGyms.includes(region.gym.badge)) throw new Error('이미 이긴 체육관입니다.');
  if (region.gym.badge !== state.player.badges + 1) throw new Error('체육관은 순서대로 도전해야 합니다.');
  if (state.player.badges < region.minBadges) throw new Error(`배지 ${region.minBadges}개가 필요합니다.`);
  state.regionId = regionId;
  const enemy = createMonster(state, region.gym.speciesId, region.gym.level, 'kanto');
  state.battle = { kind: 'gym', regionId, policyRegion: 'kanto', player: { team: state.player.team, activeIndex: firstRegionalHealthy(state, 'kanto') }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: false, gymBadge: region.gym.badge };
  addLog(state, `${region.gym.leader}에게 도전했다.`);
  return state.battle;
}

export function challengeChampion(state: GameState): BattleState {
  return challengeCampaignTrainer(state, 'kanto');
}

export function challengeCampaignGym(state: GameState, region: CampaignRegion, locationId: string): BattleState {
  assertPlayable(state);
  const reason = campaignTravelReason(state, region); if (reason) throw new Error(reason);
  if (state.battle || state.captureOffer) throw new Error('배틀과 포획 선택을 마친 뒤 도전하세요.');
  const gym = getCampaignGyms(state, region).find(item => item.locationId === locationId);
  if (!gym || gym.badge !== getRegionalBadges(state, region) + 1) throw new Error('체육관은 지역별 순서대로 도전해야 합니다.');
  const healthy = firstRegionalHealthy(state, region);
  state.regionId = region === 'kanto' ? REGIONS[gym.badge - 1].id : REGIONS[0].id;
  const enemy = createMonster(state, gym.speciesId, gym.level, region);
  state.dex.seen = uniqueSorted([...state.dex.seen, enemy.speciesId]);
  state.battle = { kind: 'gym', campaignRegion: region, policyRegion: region, regionId: state.regionId, gymBadge: gym.badge,
    player: { team: state.player.team, activeIndex: healthy }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: false };
  addLog(state, `${region === 'johto' ? '성도' : '관동'} ${gym.name}에게 도전했다.`);
  return state.battle;
}

export function challengeCampaignTrainer(state: GameState, region: CampaignRegion): BattleState {
  assertPlayable(state);
  const reason = campaignTravelReason(state, region); if (reason) throw new Error(reason);
  if (state.battle || state.captureOffer) throw new Error('배틀과 포획 선택을 마친 뒤 도전하세요.');
  const trainer = getNextCampaignTrainer(state, region);
  if (!trainer) throw new Error('이 지역의 도전을 모두 마쳤습니다.');
  if (getRegionalBadges(state, region) < 8) throw new Error('사천왕 도전에는 해당 지역 배지 8개가 필요합니다.');
  if (trainer.kind === 'red' && !canChallengeRed(state)) throw new Error('레드 도전에는 두 지역 리그를 모두 클리어해야 합니다.');
  const healthy = firstRegionalHealthy(state, region);
  const enemy = trainer.team.map(([id, level]) => createMonster(state, id, level, region));
  state.dex.seen = uniqueSorted([...state.dex.seen, ...enemy.map(monster => monster.speciesId)]);
  state.battle = { kind: trainer.kind, campaignRegion: region, policyRegion: region, trainerId: trainer.id,
    regionId: trainer.kind === 'red' ? 'mt-silver' : 'pokemon-league',
    player: { team: state.player.team, activeIndex: healthy }, enemy: { team: enemy, activeIndex: 0 }, turn: 1, canRun: false };
  addLog(state, `${trainer.name}에게 도전했다.`);
  return state.battle;
}


export function challengeFieldTrainer(state: GameState, trainer: FieldTrainer): BattleState {
  assertPlayable(state);
  const canonical = getFieldTrainer(trainer.id);
  if (!canonical) throw new Error('등록되지 않은 트레이너입니다.');
  trainer = canonical;
  const travelReason = campaignTravelReason(state, trainer.region);
  if (travelReason) throw new Error(travelReason);
  if (state.battle || state.captureOffer) throw new Error('진행 중인 배틀이나 포획 선택을 먼저 마쳐 주세요.');
  state.defeatedFieldTrainers ??= [];
  if (state.defeatedFieldTrainers.includes(trainer.id)) throw new Error('이미 승리한 트레이너입니다.');
  const healthy = firstRegionalHealthy(state, trainer.region);
  const enemy = trainer.team.map(([id, level]) => createMonster(state, id, level, trainer.region));
  state.dex.seen = uniqueSorted([...state.dex.seen, ...enemy.map(monster => monster.speciesId)]);
  state.battle = { kind: 'trainer', campaignRegion: trainer.region, policyRegion: trainer.region, trainerId: trainer.id, regionId: trainer.locationId,
    player: { team: state.player.team, activeIndex: healthy }, enemy: { team: enemy, activeIndex: 0 }, turn: 1, canRun: false };
  addLog(state, `${trainer.name}에게 트레이너 배틀을 신청했다.`);
  return state.battle;
}

function active(side: BattleSide): Monster { return side.team[side.activeIndex]; }
function effectiveSpeciesId(battle: BattleState, monster: Monster): number { return battle.transformations?.[monster.instanceId]?.speciesId ?? monster.speciesId; }
function effectiveStats(battle: BattleState, monster: Monster): MonsterStats { return battle.transformations?.[monster.instanceId]?.stats ?? monster.stats; }
function effectiveMoves(battle: BattleState, monster: Monster): MonsterMove[] { return battle.transformations?.[monster.instanceId]?.moves ?? monster.moves; }
function stageMultiplier(stage = 0): number { return stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage); }
function combatant(monster: Monster, battle: BattleState) {
  const base = effectiveStats(battle, monster); const stages = battle.statStages?.[monster.instanceId] ?? {};
  return { level: monster.level, hp: monster.hp, stats: {
    hp: base.hp,
    attack: Math.max(1, Math.floor(base.attack * stageMultiplier(stages.attack))),
    defense: Math.max(1, Math.floor(base.defense * stageMultiplier(stages.defense))),
    specialAttack: Math.max(1, Math.floor(base.specialAttack * stageMultiplier(stages.specialAttack))),
    specialDefense: Math.max(1, Math.floor(base.specialDefense * stageMultiplier(stages.specialDefense))),
    speed: Math.max(1, Math.floor(base.speed * stageMultiplier(stages.speed))),
  }, types: getSpecies(effectiveSpeciesId(battle, monster)).types, status: monster.status, ability: monster.ability };
}

function validMoveIndexes(monster: Monster, battle: BattleState): number[] {
  return effectiveMoves(battle, monster).map((_, index) => index);
}

function circularMoveIndex(monster: Monster, battle: BattleState, requested: number): number {
  const moves = effectiveMoves(battle, monster); const count = moves.length;
  if (!count) return -1;
  const start = ((Math.floor(requested) % count) + count) % count;
  return start;
}

function pickEnemyMove(state: GameState, battle: BattleState, monster: Monster, aiChoice?: number): { index: number; wait: boolean; source: 'external-brain' | 'seeded-random' } {
  const valid = validMoveIndexes(monster, battle);
  if (aiChoice !== undefined) {
    const mapped = ((Math.floor(aiChoice) % 5) + 5) % 5;
    if (mapped === 4) return { index: -1, wait: true, source: 'external-brain' };
    return { index: circularMoveIndex(monster, battle, mapped), wait: false, source: 'external-brain' };
  }
  if (!valid.length) return { index: -1, wait: false, source: 'seeded-random' };
  return { index: valid[Math.floor(random(state) * valid.length)], wait: false, source: 'seeded-random' };
}

function event(battle: BattleState, text: string, kind: BattleLogEntry['kind'] = 'info'): BattleLogEntry {
  return { turn: battle.turn, text, kind };
}

const SELF_TARGETS = new Set([4, 7, 13, 15]);
function battleStat(name: string): BattleStat | undefined {
  return ({ attack: 'attack', defense: 'defense', 'special-attack': 'specialAttack', specialAttack: 'specialAttack', 'special-defense': 'specialDefense', specialDefense: 'specialDefense', speed: 'speed', accuracy: 'accuracy', evasion: 'evasion' } as Record<string, BattleStat>)[name];
}
function changeStage(battle: BattleState, monster: Monster, stat: BattleStat, change: number): number {
  battle.statStages ??= {}; const stages = battle.statStages[monster.instanceId] ??= {};
  const before = stages[stat] ?? 0; stages[stat] = Math.max(-6, Math.min(6, before + change)); return stages[stat]! - before;
}
function clearStages(battle: BattleState, monster: Monster): number {
  const delta = Object.values(battle.statStages?.[monster.instanceId] ?? {}).reduce((sum, value) => sum + Math.abs(value), 0);
  if (battle.statStages) delete battle.statStages[monster.instanceId];
  return delta;
}
const CURABLE_AILMENTS = new Set(['sleep', 'freeze', 'paralysis', 'poison', 'burn']);
function fixedMoveDamage(moveId: number, attacker: Monster, defender: Monster): number | undefined {
  if (moveId === 49) return 20; // Sonic Boom
  if (moveId === 82) return 40; // Dragon Rage
  if (moveId === 69 || moveId === 101) return attacker.level; // Seismic Toss / Night Shade
  if (moveId === 162) return Math.max(1, Math.floor(defender.hp / 2)); // Super Fang
  return undefined;
}

function performMove(state: GameState, battle: BattleState, attacker: Monster, defender: Monster, index: number, events: BattleLogEntry[], executedMoves: ExecutedMove[]): void {
  if (attacker.hp <= 0) return;
  if (attacker.status === 'sleep') {
    attacker.statusTurns = Math.max(0, (attacker.statusTurns ?? 1) - 1);
    if (attacker.statusTurns > 0) { events.push(event(battle, `${attacker.nickname}은(는) 잠들어 있다.`, 'status')); return; }
    attacker.status = undefined; attacker.statusTurns = undefined; events.push(event(battle, `${attacker.nickname}은(는) 잠에서 깨어났다.`, 'status'));
  }
  if (attacker.status === 'freeze') {
    if (random(state) >= .2) { events.push(event(battle, `${attacker.nickname}은(는) 얼어 움직일 수 없다.`, 'status')); return; }
    attacker.status = undefined; attacker.statusTurns = undefined; events.push(event(battle, `${attacker.nickname}의 얼음이 녹았다.`, 'status'));
  }
  if (attacker.status === 'paralysis' && random(state) < .25) { events.push(event(battle, `${attacker.nickname}은(는) 몸이 저려 움직일 수 없다.`, 'status')); return; }
  if (attacker.status === 'confusion') {
    attacker.statusTurns = Math.max(0, (attacker.statusTurns ?? 2) - 1);
    if (attacker.statusTurns === 0) { attacker.status = undefined; attacker.statusTurns = undefined; events.push(event(battle, `${attacker.nickname}의 혼란이 풀렸다.`, 'status')); }
    else if (random(state) < 1 / 3) { const selfDamage = Math.max(1, Math.floor(attacker.stats.hp / 8)); attacker.hp = Math.max(0, attacker.hp - selfDamage); events.push(event(battle, `${attacker.nickname}은(는) 혼란으로 자신을 공격했다.`, 'status')); return; }
  }

  const slot = effectiveMoves(battle, attacker)[index];
  if (!slot) {
    const damage = Math.max(1, Math.floor(defender.stats.hp / 8)); defender.hp = Math.max(0, defender.hp - damage);
    attacker.hp = Math.max(0, attacker.hp - Math.max(1, Math.floor(attacker.stats.hp / 4)));
    events.push(event(battle, `${attacker.nickname}은(는) 발버둥쳐 ${damage} 피해를 주었다.`, 'damage'));
    executedMoves.push({ actorInstanceId: attacker.instanceId, targetInstanceId: defender.instanceId, moveId: -1,
      moveType: 'normal', damageClass: 'physical', damagingMove: true, executed: true, hit: true,
      typeMultiplier: 1, damage, category: 'damage', hpRecovered: 0, statStageDelta: 0, ailmentApplied: false, strategicEffect: false, result: 'struggle' });
    return;
  }
  const move = getMove(slot.moveId);
  const growth = evolutionProgress(attacker);
  growth.moveUses[String(move.id)] = Math.min(1e9, (growth.moveUses[String(move.id)] ?? 0) + 1);
  let hpRecovered = 0, statStageDelta = 0, ailmentApplied = false;
  const damagingMove = move.damageClass !== 'status' && (move.power > 0 || fixedMoveDamage(move.id, attacker, defender) !== undefined || [12, 32, 90].includes(move.id));
  const attackerStages = battle.statStages?.[attacker.instanceId] ?? {}; const defenderStages = battle.statStages?.[defender.instanceId] ?? {};
  const accuracy = move.accuracy * stageMultiplier(attackerStages.accuracy) / stageMultiplier(defenderStages.evasion);
  if (move.accuracy > 0 && random(state) * 100 >= accuracy) {
    events.push(event(battle, `${attacker.nickname}의 ${move.name}은(는) 빗나갔다.`));
    executedMoves.push({ actorInstanceId: attacker.instanceId, targetInstanceId: defender.instanceId,
      moveId: move.id, moveType: move.type, damageClass: move.damageClass, damagingMove,
      executed: true, hit: false, typeMultiplier: 1, damage: 0, category: damagingMove ? 'damage' : 'status', hpRecovered: 0, statStageDelta: 0, ailmentApplied: false, strategicEffect: false, result: 'missed' });
    return;
  }

  if (move.id === 144) {
    battle.transformations ??= {};
    battle.transformations[attacker.instanceId] = { speciesId: effectiveSpeciesId(battle, defender), stats: structuredClone(effectiveStats(battle, defender)), moves: effectiveMoves(battle, defender).map((entry) => ({ moveId: entry.moveId, pp: Math.min(5, getMove(entry.moveId).pp) })) };
    events.push(event(battle, `${attacker.nickname}은(는) ${defender.nickname}의 모습으로 변신했다.`, 'status'));
    executedMoves.push({ actorInstanceId: attacker.instanceId, targetInstanceId: defender.instanceId,
      moveId: move.id, moveType: move.type, damageClass: move.damageClass, damagingMove: false,
      executed: true, hit: true, typeMultiplier: 1, damage: 0, category: 'status', hpRecovered: 0, statStageDelta: 0, ailmentApplied: false, strategicEffect: true, result: 'status' });
    return;
  }

  // These effects cannot be inferred from the source's generic move metadata.
  if ([114, 150, 156, 215, 312].includes(move.id)) {
    let cured = false, failed = false;
    if (move.id === 114) {
      statStageDelta = clearStages(battle, attacker) + clearStages(battle, defender);
      events.push(event(battle, `${move.name}: 양쪽 포켓몬의 능력치 변화가 사라졌다.`, 'status'));
    } else if (move.id === 156) {
      failed = attacker.hp === attacker.stats.hp || ['insomnia', 'vital-spirit', 'comatose'].includes(attacker.ability?.slug ?? '');
      if (!failed) {
        hpRecovered = attacker.stats.hp - attacker.hp; attacker.hp = attacker.stats.hp;
        attacker.status = 'sleep'; attacker.statusTurns = 3; ailmentApplied = true;
        events.push(event(battle, `${attacker.nickname}은(는) 잠들어 완전히 회복했다.`, 'status'));
      } else events.push(event(battle, `${move.name}을(를) 사용할 수 없었다.`, 'status'));
    } else if (move.id === 150) {
      events.push(event(battle, `${attacker.nickname}은(는) 튀어올랐다. 아무 일도 일어나지 않았다.`));
    } else {
      const side = battle.player.team.includes(attacker) ? battle.player : battle.enemy;
      for (const ally of side.team) {
        if (ally.hp <= 0 || !CURABLE_AILMENTS.has(ally.status ?? '')) continue;
        if (move.id === 215 && ally !== attacker && ['soundproof', 'good-as-gold'].includes(ally.ability?.slug ?? '')) continue;
        ally.status = undefined; ally.statusTurns = undefined; cured = true;
        events.push(event(battle, `${move.name}: ${ally.nickname}의 상태이상이 나았다.`, 'status'));
      }
      failed = !cured;
      if (failed) events.push(event(battle, `${move.name}: 치료할 상태이상이 없었다.`, 'status'));
    }
    executedMoves.push({ actorInstanceId: attacker.instanceId, targetInstanceId: attacker.instanceId,
      moveId: move.id, moveType: move.type, damageClass: move.damageClass, damagingMove: false,
      executed: true, hit: true, typeMultiplier: 1, damage: 0, category: move.id === 156 ? 'healing' : 'status',
      hpRecovered, statStageDelta, ailmentApplied, strategicEffect: hpRecovered > 0 || statStageDelta > 0 || cured,
      result: failed ? 'failed' : 'status' });
    return;
  }

  let totalDamage = 0; let multiplier = 1; let activatedAbility: 'immunity' | 'absorb' | 'sturdy' | undefined;
  const isOhko = [12, 32, 90].includes(move.id);
  let fixed = fixedMoveDamage(move.id, attacker, defender);
  if (move.id === 149) fixed = Math.max(1, Math.floor(attacker.level * (.5 + random(state))));
  const matchup = typeMultiplier(move.type, getSpecies(effectiveSpeciesId(battle, defender)).types);
  const immunity = abilityImmunity(defender.ability, move.type);
  if ((isOhko || fixed !== undefined) && immunity) { multiplier = 0; activatedAbility = immunity.heal ? 'absorb' : 'immunity'; }
  else if ((isOhko || fixed !== undefined) && matchup === 0) { multiplier = 0; events.push(event(battle, '타입 면역으로 효과가 없었다.')); }
  else if (isOhko && attacker.level < defender.level) events.push(event(battle, '상대의 레벨이 높아 일격필살이 통하지 않았다.'));
  else if (isOhko && hasSturdy(defender.ability)) { activatedAbility = 'sturdy'; }
  else if (isOhko) { totalDamage = defender.hp; defender.hp = 0; multiplier = 1; }
  else if (fixed !== undefined) {
    const capped = hasSturdy(defender.ability) && defender.hp === defender.stats.hp && fixed >= defender.hp ? defender.hp - 1 : fixed;
    if (capped !== fixed) activatedAbility = 'sturdy';
    totalDamage = Math.min(defender.hp, Math.max(0, capped)); defender.hp -= totalDamage;
  }
  else if (move.power > 0) {
    const hits = move.minHits && move.maxHits ? move.minHits + Math.floor(random(state) * (move.maxHits - move.minHits + 1)) : 1;
    for (let hit = 0; hit < hits && defender.hp > 0; hit++) {
      const result = calculateDamage(combatant(attacker, battle), combatant(defender, battle), move, .85 + random(state) * .15);
      multiplier = result.multiplier; activatedAbility ??= result.abilityActivation;
      const dealt = Math.min(defender.hp, result.damage); defender.hp -= dealt; totalDamage += dealt;
      if (result.abilityActivation === 'immunity' || result.abilityActivation === 'absorb') break;
    }
  }
  if (activatedAbility === 'absorb') {
    defender.hp = Math.min(defender.stats.hp, defender.hp + Math.max(1, Math.floor(defender.stats.hp / 4)));
  }
  if (activatedAbility) {
    const ability = monsterAbility(defender);
    const detail = activatedAbility === 'sturdy' ? '쓰러지지 않았다' : activatedAbility === 'absorb' ? '공격을 흡수해 회복했다' : '공격을 무효화했다';
    events.push(event(battle, `${defender.nickname}의 ${ability.name}: ${detail}.`, 'status'));
  }
  if (move.power > 0 || fixed !== undefined || isOhko) {
    let text = `${attacker.nickname}의 ${move.name}! ${totalDamage} 피해.`;
    if (multiplier > 1) text += ' 효과가 굉장했다.'; if (multiplier === 0) text += ' 효과가 없다.'; else if (multiplier < 1) text += ' 효과가 별로였다.';
    events.push(event(battle, text, 'damage'));
  }

  if (move.drain && totalDamage > 0) {
    const amount = Math.max(1, Math.floor(totalDamage * Math.abs(move.drain) / 100));
    if (move.drain > 0) { const before = attacker.hp; attacker.hp = Math.min(attacker.stats.hp, attacker.hp + amount); hpRecovered += attacker.hp - before; } else {
      const recoil = Math.min(attacker.hp, amount); attacker.hp -= recoil;
      growth.recoilDamage = attacker.hp > 0 ? Math.min(1e9, growth.recoilDamage + recoil) : 0;
    }
    events.push(event(battle, move.drain > 0 ? `${attacker.nickname}은(는) HP를 ${amount} 흡수했다.` : `${attacker.nickname}은(는) 반동으로 ${amount} 피해를 입었다.`, 'status'));
  }
  if (move.healing && move.healing > 0) {
    const amount = Math.max(1, Math.floor(attacker.stats.hp * move.healing / 100)); const before = attacker.hp; attacker.hp = Math.min(attacker.stats.hp, attacker.hp + amount); hpRecovered += attacker.hp - before;
    events.push(event(battle, `${attacker.nickname}의 HP가 회복되었다.`, 'status'));
  }
  let clearedBinding = false;
  if (move.id === 499 && totalDamage > 0) {
    statStageDelta += clearStages(battle, defender);
    events.push(event(battle, `${defender.nickname}의 능력치 변화가 사라졌다.`, 'status'));
  }
  if (move.id === 229 && totalDamage > 0 && ['trap', 'leech-seed'].includes(attacker.status ?? '')) {
    attacker.status = undefined; attacker.statusTurns = undefined; clearedBinding = true;
    events.push(event(battle, `${attacker.nickname}은(는) 속박에서 벗어났다.`, 'status'));
  }

  const selfByCategory = move.metaCategory === 8 || move.id === 229;
  const foeByCategory = move.metaCategory === 7;
  const stageTarget = selfByCategory ? attacker : foeByCategory ? defender : SELF_TARGETS.has(move.targetId ?? 10) ? attacker : defender;
  const statChance = move.statChance && move.statChance > 0 ? move.statChance : move.damageClass === 'status' ? 100 : move.effectChance ?? 100;
  if ((multiplier > 0 || (!damagingMove && stageTarget === attacker)) && move.statChanges?.length && random(state) * 100 < statChance) for (const change of move.statChanges) {
    const stat = battleStat(change.stat); if (!stat) continue;
    const applied = changeStage(battle, stageTarget, stat, change.change);
    statStageDelta += Math.abs(applied);
    if (applied) events.push(event(battle, `${stageTarget.nickname}의 ${change.stat} 단계가 ${applied > 0 ? '올랐다' : '내려갔다'}.`, 'status'));
  }

  const ailmentTarget = SELF_TARGETS.has(move.targetId ?? 10) ? attacker : defender;
  const ailmentChance = move.ailmentChance && move.ailmentChance > 0 ? move.ailmentChance : move.damageClass === 'status' ? 100 : move.effectChance ?? 0;
  if ((multiplier > 0 || ailmentTarget === attacker) && ailmentTarget.hp > 0 && move.ailment && move.ailment !== 'none' && !ailmentTarget.status && random(state) * 100 < ailmentChance) {
    const types = getSpecies(effectiveSpeciesId(battle, ailmentTarget)).types;
    const immune = (move.ailment === 'poison' && (types.includes('poison') || types.includes('steel'))) || (move.ailment === 'burn' && types.includes('fire')) || (move.ailment === 'freeze' && types.includes('ice')) || (move.ailment === 'paralysis' && types.includes('electric'));
    if (immune) events.push(event(battle, `${ailmentTarget.nickname}에게는 상태이상이 통하지 않았다.`, 'status'));
    else { ailmentTarget.status = move.ailment; ailmentTarget.statusTurns = move.ailment === 'sleep' ? 2 + Math.floor(random(state) * 3) : move.ailment === 'confusion' || move.ailment === 'trap' ? 2 + Math.floor(random(state) * 4) : undefined; ailmentApplied = true; events.push(event(battle, `${ailmentTarget.nickname}은(는) ${move.ailment} 상태가 되었다.`, 'status')); }
  }
  if (!damagingMove && !move.statChanges?.length && !move.healing && !move.ailment) events.push(event(battle, `${move.name}의 특수 효과는 이 로컬 규칙에서 축약되어 변화가 없었다.`));
  const failed = isOhko && attacker.level < defender.level;
  const defenderGrowth = evolutionProgress(defender);
  defenderGrowth.damageTaken = defender.hp > 0 ? Math.min(1e9, defenderGrowth.damageTaken + totalDamage) : 0;
  if (defender.hp <= 0) defenderGrowth.recoilDamage = 0;
  const hasHealing = !!((move.healing ?? 0) > 0 || (move.drain ?? 0) > 0), hasBuff = !!move.statChanges?.length || move.id === 499, hasStatus = !!(move.ailment && move.ailment !== 'none');
  const category = damagingMove && (hasHealing || hasBuff || hasStatus) ? 'mixed' : hasHealing ? 'healing' : hasBuff ? 'buff' : hasStatus || move.damageClass === 'status' ? 'status' : 'damage';
  executedMoves.push({ actorInstanceId: attacker.instanceId, targetInstanceId: defender.instanceId,
    moveId: move.id, moveType: move.type, damageClass: move.damageClass, damagingMove,
    executed: true, hit: true, typeMultiplier: multiplier, damage: totalDamage, category, hpRecovered, statStageDelta, ailmentApplied,
    strategicEffect: hpRecovered > 0 || statStageDelta > 0 || ailmentApplied || !!activatedAbility || clearedBinding,
    result: multiplier === 0 ? 'immune' : failed ? 'failed' : damagingMove ? 'hit' : 'status' });
}

function residual(battle: BattleState, monster: Monster, events: BattleLogEntry[]): void {
  if (monster.hp <= 0 || !['poison', 'burn', 'trap', 'leech-seed'].includes(monster.status ?? '')) return;
  const damage = Math.max(1, Math.floor(monster.stats.hp / 8));
  monster.hp = Math.max(0, monster.hp - damage);
  events.push(event(battle, `${monster.nickname}은(는) ${monster.status}으로 ${damage} 피해를 입었다.`, 'status'));
  if (monster.status === 'trap') {
    monster.statusTurns = Math.max(0, (monster.statusTurns ?? 1) - 1);
    if (monster.statusTurns === 0) { monster.status = undefined; monster.statusTurns = undefined; }
  }
}

function gainExperience(monster: Monster, amount: number, events?: BattleLogEntry[], battle?: BattleState, shared = false, maximumLevel = 100): ExperienceGain | undefined {
  maximumLevel = Math.max(1, Math.min(100, Math.floor(maximumLevel)));
  if (monster.level >= maximumLevel) return undefined;
  const species = getSpecies(monster.speciesId);
  const maximumXp = maximumLevel >= 100 ? experienceAtLevel(100, species.growthRate) : experienceAtLevel(maximumLevel + 1, species.growthRate) - 1;
  const applied = Math.max(0, Math.min(Math.floor(amount), maximumXp - monster.xp));
  if (!applied) return undefined;
  const levelBefore = monster.level;
  monster.xp += applied;
  while (monster.level < maximumLevel && monster.xp >= experienceAtLevel(monster.level + 1, species.growthRate)) {
    const oldMax = monster.stats.hp;
    monster.level++;
    const progress = evolutionProgress(monster); progress.friendship = Math.min(255, progress.friendship + 5);
    monster.stats = statsFor(getSpecies(monster.speciesId), monster.level, individualValues(monster));
    monster.hp += monster.stats.hp - oldMax;
    for (const learned of getSpecies(monster.speciesId).moves.filter((entry) => entry.level === monster.level)) {
      learnMove(monster, learned.moveId);
    }
    if (events && battle) events.push(event(battle, `${monster.nickname}은(는) 레벨 ${monster.level}이 되었다.`, 'reward'));
  }
  return { instanceId: monster.instanceId, amount: applied, levelsGained: monster.level - levelBefore, shared };
}

function concludeIfNeeded(state: GameState, battle: BattleState, events: BattleLogEntry[], experienceGains: ExperienceGain[]): BattleTurnResult['outcome'] | undefined {
  if (!battle.player.team.some((monster) => monster.hp > 0)) {
    recoverAfterDefeat(state);
    events.push(event(battle, '전멸하여 치료소로 돌아왔다.'));
    return 'lost';
  }
  const enemy = active(battle.enemy);
  if (enemy.hp <= 0) {
    const winner = active(battle.player);
    // A modest 1.5x reward keeps battles worthwhile without changing growth curves.
    const fullAmount = Math.max(1, Math.floor(getSpecies(enemy.speciesId).baseExperience * enemy.level * 1.5 / 7));
    const recipients = (state.experienceShare === false ? [winner] : battle.player.team).filter(monster => monster.hp > 0);
    const maximumLevel = battle.policyRegion ? regionalLevelCap(state, battle.policyRegion) : 100;
    for (const teammate of recipients) {
      const sharedGain = gainExperience(teammate, fullAmount, events, battle, teammate.instanceId !== winner.instanceId, maximumLevel);
      if (sharedGain) experienceGains.push(sharedGain);
    }
    const next = battle.enemy.team.findIndex((monster) => monster.hp > 0);
    if (next >= 0) { battle.enemy.activeIndex = next; events.push(event(battle, `상대가 ${active(battle.enemy).nickname}을(를) 내보냈다.`)); }
    else {
      if (battle.kind === 'gym' && battle.gymBadge) {
        recordCampaignGymVictory(state, battle.campaignRegion ?? 'kanto', battle.gymBadge);
        state.player.money += 1500 * battle.gymBadge;
        events.push(event(battle, `배지 ${battle.gymBadge}을(를) 얻었다.`, 'reward'));
      } else if (battle.kind === 'trainer' && battle.trainerId) {
        const trainer = getFieldTrainer(battle.trainerId)!;
        state.defeatedFieldTrainers ??= [];
        state.defeatedFieldTrainers = [...new Set([...state.defeatedFieldTrainers, trainer.id])];
        state.player.money += trainer.reward;
        events.push(event(battle, `${trainer.name}에게 승리했다! 상금 ${trainer.reward.toLocaleString()}원을 받았다.`, 'reward'));
      } else if (battle.trainerId) {
        const trainer = CAMPAIGN_TRAINERS.find(item => item.id === battle.trainerId)!;
        recordCampaignLeagueVictory(state, trainer);
        state.player.money += trainer.kind === 'red' ? 30000 : trainer.kind === 'champion' ? 20000 : 8000;
        events.push(event(battle, `${trainer.name} 클리어! 다음 도전이 열렸습니다.`, 'reward'));
      } else if (battle.kind === 'champion') {
        state.championDefeated = true; state.player.money += 20000;
        state.campaign ??= campaignProgress(state); state.campaign.kantoLeague = 5;
        events.push(event(battle, '챔피언이 되었다!', 'reward'));
      } else state.player.money += Math.max(30, enemy.level * 8);
      state.battle = undefined;
      return 'won';
    }
  }
  const player = active(battle.player);
  if (player.hp <= 0) {
    const next = battle.player.team.findIndex((monster) => monster.hp > 0
      && (!battle.policyRegion || !monsterRegionalUseReason(state, battle.policyRegion, monster)));
    if (next >= 0) { battle.awaitingSwitch = 'player'; events.push(event(battle, '다음 포켓몬을 선택해야 한다.')); }
    else {
      recoverAfterDefeat(state);
      events.push(event(battle, '전멸하여 치료소로 돌아왔다.'));
      return 'lost';
    }
  }
  return undefined;
}

export function actBattle(state: GameState, action: BattleAction, aiChoice?: number): BattleTurnResult {
  assertPlayable(state);
  if (action.type === 'catch' && !['poke-ball', 'great-ball', 'ultra-ball'].includes(action.ball)) throw new Error('올바른 볼을 선택하세요.');
  const battle = state.battle;
  if (!battle) throw new Error('진행 중인 전투가 없습니다.');
  const events: BattleLogEntry[] = [];
  const enemyPick = pickEnemyMove(state, battle, active(battle.enemy), aiChoice);
  const executedMoves: ExecutedMove[] = [];
  const experienceGains: ExperienceGain[] = [];
  const result: BattleTurnResult = { battleEnded: false, playerAction: action, enemyAction: enemyPick.wait ? { type: 'wait' } : { type: 'move', index: enemyPick.index }, events, executedMoves, experienceGains, decisionSource: enemyPick.source };
  const enemyActs = (defender: Monster) => {
    if (enemyPick.wait) events.push(event(battle, `${active(battle.enemy).nickname}은(는) 기다렸다.`));
    else performMove(state, battle, active(battle.enemy), defender, enemyPick.index, events, executedMoves);
  };

  if (battle.awaitingSwitch && action.type !== 'switch') throw new Error('기절한 포켓몬을 교체해야 합니다.');
  if (action.type === 'switch') {
    const target = battle.player.team[action.index];
    if (!target || target.hp <= 0 || action.index === battle.player.activeIndex) throw new Error('교체할 수 없는 포켓몬입니다.');
    if (battle.policyRegion) {
      const reason = monsterRegionalUseReason(state, battle.policyRegion, target); if (reason) throw new Error(reason);
    }
    const outgoing = active(battle.player);
    if (battle.statStages) delete battle.statStages[outgoing.instanceId];
    if (battle.transformations) delete battle.transformations[outgoing.instanceId];
    battle.player.activeIndex = action.index; battle.awaitingSwitch = undefined;
    events.push(event(battle, `${target.nickname}, 부탁해!`));
    enemyActs(target);
  } else if (action.type === 'run') {
    if (!battle.canRun) throw new Error('이 전투에서는 도망칠 수 없습니다.');
    const player = active(battle.player); const enemy = active(battle.enemy);
    const chance = Math.min(.95, .45 + (player.stats.speed - enemy.stats.speed) / Math.max(1, enemy.stats.speed) * .3);
    if (random(state) < chance) { state.battle = undefined; events.push(event(battle, '무사히 도망쳤다.')); for (const entry of events) addLog(state, entry.text); result.battleEnded = true; result.outcome = 'escaped'; return result; }
    events.push(event(battle, '도망치지 못했다.')); enemyActs(player);
  } else if (action.type === 'catch') {
    if (battle.kind !== 'wild') throw new Error('야생 포켓몬만 잡을 수 있습니다.');
    normalizeBalls(state);
    if (state.inventory['poke-ball'] <= 0) throw new Error('몬스터볼이 없습니다.');
    state.inventory['poke-ball']--;
    const wild = active(battle.enemy); const species = getSpecies(wild.speciesId);
    const chance = catchProbability(wild.stats.hp, wild.hp, species.catchRate, 1, wild.status);
    if (random(state) < chance) {
      const captured = structuredClone(wild); captured.status = undefined; captured.statusTurns = undefined;
      if (state.player.team.length < 6) state.player.team.push(captured); else state.player.box.push(captured);
      state.dex.seen = uniqueSorted([...state.dex.seen, captured.speciesId]);
      recordCapture(state, captured.speciesId);
      state.battle = undefined;

      events.push(event(battle, `${captured.nickname}을(를) 잡았다!`, 'capture'));
      for (const entry of events) addLog(state, entry.text);
      result.battleEnded = true; result.outcome = 'caught'; return result;
    }
    events.push(event(battle, `${species.name}이(가) 볼에서 나왔다.`, 'capture'));
    enemyActs(active(battle.player));
  } else if (action.type === 'item') {
    useHealingItem(state, action.item, action.targetInstanceId ?? active(battle.player).instanceId);
    events.push(event(battle, `${action.item}을(를) 사용했다.`));
    enemyActs(active(battle.player));
  } else if (action.type === 'wait') {
    events.push(event(battle, `${active(battle.player).nickname}은(는) 기다렸다.`));
    enemyActs(active(battle.player));
  } else {
    const player = active(battle.player); const enemy = active(battle.enemy);
    const resolvedPlayerIndex = circularMoveIndex(player, battle, action.index);
    const playerSlot = effectiveMoves(battle, player)[resolvedPlayerIndex];
    const playerMove: PokemonMove = playerSlot ? getMove(playerSlot.moveId) : { id: -1, name: '발버둥', englishName: 'Struggle', type: 'normal', power: 50, accuracy: 100, pp: 1, damageClass: 'physical', priority: 0 };
    const enemySlot = effectiveMoves(battle, enemy)[enemyPick.index];
    const enemyMove: PokemonMove = enemySlot ? getMove(enemySlot.moveId) : { id: -1, name: '발버둥', englishName: 'Struggle', type: 'normal', power: 50, accuracy: 100, pp: 1, damageClass: 'physical', priority: 0 };
    const order = turnOrder(combatant(player, battle), playerMove, combatant(enemy, battle), enemyMove, random(state));
    if (order === 'player') { performMove(state, battle, player, enemy, resolvedPlayerIndex, events, executedMoves); if (enemyPick.wait) events.push(event(battle, `${enemy.nickname}은(는) 기다렸다.`)); else performMove(state, battle, enemy, player, enemyPick.index, events, executedMoves); }
    else { if (enemyPick.wait) events.push(event(battle, `${enemy.nickname}은(는) 기다렸다.`)); else performMove(state, battle, enemy, player, enemyPick.index, events, executedMoves); performMove(state, battle, player, enemy, resolvedPlayerIndex, events, executedMoves); }
  }

  residual(battle, active(battle.player), events); residual(battle, active(battle.enemy), events);
  const outcome = concludeIfNeeded(state, battle, events, experienceGains);
  if (outcome) { result.battleEnded = true; result.outcome = outcome; }
  else battle.turn++;
  if (outcome === 'won' && battle.kind === 'gym' && battle.gymBadge) {
    result.gymVictory = { badge: battle.gymBadge, money: 1500 * battle.gymBadge, ...(battle.campaignRegion ? { region: battle.campaignRegion } : {}) };
  }
  for (const entry of events) addLog(state, entry.text);
  return result;
}

function recoverAfterDefeat(state: GameState): void {
  state.battle = undefined;
  state.player.money = Math.floor(state.player.money * .9);
  heal(state);
}

export function heal(state: GameState): void {
  if (state.battle) throw new Error('전투 중에는 치료소를 이용할 수 없습니다.');
  for (const monster of state.player.team) {
    monster.hp = monster.stats.hp; monster.status = undefined; monster.statusTurns = undefined;
  }

  addLog(state, '치료소에서 팀이 회복했다.');
}

export function buyItem(state: GameState, item: InventoryItem, quantity = 1): void {
  if (!SHOP_ITEMS.includes(item)) throw new Error('판매하지 않는 물건입니다.');
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('수량은 양의 정수여야 합니다.');
  const price = ITEM_PRICES[item];
  if (!price) throw new Error('판매하지 않는 물건입니다.');
  const cost = price * quantity;
  if (!Number.isSafeInteger(cost) || state.inventory[item] + quantity > 1_000_000_000) throw new Error('구매 수량이 너무 많습니다.');
  if (state.player.money < cost) throw new Error('돈이 부족합니다.');
  state.player.money -= cost; state.inventory[item] += quantity;
  addLog(state, `${ITEM_LABELS[item]} ${quantity}개 · ₩${(ITEM_PRICES[item] * quantity).toLocaleString('ko-KR')} 구매 완료.`);
}

function allOwned(state: GameState): Monster[] { return [...state.player.team, ...state.player.box]; }

export function isMonsterInBattle(state: GameState, instanceId: string): boolean {
  return Boolean(state.battle?.player.team.some(monster => monster.instanceId === instanceId));
}

export function firstUsableRegionalTeamIndex(state: GameState, region: CampaignRegion, startIndex = 0): number {
  if (!Number.isInteger(startIndex)) return -1;
  return Array.from({ length: state.player.team.length }, (_, offset) => (startIndex + offset) % state.player.team.length)
    .find(index => state.player.team[index].hp > 0 && !monsterRegionalUseReason(state, region, state.player.team[index])) ?? -1;
}

function firstRegionalHealthy(state: GameState, region: CampaignRegion): number {
  const index = firstUsableRegionalTeamIndex(state, region);
  if (index < 0) throw new Error(`이 지방에서 사용할 수 있는 포켓몬이 없습니다. 현지 출신 Lv.${regionalLevelCap(state, region)} 이하 포켓몬을 준비하세요.`);
  return index;
}

export function claimRegionalStarter(state: GameState, region: CampaignRegion, speciesId: number): Monster {
  assertPlayable(state);
  if (state.battle || state.captureOffer) throw new Error('배틀과 포획 선택을 마친 뒤 스타팅 포켓몬을 선택하세요.');
  const reason = campaignTravelReason(state, region); if (reason) throw new Error(reason);
  if (!isCampaignRegion(region) || !REGIONAL_STARTERS[region].includes(speciesId as never)) throw new Error('해당 지방의 스타팅 포켓몬을 선택하세요.');
  if (!needsRegionalStarter(state, region)) throw new Error('이 지방의 스타팅 포켓몬은 이미 받았습니다.');
  if (state.player.team.length >= 6 && state.player.box.length >= 10_000) throw new Error('팀과 박스에 빈자리가 필요합니다.');
  const monster = createMonster(state, speciesId, 5, region);
  if (state.player.team.length >= 6) {
    if (state.player.box.length >= 10_000) throw new Error('팀과 박스에 빈자리가 필요합니다.');
    state.player.box.push(state.player.team.pop()!);
  }
  state.player.team.push(monster);
  state.claimedRegionalStarters = [...claimedRegionalStarters(state), region];
  state.dex.seen = uniqueSorted([...state.dex.seen, speciesId]); recordCapture(state, speciesId);
  addLog(state, `${getSpecies(speciesId).name}을(를) ${region} 지방 스타팅 포켓몬으로 받았다.`);
  return monster;
}

function battleRemovalActiveId(state: GameState, removedIds: ReadonlySet<string>): string | undefined {
  const battle = state.battle;
  if (!battle) return undefined;
  const active = state.player.team[battle.player.activeIndex];
  if (!active) throw new Error('전투 출전 개체를 찾지 못했습니다.');
  if (removedIds.has(active.instanceId)) throw new Error('현재 출전 중인 포켓몬은 보낼 수 없습니다.');
  const remaining = state.player.team.filter(monster => !removedIds.has(monster.instanceId));
  if (!remaining.length || !remaining.some(monster => monster.hp > 0)) throw new Error('싸울 수 있는 마지막 포켓몬은 보낼 수 없습니다.');
  return active.instanceId;
}

function reconcileBattleRemoval(state: GameState, removedIds: ReadonlySet<string>, activeId?: string): void {
  if (!state.battle || !activeId) return;
  state.battle.player.team = state.player.team;
  state.battle.player.activeIndex = state.player.team.findIndex(monster => monster.instanceId === activeId);
  for (const id of removedIds) {
    delete state.battle.statStages?.[id];
    delete state.battle.transformations?.[id];
  }
}
function findOwned(state: GameState, instanceId: string): Monster {
  const monster = allOwned(state).find((candidate) => candidate.instanceId === instanceId);
  if (!monster) throw new Error('보유하지 않은 포켓몬입니다.');
  return monster;
}

function useHealingItem(state: GameState, item: 'potion' | 'super-potion', targetInstanceId: string): void {
  if (state.inventory[item] <= 0) throw new Error(`${item}이(가) 없습니다.`);
  const monster = findOwned(state, targetInstanceId);
  if (monster.hp <= 0) throw new Error('기절한 포켓몬에는 사용할 수 없습니다.');
  if (monster.hp >= monster.stats.hp) throw new Error('이미 HP가 가득 찼습니다.');
  monster.hp = Math.min(monster.stats.hp, monster.hp + (item === 'potion' ? 20 : 50)); state.inventory[item]--;
}

export function useItem(state: GameState, item: InventoryItem, targetInstanceId?: string, quantity = 1, policyRegion?: CampaignRegion): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('사용 수량은 1 이상의 정수여야 합니다.');
  if (!targetInstanceId) throw new Error('대상 포켓몬을 선택해야 합니다.');
  if (['friendship-treat', 'beauty-treat', 'affection-treat'].includes(item)) {
    if (state.battle) throw new Error('전투 중에는 간식을 줄 수 없습니다.');
    if (quantity > state.inventory[item]) throw new Error('간식 보유 수량이 부족합니다.');
    if (feedEvolutionTreat(findOwned(state, targetInstanceId), item, quantity)) { state.inventory[item] -= quantity; return; }
  }
  if (item === 'potion' || item === 'super-potion') {
    if (quantity !== 1) throw new Error('회복 도구는 한 번에 1개만 사용할 수 있습니다.');
    useHealingItem(state, item, targetInstanceId); return;
  }
  if (item === 'rare-candy') {
    if (state.battle) throw new Error('전투 중에는 이상한사탕을 사용할 수 없습니다.');
    const monster = findOwned(state, targetInstanceId);
    if (monster.level >= 100) throw new Error('이미 최대 레벨입니다.');
    if (quantity > state.inventory[item]) throw new Error('이상한사탕 보유 수량이 부족합니다.');
    if (quantity > 100 - monster.level) throw new Error('레벨 100을 넘도록 사용할 수 없습니다.');
    const targetLevel = monster.level + quantity;
    if (policyRegion) {
      const cap = regionalLevelCap(state, policyRegion);
      if (targetLevel > cap) throw new Error(`현지 배지 기준 이상한사탕 사용 한도는 Lv.${cap}입니다.`);
    }
    const grown: Monster = { ...monster, evolutionProgress: structuredClone(evolutionProgress(monster)), moves: structuredClone(monster.moves), moveOrder: monster.moveOrder?.slice(), movePpReserve: structuredClone(monster.movePpReserve) };
    gainExperience(grown, experienceAtLevel(targetLevel, getSpecies(monster.speciesId).growthRate) - monster.xp);
    state.inventory[item] -= quantity;
    Object.assign(monster, { xp: grown.xp, level: grown.level, stats: grown.stats, hp: grown.hp,
      moves: grown.moves, moveOrder: grown.moveOrder, movePpReserve: grown.movePpReserve, evolutionProgress: grown.evolutionProgress });
    return;
  }
  throw new Error('이 아이템은 진화 또는 전투 전용입니다.');
}

export function evolve(state: GameState, instanceId: string, option: { targetId?: number; item?: InventoryItem } = {}): Monster {
  const monster = findOwned(state, instanceId);
  if (isMonsterInBattle(state, instanceId)) throw new Error('전투 중에는 참가 포켓몬을 진화시킬 수 없습니다.');
  const evolutions = getSpecies(monster.speciesId).evolutions.filter((evolution) => option.targetId === undefined || evolution.target === option.targetId);
  const evolution = evolutions.find((candidate) => evolutionReady(state, monster, candidate, option.item));
  if (!evolution) throw new Error('현재 조건으로 가능한 진화가 없습니다.');
  const route = evolutionRoute(state, monster, evolution, option.item)!;
  const requiredItem = route.item;
  if (requiredItem) state.inventory[requiredItem]--;
  // Shedinja is a second individual: keep Nincada/Ninjask's identity and neural memory.
  if (route.shed) {
    const shed = createMonster(state, 292, monster.level, monster.originRegion);
    state.player.team.push(shed); state.inventory['poke-ball']--;
    const ninjask = getSpecies(monster.speciesId).evolutions.find(candidate => candidate.target === 291)!;
    applyEvolution(state, monster, ninjask);
    state.dex.seen = uniqueSorted([...state.dex.seen, 292]); recordCapture(state, 292);
    addLog(state, '남은 팀 자리에 껍질몬이 나타났다.'); return shed;
  }
  const leaveShell = monster.speciesId === 290 && evolution.target === 291
    && state.player.team.includes(monster) && state.player.team.length < 6 && state.inventory['poke-ball'] > 0;
  if (leaveShell) {
    const shed = createMonster(state, 292, monster.level, monster.originRegion);
    state.player.team.push(shed); state.inventory['poke-ball']--;
    state.dex.seen = uniqueSorted([...state.dex.seen, 292]); recordCapture(state, 292);
    addLog(state, '남은 팀 자리에 껍질몬이 나타났다.');
  }
  return applyEvolution(state, monster, evolution);
}

function applyEvolution(state: GameState, monster: Monster, evolution: Evolution): Monster {
  const before = getSpecies(monster.speciesId), after = getSpecies(evolution.target);
  if (before.growthRate !== after.growthRate) {
    const floor = experienceAtLevel(monster.level, before.growthRate), ceiling = experienceAtLevel(monster.level + 1, before.growthRate);
    const progress = ceiling > floor ? (monster.xp - floor) / (ceiling - floor) : 0;
    const nextFloor = experienceAtLevel(monster.level, after.growthRate), nextCeiling = experienceAtLevel(monster.level + 1, after.growthRate);
    monster.xp = nextFloor + (nextCeiling > nextFloor ? Math.min(nextCeiling - nextFloor - 1, Math.floor((nextCeiling - nextFloor) * Math.max(0, Math.min(1, progress)))) : 0);
  }
  const oldMax = monster.stats.hp;
  const previousAbility = monsterAbility(monster);
  monster.speciesId = evolution.target; monster.nickname = getSpecies(evolution.target).name;
  monster.ability = abilityForSpecies(evolution.target, previousAbility.slot, previousAbility.hidden);
  if (!isValidGender(monster.speciesId, monster.gender)) monster.gender = genderFor(monster.speciesId, monster.instanceId);
  evolutionProgress(monster).gender = monster.gender!;
  monster.stats = statsFor(getSpecies(evolution.target), monster.level, individualValues(monster));
  monster.hp = Math.min(monster.stats.hp, monster.hp + monster.stats.hp - oldMax);
  for (const learned of knownMoves(getSpecies(evolution.target), monster.level)) {
    learnMove(monster, learned.moveId);
  }
  reconcileMoveOrder(monster);
  state.dex.seen = uniqueSorted([...state.dex.seen, evolution.target]); recordCapture(state, evolution.target);
  addLog(state, `${monster.nickname}(으)로 진화했다.`); return monster;
}

function normalizeEvolutionItem(item?: string): InventoryItem | undefined {
  if (!item) return undefined;
  const normalized = item.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
  return INVENTORY_ITEMS.includes(normalized as InventoryItem) ? normalized as InventoryItem : undefined;
}

export function evolutionItemFor(speciesId: number, evolution: Evolution): InventoryItem | undefined {
  return evolutionItemsFor(speciesId, evolution)[0];
}

export function evolutionItemsFor(speciesId: number, evolution: Evolution): InventoryItem[] {
  const explicit = ITEM_EVOLUTION_RULES.find(rule => rule.from === speciesId && rule.to === evolution.target)?.item;
  const source = sourceEvolutionItems(speciesId, evolution.target).map(normalizeEvolutionItem).filter((item): item is InventoryItem => !!item);
  return [...new Set([...(explicit ? [explicit] : []), ...source])];
}

let evolutionUses: Map<InventoryItem, string> | undefined;
export function evolutionItemUses(item: InventoryItem): string {
  if (!evolutionUses) {
    const names = new Map<InventoryItem, string[]>();
    for (const species of POKEMON) for (const evolution of species.evolutions) {
      for (const required of evolutionItemsFor(species.id, evolution)) {
        const list = names.get(required) ?? [];
        list.push(`${species.name} → ${getSpecies(evolution.target).name}`); names.set(required, list);
      }
    }
    evolutionUses = new Map([...names].map(([id, list]) => [id, list.join(' · ')]));
  }
  return ({ 'evolution-catalyst': '원본의 별도 진화 조건을 대체합니다. 필요한 레벨은 유지합니다.',
    'friendship-treat': '개체 친밀도 +20 · 걷기와 레벨업으로도 상승합니다.', 'beauty-treat': '개체 아름다움 +20', 'affection-treat': '개체 애정 +20' } as Partial<Record<InventoryItem, string>>)[item] ?? evolutionUses.get(item) ?? '';
}

export function evolutionRoute(state: GameState, monster: Monster, evolution: Evolution, supplied?: InventoryItem): { item?: InventoryItem; shed?: boolean } | undefined {
  if (isMonsterInBattle(state, monster.instanceId)) return undefined;
  if (supplied === 'evolution-catalyst') return needsSpecialEvolution(monster.speciesId, evolution)
    && monster.level >= specialEvolutionLevel(monster.speciesId, evolution.target) && state.inventory[supplied] > 0 ? { item: supplied } : undefined;
  if (supplied === undefined) {
    const natural = naturalEvolution(state, monster, evolution);
    if (natural) return natural.trigger === 4 ? { shed: true } : {};
    // Compatibility for authored data without a source row. Source-backed rows never bypass predicates.
    if (!sourceEvolutionRules(monster.speciesId, evolution.target).length && evolution.method === 'level' && monster.level >= (evolution.level ?? 1)) return {};
  }
  const item = evolutionItemsFor(monster.speciesId, evolution).find(item => state.inventory[item] > 0 && (supplied === undefined || item === supplied));
  return item ? { item } : undefined;
}
function evolutionReady(state: GameState, monster: Monster, evolution: Evolution, supplied?: InventoryItem): boolean {
  return !!evolutionRoute(state, monster, evolution, supplied);
}

export function availableEvolutions(state: GameState, instanceId: string): Evolution[] {
  const monster = findOwned(state, instanceId);
  return getSpecies(monster.speciesId).evolutions.filter((evolution) => evolutionReady(state, monster, evolution));
}

export function swapTeam(state: GameState, teamIndex: number, boxIndex: number, policyRegion?: CampaignRegion): void {
  if (state.battle) throw new Error('전투 중에는 팀을 바꿀 수 없습니다.');
  const teamMonster = state.player.team[teamIndex]; const boxMonster = state.player.box[boxIndex];
  if (!teamMonster || !boxMonster) throw new Error('교체 위치가 올바르지 않습니다.');
  if (policyRegion && !monsterRegionalUseReason(state, policyRegion, teamMonster)
    && monsterRegionalUseReason(state, policyRegion, boxMonster)
    && !state.player.team.some((monster, index) => index !== teamIndex && !monsterRegionalUseReason(state, policyRegion, monster)))
    throw new Error('현재 지방에서 사용할 수 있는 포켓몬 한 마리는 팀에 남겨야 합니다.');
  state.player.team[teamIndex] = boxMonster; state.player.box[boxIndex] = teamMonster;
}

export function depositMonster(state: GameState, teamIndex: number, policyRegion?: CampaignRegion): void {
  if (!Number.isInteger(teamIndex) || teamIndex < 0 || teamIndex >= state.player.team.length) throw new Error('잘못된 팀 위치입니다.');
  if (state.player.team.length <= 1 || state.player.box.length >= 10000) throw new Error('지금은 맡길 수 없습니다.');
  if (state.battle?.player.activeIndex === teamIndex) throw new Error('현재 출전 중인 포켓몬은 맡길 수 없습니다.');
  if (!state.player.team.some((monster, index) => index !== teamIndex && monster.hp > 0)) throw new Error('싸울 수 있는 포켓몬 한 마리는 팀에 남겨야 합니다.');
  if (policyRegion && !state.player.team.some((monster, index) => index !== teamIndex && !monsterRegionalUseReason(state, policyRegion, monster)))
    throw new Error('현재 지방에서 사용할 수 있는 포켓몬 한 마리는 팀에 남겨야 합니다.');
  const [monster] = state.player.team.splice(teamIndex, 1);
  if (state.battle) {
    if (teamIndex < state.battle.player.activeIndex) state.battle.player.activeIndex--;
    delete state.battle.statStages?.[monster.instanceId]; delete state.battle.transformations?.[monster.instanceId];
  }
  state.player.box.push(monster);
}

export function withdrawMonster(state: GameState, boxIndex: number): void {
  if (!Number.isInteger(boxIndex) || boxIndex < 0 || boxIndex >= state.player.box.length) throw new Error('잘못된 박스 위치입니다.');
  if (state.player.team.length >= 6) throw new Error('지금은 데려올 수 없습니다.');
  const [monster] = state.player.box.splice(boxIndex, 1); if (!monster) throw new Error('잘못된 박스 위치입니다.');
  state.player.team.push(monster);
}

/** Reorder presentation slots while preserving engine/neural indexes. */
export function reorderMonsterMoves(state: GameState, instanceId: string, from: number, to: number): void {
  if (state.battle) throw new Error('전투 중에는 기술 배치를 바꿀 수 없습니다.');
  const monster = findOwned(state, instanceId);
  const layout = getMoveLayout(monster);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= layout.length || to >= layout.length) throw new Error('기술 배치 위치가 올바르지 않습니다.');
  if (from === to) return;
  const [moved] = layout.splice(from, 1);
  layout.splice(to, 0, moved);
  monster.moveOrder = layout.map((entry) => entry.moveId);
}

/** Equip a learned move while retaining legacy save fields and individual memory. */
export function replaceMonsterMove(state: GameState, instanceId: string, displayIndex: number, moveId: number): void {
  const monster = findOwned(state, instanceId);
  if (state.battle || state.captureOffer) throw new Error('전투와 포획 선택을 마친 뒤 기술을 교체할 수 있습니다.');
  const layout = getMoveLayout(monster);
  if (!Number.isInteger(displayIndex) || displayIndex < 0 || displayIndex > layout.length || displayIndex >= 4) throw new Error('기술 교체 위치가 올바르지 않습니다.');
  if (!Number.isSafeInteger(moveId) || !availableMonsterMoveIds(monster).includes(moveId)) throw new Error('현재 레벨에서 배울 수 없는 기술입니다.');
  const existing = monster.moves.findIndex((slot) => slot.moveId === moveId);
  const target = layout[displayIndex];
  if (existing >= 0) {
    if (target?.sourceIndex === existing) return;
    throw new Error('이미 배치한 기술입니다.');
  }
  const replacement = { moveId, pp: takeStoredMovePp(monster, moveId) };
  if (!target) monster.moves.push(replacement);
  else {
    const [removed] = monster.moves.splice(target.sourceIndex, 1, replacement);
    storeMovePp(monster, removed);
  }
  const order = layout.map((entry) => entry.moveId);
  if (displayIndex < order.length) order[displayIndex] = moveId;
  else order.push(moveId);
  monster.moveOrder = order;
  if (monster.brain) monster.brain.previous = null;
}

/** Explicitly replace the first displayed status slot with a legal damaging move. */
export function recoverAttackMove(state: GameState, instanceId: string, moveId: number): void {
  const monster = findOwned(state, instanceId);
  if (state.battle || state.captureOffer) throw new Error('전투와 포획 선택을 마친 뒤 공격 기술을 배치할 수 있습니다.');
  if (!Number.isSafeInteger(moveId) || !recoverableAttackMoveIds(monster).includes(moveId)) throw new Error('배치할 수 있는 공격 기술이 아닙니다.');
  const priorOrder = getMoveLayout(monster).map((entry) => entry.moveId);
  const replacement = { moveId, pp: takeStoredMovePp(monster, moveId) };
  if (monster.moves.length < 4) {
    monster.moves.push(replacement);
    monster.moveOrder = [moveId, ...priorOrder];
  }
  else {
    const first = getMoveLayout(monster)[0];
    if (!first) throw new Error('교체할 기술이 없습니다.');
    const [removed] = monster.moves.splice(first.sourceIndex, 1, replacement);
    storeMovePp(monster, removed);
    priorOrder[0] = moveId;
    monster.moveOrder = priorOrder;
  }
  if (monster.brain) monster.brain.previous = null;
}

export const BALL_REFILL_INTERVAL = 30;
export const BALL_REFILL_CAP = 20;
export function replenishBalls(state: GameState, elapsedSeconds: number): number {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > 5) throw new Error('보충 시간이 올바르지 않습니다.');
  if (state.inventory['poke-ball'] >= BALL_REFILL_CAP) { state.ballRefillSeconds = 0; return 0; }
  state.ballRefillSeconds = (state.ballRefillSeconds ?? 0) + elapsedSeconds;
  const amount = Math.min(BALL_REFILL_CAP - state.inventory['poke-ball'], Math.floor(state.ballRefillSeconds / BALL_REFILL_INTERVAL));
  state.inventory['poke-ball'] += amount;
  state.ballRefillSeconds %= BALL_REFILL_INTERVAL;
  return amount;
}

function recordCapture(state: GameState, speciesId: number): void {
  state.dex.caught = uniqueSorted([...state.dex.caught, speciesId]);
  const version = state.adventureVersion ?? 'red';
  state.versionCaught ??= {};
  if (getVersionSpeciesIds(version).includes(speciesId)) state.versionCaught[version] = uniqueSorted([...(state.versionCaught[version] ?? []), speciesId]);
}

/** Remove only an explicitly selected individual, preserving the historical dex. */
export function releaseMonster(state: GameState, instanceId: string, policyRegion?: CampaignRegion): Monster {
  if (state.captureOffer) throw new Error('포획 선택을 마친 뒤 놓아줄 수 있습니다.');
  const monster = findOwned(state, instanceId);
  const teamIndex = state.player.team.findIndex(item => item.instanceId === instanceId);
  if (teamIndex >= 0 && state.player.team.length <= 1) throw new Error('마지막 팀 포켓몬은 놓아줄 수 없습니다.');
  if (policyRegion && !monsterRegionalUseReason(state, policyRegion, monster)
    && !allOwned(state).some(candidate => candidate !== monster && !monsterRegionalUseReason(state, policyRegion, candidate)))
    throw new Error('현재 지방에서 사용할 수 있는 마지막 포켓몬은 놓아줄 수 없습니다.');
  const removed = new Set([instanceId]), activeId = battleRemovalActiveId(state, removed);
  if (teamIndex >= 0) state.player.team.splice(teamIndex, 1);
  else state.player.box.splice(state.player.box.findIndex(item => item.instanceId === instanceId), 1);
  reconcileBattleRemoval(state, removed, activeId);
  addLog(state, `${monster.nickname} (${instanceId})을(를) 놓아주었다.`);
  return monster;
}

/** Use the same preview and commit rules for one donor and an entire batch. */
export function mergeDuplicateMonster(state: GameState, targetId: string, donorId: string, policyRegion?: CampaignRegion): number {
  return mergeDuplicateMonsters(state, targetId, [donorId], policyRegion).gainedXp;
}

/** Freeze the explicitly selected donor IDs so a later capture cannot join an approved merge. */
export function previewDuplicateMerge(state: GameState, targetId: string, donorIds: readonly string[], policyRegion?: CampaignRegion) {
  if (state.captureOffer) throw new Error('포획 선택을 마친 뒤 합칠 수 있습니다.');
  if (!donorIds.length || new Set(donorIds).size !== donorIds.length || donorIds.includes(targetId)) throw new Error('서로 다른 중복 개체를 선택하세요.');
  const target = findOwned(state, targetId), donors = donorIds.map(id => findOwned(state, id));
  if (donors.some(donor => donor.speciesId !== target.speciesId)) throw new Error('같은 종끼리만 경험치를 합칠 수 있습니다.');
  if (target.level >= 100) throw new Error('이미 최고 레벨입니다.');
  battleRemovalActiveId(state, new Set(donorIds));
  const donorLevels = donors.reduce((sum, donor) => sum + donor.level, 0);
  const highestDonorLevel = Math.max(...donors.map(donor => donor.level));
  const baselineLevel = Math.max(target.level, highestDonorLevel);
  const bonusLevels = Math.max(1, Math.floor(duplicateMergeValue({ level: baselineLevel }).levels));
  const uncappedToLevel = baselineLevel + bonusLevels, toLevel = Math.min(100, uncappedToLevel);
  const gainedLevels = toLevel - target.level, totalLevels = gainedLevels;
  const growth = getSpecies(target.speciesId).growthRate;
  const startXp = experienceAtLevel(target.level, growth), nextXp = experienceAtLevel(target.level + 1, growth);
  const progress = Math.max(0, Math.min(1, (target.xp - startXp) / (nextXp - startXp)));
  const destinationXp = experienceAtLevel(toLevel, growth) + (toLevel < 100 ? Math.floor(progress * (experienceAtLevel(toLevel + 1, growth) - experienceAtLevel(toLevel, growth))) : 0);
  const gainedXp = Math.max(0, destinationXp - target.xp);
  const movesToTeam = !state.battle && state.player.team.every(monster => donorIds.includes(monster.instanceId));
  const regionalUseReason = policyRegion ? monsterRegionalUseReason(state, policyRegion, { ...target, level: toLevel }) : undefined;
  return { donorIds: [...donorIds], count: donors.length, donorLevels, highestDonorLevel, baselineLevel, bonusLevels, totalLevels, gainedLevels, toLevel, excessLevels: uncappedToLevel - toLevel, gainedXp,
    movesToTeam, regionalUseReason };
}

/** Commit a validated batch once, even when its combined XP reaches level 100 partway through. */
export function mergeDuplicateMonsters(state: GameState, targetId: string, donorIds: readonly string[], policyRegion?: CampaignRegion) {
  const plan = previewDuplicateMerge(state, targetId, donorIds, policyRegion), target = findOwned(state, targetId);
  const ids = new Set(plan.donorIds);
  const activeId = battleRemovalActiveId(state, ids);
  const team = state.player.team.filter(monster => !ids.has(monster.instanceId));
  const box = state.player.box.filter(monster => !ids.has(monster.instanceId) && (!plan.movesToTeam || monster !== target));
  if (plan.movesToTeam) team.push(target);
  // Stage growth before any collection mutation; keep the original neural objects intact.
  const grown: Monster = { ...target, evolutionProgress: structuredClone(evolutionProgress(target)), moves: structuredClone(target.moves), moveOrder: target.moveOrder?.slice(), movePpReserve: structuredClone(target.movePpReserve) };
  gainExperience(grown, plan.gainedXp);
  Object.assign(target, { xp: grown.xp, level: grown.level, stats: grown.stats, hp: grown.hp,
    moves: grown.moves, moveOrder: grown.moveOrder, movePpReserve: grown.movePpReserve, evolutionProgress: grown.evolutionProgress });
  state.player.team = team; state.player.box = box;
  reconcileBattleRemoval(state, ids, activeId);
  addLog(state, `${target.nickname} (${targetId})에게 같은 종 최고 레벨 Lv.${plan.baselineLevel}을 기준으로 5% 보너스 ${plan.bonusLevels}레벨을 한 번 적용해 Lv.${plan.toLevel}. 남긴 개체의 회로 기억은 유지했다.`);
  return plan;
}

export function serializeGame(state: GameState): string { assertPlayable(state); return JSON.stringify(state); }

export function restoreGame(json: string): GameState {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('저장 JSON을 읽을 수 없습니다.'); }
  return validateGame(value);
}

/** Engineered victory rule: one available ball guarantees this defeated individual. */
export function captureDefeatedWild(state: GameState, ball: BallItem): boolean {
  if (!['poke-ball', 'great-ball', 'ultra-ball'].includes(ball)) return false;
  normalizeBalls(state); ball = 'poke-ball';
  const monster = state.captureOffer;
  if (!monster || state.battle || !['poke-ball', 'great-ball', 'ultra-ball'].includes(ball) || state.inventory[ball] <= 0 || (state.player.team.length >= 6 && state.player.box.length >= 10000)) return false;
  state.inventory[ball]--;
  monster.hp = Math.max(1, monster.hp); monster.status = undefined; monster.statusTurns = undefined;
  if (state.player.team.length < 6) state.player.team.push(monster); else state.player.box.push(monster);
  state.dex.seen = uniqueSorted([...state.dex.seen, monster.speciesId]);
  recordCapture(state, monster.speciesId);
  state.captureOffer = undefined;
  addLog(state, `${monster.nickname} 포획 성공! ${ITEM_LABELS[ball]} 1개를 사용했다.`);
  return true;
}

export function validateGame(value: unknown): GameState {
  if (!value || typeof value !== 'object') throw new Error('저장 데이터는 객체여야 합니다.');
  const state = value as GameState;
  state.defeatedFieldTrainers ??= [];
  if (!Array.isArray(state.defeatedFieldTrainers) || state.defeatedFieldTrainers.some((id, index, all) => typeof id !== 'string' || !getFieldTrainer(id) || all.indexOf(id) !== index)) throw new Error('Field trainer progress is damaged.');
  if (state.schemaVersion !== SAVE_SCHEMA_VERSION) throw new Error(`지원하지 않는 저장 스키마입니다: ${String(state.schemaVersion)}`);
  if (state.experienceShare !== undefined && typeof state.experienceShare !== 'boolean') throw new Error('경험치 공유 설정이 손상되었습니다.');
  state.experienceShare ??= true;
  state.nursery ??= [];
  if (!Array.isArray(state.nursery) || state.nursery.length > 6) throw new Error('알 보관함 데이터가 손상되었습니다.');
  state.adventureVersion ??= 'red';
  const versionSpecies = getVersionSpeciesIds(state.adventureVersion);
  if (!versionSpecies.length) throw new Error('수집 버전이 올바르지 않습니다.');
  state.versionCaught ??= { red: [...(state.dex?.caught ?? [])].filter(id => getVersionSpeciesIds('red').includes(id)) };
  if (!state.versionCaught || typeof state.versionCaught !== 'object' || Array.isArray(state.versionCaught) || Object.keys(state.versionCaught).length > 100) throw new Error('버전별 도감이 올바르지 않습니다.');
  for (const [version, ids] of Object.entries(state.versionCaught)) {
    const allowed = getVersionSpeciesIds(version);
    if (!allowed.length || !Array.isArray(ids) || ids.length !== new Set(ids).size || ids.some(id => !allowed.includes(id) || !state.dex?.caught?.includes(id))) throw new Error('버전별 수집 기록이 올바르지 않습니다.');
  }
  state.ballRefillSeconds ??= 0;
  if (!Number.isFinite(state.ballRefillSeconds) || state.ballRefillSeconds < 0 || state.ballRefillSeconds >= BALL_REFILL_INTERVAL) throw new Error('볼 보충 기록이 올바르지 않습니다.');
  if (typeof state.seed !== 'string' || !state.seed || state.seed.length > 200) throw new Error('시드가 손상되었습니다.');
  if (!Number.isInteger(state.rngState) || state.rngState <= 0 || state.rngState > 0xffffffff || !Number.isSafeInteger(state.nextInstanceId) || state.nextInstanceId < 1) throw new Error('난수/개체 ID 상태가 손상되었습니다.');
  if (!state.player || !Number.isSafeInteger(state.player.money) || state.player.money < 0 || !Number.isInteger(state.player.badges) || state.player.badges < 0 || state.player.badges > 8 || !Array.isArray(state.player.team) || !Array.isArray(state.player.box) || state.player.team.length < 1 || state.player.team.length > 6 || state.player.box.length > 10000) throw new Error('플레이어/팀/박스 데이터가 손상되었습니다.');
  if (!state.inventory || !state.dex || !Array.isArray(state.dex.seen) || !Array.isArray(state.dex.caught)) throw new Error('가방 또는 도감 데이터가 손상되었습니다.');
  if (Array.isArray(state.inventory) || Object.keys(state.inventory).some(item => !INVENTORY_ITEMS.includes(item as InventoryItem))) throw new Error('가방 품목 구성이 올바르지 않습니다.');
  // Only genuinely absent new keys are legacy defaults; explicit invalid values still fail.
  for (const item of EXTRA_EVOLUTION_ITEM_IDS) if (!Object.hasOwn(state.inventory, item)) state.inventory[item] = 0;
  for (const item of INVENTORY_ITEMS) if (!Number.isSafeInteger(state.inventory[item]) || state.inventory[item] < 0 || state.inventory[item] > 1_000_000_000) throw new Error(`가방 수량이 잘못되었습니다: ${item}`);
  normalizeBalls(state);
  for (const id of [...state.dex.seen, ...state.dex.caught]) if (!Number.isInteger(id) || !POKEMON.some(species => species.id === id)) throw new Error('도감 번호가 잘못되었습니다.');
  if (!Array.isArray(state.defeatedGyms) || state.defeatedGyms.length !== state.player.badges || state.defeatedGyms.some((badge, index) => badge !== index + 1)) throw new Error('배지 진행이 손상되었습니다.');
  if (typeof state.championDefeated !== 'boolean' || (state.championDefeated && state.player.badges !== 8)) throw new Error('챔피언 진행이 손상되었습니다.');
  state.campaign ??= campaignProgress(state);
  const progress = state.campaign;
  if (!progress || !['johto', 'kanto'].includes(progress.startRegion) || !Array.isArray(progress.johtoBadges)
    || progress.johtoBadges.length > 8 || progress.johtoBadges.some((badge, index) => badge !== index + 1)
    || ![progress.johtoLeague, progress.kantoLeague].every(stage => Number.isInteger(stage) && stage >= 0 && stage <= 5)
    || (progress.johtoLeague > 0 && progress.johtoBadges.length !== 8) || (progress.kantoLeague > 0 && state.player.badges !== 8)
    || (progress.startRegion === 'johto' && state.player.badges > 0 && progress.johtoLeague < 5)
    || (progress.kantoLeague === 5) !== state.championDefeated || typeof progress.redDefeated !== 'boolean'
    || (progress.redDefeated && !canChallengeRed(state))) throw new Error('지역별 리그 진행이 손상되었습니다.');
  validateExpansionCampaign(state);
  state.claimedRegionalStarters ??= [progress.startRegion];
  if (!Array.isArray(state.claimedRegionalStarters) || state.claimedRegionalStarters.length > CAMPAIGN_REGIONS.length
    || !state.claimedRegionalStarters.includes(progress.startRegion)
    || state.claimedRegionalStarters.some((region, index, all) => !isCampaignRegion(region) || all.indexOf(region) !== index))
    throw new Error('지역별 스타팅 포켓몬 수령 기록이 손상되었습니다.');
  if (!Array.isArray(state.logs) || state.logs.length > 200 || state.logs.some((log) => typeof log !== 'string' || log.length > 500)) throw new Error('로그가 손상되었습니다.');
  const region = getRegion(state.regionId);
  if (region.minBadges > state.player.badges) throw new Error('잠기지 않은 지역 진행이 손상되었습니다.');
  if (state.dex.caught.some((id) => !state.dex.seen.includes(id))) throw new Error('잡은 도감은 발견 도감에 포함되어야 합니다.');
  const ids = new Set<string>(); let maximumGeneratedId = 0;
  if (state.captureOffer && (state.battle || state.captureOffer.hp !== 0 || !state.dex.seen.includes(state.captureOffer.speciesId))) throw new Error('승리 후 포획 대상이 올바르지 않습니다.');
  const monsters = [...state.player.team, ...state.player.box, ...(state.battle?.enemy.team ?? []), ...(state.captureOffer ? [state.captureOffer] : [])];
  if (state.evolutionContext !== undefined) validateEvolutionContext(state.evolutionContext);
  for (const monster of monsters) {
    if (!monster || typeof monster.instanceId !== 'string' || !/^mon-[1-9]\d*$/.test(monster.instanceId) || ids.has(monster.instanceId)) throw new Error('개체 ID가 없거나 중복되었습니다.');
    ids.add(monster.instanceId); const species = getSpecies(monster.speciesId);
    monster.originRegion ??= progress.startRegion;
    if (!isCampaignRegion(monster.originRegion)) throw new Error('포켓몬 출신 지방 기록이 손상되었습니다.');
    if (monster.ivs === undefined && monster.ability === undefined) Object.assign(monster, legacyIndividualTraits(monster.instanceId, monster.speciesId));
    else if (monster.ivs === undefined || monster.ability === undefined) throw new Error('개체값/특성 데이터가 일부만 있습니다.');
    if (!isValidIndividualValues(monster.ivs)) throw new Error('개체값이 잘못되었습니다.');
    const currentAbility = canonicalAbility(monster.ability, monster.speciesId);
    if (!currentAbility) throw new Error('특성이 원본 종/슬롯 데이터와 맞지 않습니다.');
    // Source identity is persisted, while labels and implemented-effect notes
    // are release metadata and must be refreshed without invalidating a save.
    monster.ability = currentAbility;
    if (monster.evolutionProgress !== undefined) validateEvolutionProgress(monster.evolutionProgress);
    if (monster.gender === undefined) {
      const legacyGender = monster.evolutionProgress?.gender;
      monster.gender = legacyGender !== undefined && isValidGender(monster.speciesId, legacyGender)
        ? legacyGender : genderFor(monster.speciesId, monster.instanceId);
    }
    if (!isValidGender(monster.speciesId, monster.gender)) throw new Error('개체 성별이 원본 종 데이터와 맞지 않습니다.');
    if (monster.evolutionProgress === undefined) monster.evolutionProgress = initialEvolutionProgress(monster);
    monster.evolutionProgress.gender = monster.gender;
    const match = /^mon-(\d+)$/.exec(monster.instanceId); if (match) maximumGeneratedId = Math.max(maximumGeneratedId, Number(match[1]));
    if (typeof monster.nickname !== 'string' || !monster.nickname || monster.nickname.length > 40 || !Number.isInteger(monster.level) || monster.level < 1 || monster.level > 100 || !Number.isSafeInteger(monster.xp) || monster.xp < experienceAtLevel(monster.level, species.growthRate) || (monster.level < 100 && monster.xp >= experienceAtLevel(monster.level + 1, species.growthRate))) throw new Error('이름/레벨/경험치가 잘못되었습니다.');
    const expectedStats = statsFor(species, monster.level, monster.ivs);
    if (!monster.stats || (Object.keys(expectedStats) as (keyof MonsterStats)[]).some((key) => monster.stats[key] !== expectedStats[key]) || !Number.isFinite(monster.hp) || monster.hp < 0 || monster.hp > monster.stats.hp) throw new Error('능력치/HP가 잘못되었습니다.');
    if (!Array.isArray(monster.moves) || monster.moves.length > 4) throw new Error('기술 데이터가 잘못되었습니다.');
    for (const slot of monster.moves) { const move = getMove(slot.moveId); if (!Number.isInteger(slot.pp) || slot.pp < 0 || slot.pp > move.pp) throw new Error('PP가 잘못되었습니다.'); }
    const knownMoveIds = new Set(monster.moves.map((slot) => slot.moveId));
    if (monster.moveOrder !== undefined) {
      if (!Array.isArray(monster.moveOrder) || monster.moveOrder.length > 4 || monster.moveOrder.length !== new Set(monster.moveOrder).size || monster.moveOrder.some((moveId) => !Number.isSafeInteger(moveId) || !knownMoveIds.has(moveId))) throw new Error('기술 배치가 잘못되었습니다.');
    }
    if (monster.movePpReserve !== undefined) {
      const legalMoveIds = new Set(availableMonsterMoveIds(monster));
      if (!monster.movePpReserve || typeof monster.movePpReserve !== 'object' || Array.isArray(monster.movePpReserve) || Object.keys(monster.movePpReserve).length > legalMoveIds.size) throw new Error('미장착 기술 PP가 잘못되었습니다.');
      for (const [moveIdText, pp] of Object.entries(monster.movePpReserve)) {
        const moveId = Number(moveIdText);
        if (!/^\d+$/.test(moveIdText) || String(moveId) !== moveIdText || !legalMoveIds.has(moveId) || knownMoveIds.has(moveId) || !Number.isInteger(pp) || pp < 0 || pp > getMove(moveId).pp) throw new Error('미장착 기술 PP가 잘못되었습니다.');
      }
    }
    if (monster.status !== undefined && (typeof monster.status !== 'string' || !monster.status || monster.status.length > 40)) throw new Error('상태이상이 잘못되었습니다.');
    if (monster.statusTurns !== undefined && (!Number.isInteger(monster.statusTurns) || monster.statusTurns < 1 || monster.statusTurns > 10)) throw new Error('상태이상 지속 시간이 잘못되었습니다.');
    if (monster.moveLearning !== undefined) for (const [moveId, stats] of Object.entries(monster.moveLearning)) {
      if (!/^\d+$/.test(moveId) || !stats || ![stats.choices, stats.executed, stats.effective].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1e9) || !Number.isFinite(stats.reward) || Math.abs(stats.reward) > 1e9 || stats.executed > stats.choices || stats.effective > stats.executed) throw new Error('기술 학습 통계가 잘못되었습니다.');
      getMove(Number(moveId));
    }
    if (monster.brain !== undefined) Brain.restore(monster.brain);
  }
  const eggIds = new Set<string>();
  for (const egg of state.nursery) {
    validateEgg(egg);
    if (eggIds.has(egg.eggId)) throw new Error('알 ID가 중복되었습니다.');
    eggIds.add(egg.eggId);
    const match = /^egg-(\d+)$/.exec(egg.eggId); if (match) maximumGeneratedId = Math.max(maximumGeneratedId, Number(match[1]));
  }
  if (state.nextInstanceId <= maximumGeneratedId) throw new Error('다음 개체 ID가 기존 ID보다 커야 합니다.');
  if (state.battle) {
    const battle = state.battle;
    if (!['wild', 'gym', 'trainer', 'champion', 'elite', 'red'].includes(battle.kind) || !Number.isInteger(battle.turn) || battle.turn < 1 || typeof battle.canRun !== 'boolean' || !Array.isArray(battle.enemy?.team) || battle.enemy.team.length < 1 || !Number.isInteger(battle.enemy.activeIndex) || battle.enemy.activeIndex < 0 || battle.enemy.activeIndex >= battle.enemy.team.length || !Number.isInteger(battle.player?.activeIndex) || battle.player.activeIndex < 0 || battle.player.activeIndex >= state.player.team.length) throw new Error('전투 상태가 손상되었습니다.');
    if (battle.kind === 'wild' ? !battle.canRun || battle.enemy.team.length !== 1 : battle.canRun) throw new Error('전투 도주 규칙이 손상되었습니다.');
    if (battle.campaignRegion !== undefined && !CAMPAIGN_REGIONS.includes(battle.campaignRegion)) throw new Error('전투 지역이 손상되었습니다.');
    if (battle.policyRegion !== undefined && !isCampaignRegion(battle.policyRegion)) throw new Error('전투 사용 정책 지역이 손상되었습니다.');
    if (battle.kind !== 'wild' && campaignTravelReason(state, battle.campaignRegion ?? 'kanto')) throw new Error('리그 여행 조건이 손상되었습니다.');
    if (battle.kind === 'gym' && (!Number.isInteger(battle.gymBadge) || battle.gymBadge !== getRegionalBadges(state, battle.campaignRegion ?? 'kanto') + 1)) throw new Error('체육관 전투 진행이 손상되었습니다.');
    if (battle.kind === 'trainer') {
      const expected = battle.trainerId && getFieldTrainer(battle.trainerId);
      if (!expected || state.defeatedFieldTrainers.includes(expected.id) || expected.region !== battle.campaignRegion || expected.locationId !== battle.regionId
        || battle.gymBadge !== undefined || battle.enemy.team.length !== expected.team.length
        || battle.enemy.team.some((monster, index) => monster.speciesId !== expected.team[index][0] || monster.level !== expected.team[index][1])) throw new Error('트레이너 배틀 진행이 손상되었습니다.');
    } else if (battle.trainerId !== undefined) {
      const expected = getNextCampaignTrainer(state, battle.campaignRegion ?? 'kanto');
      if (!expected || expected.id !== battle.trainerId || expected.kind !== battle.kind || expected.region !== battle.campaignRegion
        || getRegionalBadges(state, expected.region) < 8 || (expected.kind === 'red' && !canChallengeRed(state))) throw new Error('리그 전투 진행이 손상되었습니다.');
    } else if (battle.kind === 'elite' || battle.kind === 'red') throw new Error('트레이너 정보가 없습니다.');
    if (battle.kind === 'champion' && !battle.trainerId && state.player.badges !== 8) throw new Error('챔피언 전투 조건이 손상되었습니다.');
    if (battle.kind === 'trainer') {
      // Field trainer location is validated against its immutable source record above.
    } else if (battle.kind === 'wild' || battle.kind === 'gym') {
      const battleRegion = getRegion(battle.regionId);
      if (battle.regionId !== state.regionId || battleRegion.minBadges > state.player.badges) throw new Error('전투 지역이 손상되었습니다.');
    } else if (battle.regionId !== (battle.kind === 'red' ? 'mt-silver' : 'pokemon-league')) throw new Error('리그 전투 지역이 손상되었습니다.');
    if (Array.isArray(battle.player.team)) for (const member of battle.player.team) {
      const owned = member && state.player.team.find(candidate => candidate.instanceId === member.instanceId && candidate.speciesId === member.speciesId);
      if (member && owned) {
        if (member.evolutionProgress === undefined) member.evolutionProgress = structuredClone(owned.evolutionProgress);
        if (member.gender === undefined) member.gender = owned.gender;
        if (member.ivs === undefined) member.ivs = structuredClone(owned.ivs);
        if (member.ability === undefined) member.ability = structuredClone(owned.ability);
        else if (!canonicalAbility(member.ability, member.speciesId)) throw new Error('전투 특성이 원본 종/슬롯 데이터와 맞지 않습니다.');
        else member.ability = structuredClone(owned.ability);
        if (member.evolutionProgress) member.evolutionProgress.gender = member.gender!;
      }
    }
    if (!Array.isArray(battle.player.team) || JSON.stringify(battle.player.team) !== JSON.stringify(state.player.team)) throw new Error('전투 팀과 플레이어 팀이 일치하지 않습니다.');
    if (battle.awaitingSwitch !== undefined && battle.awaitingSwitch !== 'player') throw new Error('강제 교체 상태가 손상되었습니다.');
    const activePlayer = state.player.team[battle.player.activeIndex];
    if ((activePlayer.hp === 0) !== (battle.awaitingSwitch === 'player') && state.player.team.some((monster) => monster.hp > 0)) throw new Error('강제 교체 대상이 일치하지 않습니다.');
    const battleIds = new Set([...state.player.team, ...battle.enemy.team].map((monster) => monster.instanceId));
    if (battle.statStages) for (const [instanceId, stages] of Object.entries(battle.statStages)) {
      if (!battleIds.has(instanceId) || !stages || Object.entries(stages).some(([stat, stage]) => !['attack', 'defense', 'specialAttack', 'specialDefense', 'speed', 'accuracy', 'evasion'].includes(stat) || !Number.isInteger(stage) || stage < -6 || stage > 6)) throw new Error('능력 단계가 손상되었습니다.');
    }
    if (battle.transformations) for (const [instanceId, form] of Object.entries(battle.transformations)) {
      if (!battleIds.has(instanceId) || !form || !Number.isInteger(form.speciesId) || !form.stats || !Array.isArray(form.moves) || form.moves.length > 4) throw new Error('변신 상태가 손상되었습니다.');
      getSpecies(form.speciesId);
      if ((Object.values(form.stats) as unknown[]).some((stat) => !Number.isFinite(stat) || (stat as number) <= 0 || (stat as number) > 10000)) throw new Error('변신 능력치가 손상되었습니다.');
      for (const slot of form.moves) { const move = getMove(slot.moveId); if (!Number.isInteger(slot.pp) || slot.pp < 0 || slot.pp > Math.min(5, move.pp)) throw new Error('변신 기술 PP가 손상되었습니다.'); }
    }
    battle.player.team = state.player.team;
  }

  return state;
}

function assertPlayable(state: GameState): void {
  if (state.schemaVersion !== SAVE_SCHEMA_VERSION) throw new Error('게임 저장 스키마가 일치하지 않습니다.');
}
