import { Brain, type BrainState } from '../core/brain';
import { getMove, getSpecies, POKEMON, TYPE_EFFECTIVENESS } from '../data/pokemon';
import { getExperienceForLevel, EXPERIENCE_BY_GROWTH_RATE } from '../data/pokemon-experience';
import { getVersionSpeciesIds } from '../data/pokemon-versions';
import { getAlolaCombatForm, getCombatForm, getMegaCombatForm, type PokemonCombatFormProfile } from '../data/pokemon-combat-forms';
import { getPokemonFormModelSource } from '../data/pokemon-form-models';
import type { BaseStats, Evolution, PokemonMove, PokemonSpecies, PokemonType } from './contracts';
import { calculateDamage, catchProbability, resolveTeraMove, turnOrder, typeMultiplier } from './battle';
import { getMoveLayout, reconcileMoveOrder } from './move-layout';
import { getRegion, REGIONS } from './regions';
import { CAMPAIGN_REGIONS, CAMPAIGN_TRAINERS, campaignProgress, campaignTravelReason, canChallengeRed, getRegionalBadges, getNextCampaignTrainer, getCampaignGyms, recordCampaignGymVictory, recordCampaignLeagueVictory, validateExpansionCampaign, type CampaignRegion, type CampaignProgress } from './campaign';
import { duplicateMergeValue } from './growth';
import { EXTRA_EVOLUTION_ITEM_IDS, EXTRA_EVOLUTION_PRICES, EXTRA_EVOLUTION_LABELS, emptyExtraEvolutionInventory, ITEM_EVOLUTION_RULES, type ExtraEvolutionItem } from './evolution-items';
import { initialEvolutionProgress, evolutionProgress, validateEvolutionProgress, validateEvolutionContext, type EvolutionProgress, type EvolutionContext } from './evolution-progress';
import { evolutionFormSupported, feedEvolutionTreat, naturalEvolution, needsSpecialEvolution, sourceEvolutionItems, sourceEvolutionItemsForMonster, sourceEvolutionRules, specialEvolutionLevel } from './evolution-conditions';
import { getFieldTrainer, type FieldTrainer } from '../data/field-trainers';
import fieldItems from '../data/field-items.json' with { type: 'json' };
import { genderFor, isValidGender, validateEgg, type Egg, type MonsterGender } from './breeding';
import { abilityForSpecies, abilityImmunity, canonicalAbility, createIndividualTraits, hasSturdy, isValidIndividualValues, speciesAbilities,
  legacyIndividualTraits, statsWithIndividualValues, type IndividualValues, type MonsterAbility } from './individual-traits';
import { REGIONAL_STARTERS, claimedRegionalStarters, isCampaignRegion, monsterRegionalUseReason, needsRegionalStarter, regionalLevelCap } from './regional-policy';
export { duplicateMergeValue } from './growth';
export { abilityForSpecies, createIndividualTraits, speciesAbilities, type IndividualValues, type MonsterAbility } from './individual-traits';

export const SAVE_SCHEMA_VERSION = 2 as const;
export type BallItem = 'poke-ball' | 'great-ball' | 'ultra-ball';
export const HELD_TOOLS = ['leftovers', 'choice-band', 'choice-specs', 'choice-scarf', 'life-orb', 'focus-sash'] as const;
export type HeldTool = typeof HELD_TOOLS[number];
export type MegaStoneId = `mega-stone:${string}`;
export type EquippableItem = HeldTool | MegaStoneId;
export type FieldItem = { id: EquippableItem; name: string; kind: 'held-tool' | 'mega-stone'; formIdentifier?: string; speciesId?: number };
export const FIELD_ITEMS = fieldItems as readonly FieldItem[];
export const MEGA_STONES = FIELD_ITEMS.filter((item): item is FieldItem & { id: MegaStoneId; kind: 'mega-stone'; formIdentifier: string; speciesId: number } => item.kind === 'mega-stone');
export const EQUIPPABLE_ITEMS = FIELD_ITEMS.map(item => item.id) as readonly EquippableItem[];
export function megaStoneId(formIdentifier: string): MegaStoneId { return `mega-stone:${formIdentifier}`; }
export function megaStoneForSpecies(speciesId: number, formIdentifier?: string) {
  return MEGA_STONES.find(item => item.speciesId === speciesId && (!formIdentifier || item.formIdentifier === formIdentifier));
}
export type InventoryItem = BallItem | 'potion' | 'super-potion' | 'rare-candy' | 'fire-stone' | 'water-stone' | 'thunder-stone' | 'leaf-stone' | 'moon-stone' | 'link-cable' | ExtraEvolutionItem | EquippableItem;
export type BattleKind = 'wild' | 'gym' | 'trainer' | 'champion' | 'elite' | 'red';

export type MonsterStats = BaseStats;
export type MonsterMove = { moveId: number; pp: number };
export type PreferredTransformation = { kind: 'mega'; formIdentifier: string } | { kind: 'tera'; teraType: PokemonType };
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
  /** Optional battle equipment. Legacy saves omit it. */
  heldTool?: EquippableItem;
  preferredTransformation?: PreferredTransformation;
  /** Optional canonical regional combat form; currently supports Alola forms. */
  regionalForm?: string;
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
export type BattleTransformation = { speciesId: number; stats: MonsterStats; moves: MonsterMove[]; types?: PokemonType[]; ability?: MonsterAbility; kind?: 'transform' | 'mega' | 'tera'; formIdentifier?: string; teraType?: PokemonType; hpAdjusted?: true };
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
  playerMegaUsed?: boolean;
  playerTeraUsed?: boolean;
  choiceLocks?: Record<string, number>;
  consumedTools?: string[];
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
  /** Battle-unit HP before form reversion and post-defeat healing. */
  endingHp?: Record<string, { hp: number; maxHp: number }>;
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
  /** Merge newly captured duplicates into an existing individual. */
  autoMergeDuplicates?: boolean;
  adventureVersion?: string;
  versionCaught?: Record<string, number[]>;
  /** Legacy finite refill progress retained for schema-v2 save/server compatibility; runtime resets it to zero. */
  ballRefillSeconds?: number;
  evolutionContext?: EvolutionContext;
  battle?: BattleState;
  /** Open-world victory reward, held until the player catches or releases it. */
  captureOffer?: Monster;
  logs: string[];
};

export const HELD_TOOL_LABELS: Readonly<Record<HeldTool, string>> = {
  leftovers: '먹다남은음식', 'choice-band': '구애머리띠', 'choice-specs': '구애안경',
  'choice-scarf': '구애스카프', 'life-orb': '생명의구슬', 'focus-sash': '기합의띠',
};
export const HELD_TOOL_DESCRIPTIONS: Readonly<Record<HeldTool, string>> = {
  leftovers: '턴이 끝날 때 최대 HP의 1/16을 회복합니다.',
  'choice-band': '공격이 1.5배가 되고 처음 사용한 기술로 고정됩니다.',
  'choice-specs': '특수공격이 1.5배가 되고 처음 사용한 기술로 고정됩니다.',
  'choice-scarf': '스피드가 1.5배가 되고 처음 사용한 기술로 고정됩니다.',
  'life-orb': '공격 피해가 1.3배가 되고 적중 후 최대 HP의 1/10을 잃습니다.',
  'focus-sash': 'HP가 가득 찼을 때 한 번만 HP 1로 버팁니다.',
};
export const HELD_TOOL_PRICES: Readonly<Record<HeldTool, number>> = {
  leftovers: 4000, 'choice-band': 6000, 'choice-specs': 6000,
  'choice-scarf': 6000, 'life-orb': 8000, 'focus-sash': 4000,
};
export const HEALING_ITEM_HP: Readonly<Record<'potion' | 'super-potion', number>> = { potion: 20, 'super-potion': 60 };

export type ExploreResult = { kind: 'encounter' | 'item' | 'money'; speciesId?: number; item?: InventoryItem; amount: number; text: string };

export const ITEM_PRICES: Readonly<Record<InventoryItem, number>> = {
  'poke-ball': 20, 'great-ball': 60, 'ultra-ball': 120,
  potion: 300, 'super-potion': 700, 'rare-candy': 2400,
  'fire-stone': 3000, 'water-stone': 3000, 'thunder-stone': 3000,
  'leaf-stone': 3000, 'moon-stone': 3000, 'link-cable': 4000,
  ...EXTRA_EVOLUTION_PRICES,
  ...HELD_TOOL_PRICES,
  ...Object.fromEntries(MEGA_STONES.map(item => [item.id, 0])) as Record<MegaStoneId, number>,
};
export const ITEM_LABELS: Readonly<Record<InventoryItem, string>> = {
  'poke-ball': '몬스터볼', 'great-ball': '슈퍼볼', 'ultra-ball': '하이퍼볼',
  potion: '상처약', 'super-potion': '좋은상처약', 'rare-candy': '이상한사탕',
  'fire-stone': '불꽃의돌', 'water-stone': '물의돌', 'thunder-stone': '천둥의돌',
  'leaf-stone': '리프의돌', 'moon-stone': '달의돌', 'link-cable': '연결의끈',
  ...EXTRA_EVOLUTION_LABELS,
  ...HELD_TOOL_LABELS,
  ...Object.fromEntries(MEGA_STONES.map(item => [item.id, item.name])) as Record<MegaStoneId, string>,
};
const INVENTORY_ITEMS = Object.keys(ITEM_PRICES) as InventoryItem[];
export const SHOP_ITEMS: readonly InventoryItem[] = INVENTORY_ITEMS.filter(item => !['poke-ball', 'great-ball', 'ultra-ball', 'friendship-treat', 'galarica-cuff', 'galarica-wreath'].includes(item) && !EQUIPPABLE_ITEMS.includes(item as EquippableItem));

/** Legacy ball counts stay finite for save/server compatibility; one finite token represents unlimited basic balls. */
export function normalizeBalls(state: GameState): void {
  const balls = ['poke-ball', 'great-ball', 'ultra-ball'] as const;
  if (balls.some(ball => !Number.isSafeInteger(state.inventory[ball]) || state.inventory[ball] < 0)) throw new Error('볼 수량이 올바르지 않습니다.');
  const total = balls.reduce((sum, ball) => sum + state.inventory[ball], 0);
  if (total > 1_000_000_000) throw new Error('볼 수량이 너무 많습니다.');
  state.inventory['poke-ball'] = Math.max(1, total); state.inventory['great-ball'] = 0; state.inventory['ultra-ball'] = 0;
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

function combatFormAbility(profile: PokemonCombatFormProfile, slot?: number): MonsterAbility | undefined {
  const source = slot === undefined ? profile.abilities[0] : profile.abilities.find(ability => ability.slot === slot);
  if (!source) return undefined;
  const implemented = ['overgrow','blaze','torrent','swarm','levitate','sturdy','water-absorb','volt-absorb'].includes(source.slug);
  const partial = ['flash-fire','lightning-rod','motor-drive','sap-sipper','storm-drain','dry-skin','insomnia','vital-spirit','comatose','soundproof','good-as-gold'].includes(source.slug);
  return { ...source, effect: implemented ? 'implemented' : partial ? 'partial' : 'display-only', description: `${source.name} · ${profile.name}의 원본 폼 특성` };
}

export function monsterAbilities(monster: Pick<Monster, 'speciesId' | 'regionalForm'>): readonly MonsterAbility[] {
  const profile = monster.regionalForm ? getCombatForm(monster.regionalForm) : undefined;
  return profile ? profile.abilities.map(ability => combatFormAbility(profile, ability.slot)!) : speciesAbilities(monster.speciesId);
}

function formMoves(profile: PokemonCombatFormProfile, level: number): MonsterMove[] {
  const ids = [...new Set(profile.levelUpMoves.filter(entry => entry.level <= level).map(entry => entry.moveId))].slice(-4);
  return ids.map(moveId => ({ moveId, pp: getMove(moveId).pp }));
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
export function availableMonsterMoveIds(monster: Pick<Monster, 'speciesId' | 'level' | 'regionalForm'>): number[] {
  const forms = [monster.speciesId], visited = new Set<number>(), entries: Array<{ moveId: number; level: number; order: number }> = [];
  let order = 0;
  const profile = monster.regionalForm ? getCombatForm(monster.regionalForm) : undefined;
  if (profile) for (const learned of profile.levelUpMoves) if (learned.level <= monster.level) entries.push({ ...learned, order: order++ });
  while (forms.length) {
    const form = forms.shift()!;
    if (visited.has(form)) continue;
    visited.add(form);
    const species = getSpecies(form);
    for (const learned of species.moves) if (learned.level <= monster.level) entries.push({ ...learned, order: order++ });
    forms.push(...(PRE_EVOLUTIONS.get(form) ?? []));
  }
  entries.sort((a, b) => a.level - b.level || a.order - b.order);
  return [...new Set([...entries.map((entry) => entry.moveId), ...getSpecies(monster.speciesId).machineMoves])];
}

/** Discard obsolete PP cache entries without changing the saved monster. */
function normalizeMovePpReserve(monster: Monster): void {
  const reserve = monster.movePpReserve;
  if (reserve === undefined) return;
  if (!reserve || typeof reserve !== 'object' || Array.isArray(reserve)) {
    delete monster.movePpReserve;
    return;
  }
  const legal = new Set(availableMonsterMoveIds(monster)), equipped = new Set(monster.moves.map(slot => slot.moveId));
  const normalized: Record<string, number> = {};
  for (const [key, pp] of Object.entries(reserve)) {
    const moveId = Number(key);
    if (String(moveId) !== key || !legal.has(moveId) || equipped.has(moveId) || !Number.isInteger(pp) || pp < 0) continue;
    normalized[key] = Math.min(pp, getMove(moveId).pp);
  }
  if (Object.keys(normalized).length) monster.movePpReserve = normalized;
  else delete monster.movePpReserve;
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
  const alola = monster.originRegion === 'alola' ? getAlolaCombatForm(speciesId) : undefined;
  if (alola) {
    monster.regionalForm = alola.identifier;
    monster.stats = formStats(monster, alola); monster.hp = monster.stats.hp;
    monster.ability = combatFormAbility(alola) ?? monster.ability;
    const moves = formMoves(alola, normalizedLevel); if (moves.length) monster.moves = moves;
  }
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
      ...Object.fromEntries(HELD_TOOLS.map(tool => [tool, 0])) as Record<HeldTool, number>,
      ...Object.fromEntries(MEGA_STONES.map(stone => [stone.id, 0])) as Record<MegaStoneId, number>,
    },
    dex: { seen: [starterId], caught: [starterId] }, regionId: REGIONS[0].id,
    defeatedGyms: [], defeatedFieldTrainers: [], championDefeated: false, experienceShare: true, autoMergeDuplicates: false, adventureVersion: 'red', versionCaught: { red: [starterId] }, ballRefillSeconds: 0, logs: [],
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
    applyPreferredBattleTransformation(state);
    const text = `야생 ${getSpecies(speciesId).name}이(가) 나타났다.`;
    addLog(state, text);
    return { kind: 'encounter', speciesId, amount: 1, text };
  }
  if (roll < .88) {
    const available: InventoryItem[] = ['potion', 'rare-candy'];
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
  applyPreferredBattleTransformation(state);
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
  applyPreferredBattleTransformation(state);
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
  applyPreferredBattleTransformation(state);
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
  applyPreferredBattleTransformation(state);
  return state.battle;
}

function active(side: BattleSide): Monster { return side.team[side.activeIndex]; }
function effectiveSpeciesId(battle: BattleState, monster: Monster): number { return battle.transformations?.[monster.instanceId]?.speciesId ?? monster.speciesId; }
function regionalProfile(monster: Monster): PokemonCombatFormProfile | undefined { return monster.regionalForm ? getCombatForm(monster.regionalForm) : undefined; }
function formStats(monster: Monster, profile: PokemonCombatFormProfile): MonsterStats { return statsFor({ ...getSpecies(monster.speciesId), baseStats: profile.baseStats }, monster.level, individualValues(monster)); }
export function battleMonsterMaxHp(battle: BattleState | undefined, monster: Monster): number {
  const form = battle?.transformations?.[monster.instanceId];
  return form?.kind === 'mega' && form.hpAdjusted ? form.stats.hp : monster.stats.hp;
}
function effectiveStats(battle: BattleState, monster: Monster): MonsterStats {
  const profile = regionalProfile(monster), stats = battle.transformations?.[monster.instanceId]?.stats ?? (profile ? formStats(monster, profile) : monster.stats);
  const hp = battleMonsterMaxHp(battle, monster);
  return stats.hp === hp ? stats : { ...stats, hp };
}
function scaleHp(hp: number, before: number, after: number, roundUp: boolean): number {
  const value = hp * after / Math.max(1, before);
  return Math.max(hp > 0 ? 1 : 0, Math.min(after, roundUp ? Math.ceil(value) : Math.floor(value)));
}
function endBattle(state: GameState, result: BattleTurnResult): void {
  const battle = state.battle;
  if (!battle) return;
  const participants = [...battle.player.team, ...battle.enemy.team];
  result.endingHp = Object.fromEntries(participants.map(monster => [monster.instanceId, { hp: monster.hp, maxHp: battleMonsterMaxHp(battle, monster) }]));
  for (const monster of participants) {
    const form = battle.transformations?.[monster.instanceId];
    if (form?.kind === 'mega' && form.hpAdjusted) monster.hp = scaleHp(monster.hp, form.stats.hp, monster.stats.hp, false);
  }
  state.battle = undefined;
}
function effectiveMoves(battle: BattleState, monster: Monster): MonsterMove[] { return battle.transformations?.[monster.instanceId]?.moves ?? monster.moves; }
function effectiveTypes(battle: BattleState, monster: Monster): readonly PokemonType[] { return battle.transformations?.[monster.instanceId]?.types ?? regionalProfile(monster)?.types ?? getSpecies(effectiveSpeciesId(battle, monster)).types; }
function effectiveAbility(battle: BattleState, monster: Monster): MonsterAbility | undefined { return battle.transformations?.[monster.instanceId]?.ability ?? monster.ability; }
export function battleMonsterTypes(state: GameState, monster: Monster): readonly PokemonType[] { return state.battle ? effectiveTypes(state.battle, monster) : regionalProfile(monster)?.types ?? getSpecies(monster.speciesId).types; }
export function battleMonsterView(battle: BattleState, monster: Monster) {
  const transformation = battle.transformations?.[monster.instanceId];
  return { ...monster, speciesId: effectiveSpeciesId(battle, monster), stats: effectiveStats(battle, monster),
    moves: effectiveMoves(battle, monster), types: effectiveTypes(battle, monster), ability: effectiveAbility(battle, monster),
    teraType: transformation?.kind === 'tera' ? transformation.teraType : undefined,
    lockedMoveId: battle.choiceLocks?.[monster.instanceId] };
}
function activeHeldTool(battle: BattleState, monster: Monster): EquippableItem | undefined {
  return battle.consumedTools?.includes(monster.instanceId) ? undefined : monster.heldTool;
}
function stageMultiplier(stage = 0): number { return stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage); }
function combatant(monster: Monster, battle: BattleState) {
  const base = effectiveStats(battle, monster); const stages = battle.statStages?.[monster.instanceId] ?? {};
  const transformation = battle.transformations?.[monster.instanceId];
  const physical = monster.heldTool === 'choice-band' ? 1.5 : 1;
  const special = monster.heldTool === 'choice-specs' ? 1.5 : 1;
  const speed = monster.heldTool === 'choice-scarf' ? 1.5 : 1;
  return { level: monster.level, hp: monster.hp, stats: {
    hp: base.hp,
    attack: Math.max(1, Math.floor(base.attack * stageMultiplier(stages.attack) * physical)),
    defense: Math.max(1, Math.floor(base.defense * stageMultiplier(stages.defense))),
    specialAttack: Math.max(1, Math.floor(base.specialAttack * stageMultiplier(stages.specialAttack) * special)),
    specialDefense: Math.max(1, Math.floor(base.specialDefense * stageMultiplier(stages.specialDefense))),
    speed: Math.max(1, Math.floor(base.speed * stageMultiplier(stages.speed) * speed)),
  }, types: effectiveTypes(battle, monster), originalTypes: regionalProfile(monster)?.types ?? getSpecies(monster.speciesId).types,
    teraType: transformation?.kind === 'tera' ? transformation.teraType : undefined, status: monster.status, ability: effectiveAbility(battle, monster), heldTool: activeHeldTool(battle, monster) };
}

function validMoveIndexes(monster: Monster, battle: BattleState): number[] {
  const lock = battle.choiceLocks?.[monster.instanceId];
  return effectiveMoves(battle, monster).flatMap((slot, index) => lock === undefined || slot.moveId === lock ? [index] : []);
}

export function battleMoveView(battle: BattleState, monster: Monster, moveId: number): PokemonMove {
  return resolveTeraMove(combatant(monster, battle), getMove(moveId));
}

function circularMoveIndex(monster: Monster, battle: BattleState, requested: number): number {
  const moves = effectiveMoves(battle, monster); const count = moves.length;
  if (!count) return -1;
  const lock = battle.choiceLocks?.[monster.instanceId];
  if (lock !== undefined) return moves.findIndex(slot => slot.moveId === lock);
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
    else if (random(state) < 1 / 3) { const selfDamage = Math.max(1, Math.floor(battleMonsterMaxHp(battle, attacker) / 8)); attacker.hp = Math.max(0, attacker.hp - selfDamage); events.push(event(battle, `${attacker.nickname}은(는) 혼란으로 자신을 공격했다.`, 'status')); return; }
  }

  const slot = effectiveMoves(battle, attacker)[index];
  if (!slot) {
    const damage = Math.max(1, Math.floor(battleMonsterMaxHp(battle, defender) / 8)); defender.hp = Math.max(0, defender.hp - damage);
    attacker.hp = Math.max(0, attacker.hp - Math.max(1, Math.floor(battleMonsterMaxHp(battle, attacker) / 4)));
    events.push(event(battle, `${attacker.nickname}은(는) 발버둥쳐 ${damage} 피해를 주었다.`, 'damage'));
    executedMoves.push({ actorInstanceId: attacker.instanceId, targetInstanceId: defender.instanceId, moveId: -1,
      moveType: 'normal', damageClass: 'physical', damagingMove: true, executed: true, hit: true,
      typeMultiplier: 1, damage, category: 'damage', hpRecovered: 0, statStageDelta: 0, ailmentApplied: false, strategicEffect: false, result: 'struggle' });
    return;
  }
  const move = resolveTeraMove(combatant(attacker, battle), getMove(slot.moveId));
  if (attacker.heldTool?.startsWith('choice-')) (battle.choiceLocks ??= {})[attacker.instanceId] = move.id;
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
      failed = attacker.hp === effectiveStats(battle, attacker).hp || ['insomnia', 'vital-spirit', 'comatose'].includes(effectiveAbility(battle, attacker)?.slug ?? '');
      if (!failed) {
        hpRecovered = battleMonsterMaxHp(battle, attacker) - attacker.hp; attacker.hp = battleMonsterMaxHp(battle, attacker);
        attacker.status = 'sleep'; attacker.statusTurns = 3; ailmentApplied = true;
        events.push(event(battle, `${attacker.nickname}은(는) 잠들어 완전히 회복했다.`, 'status'));
      } else events.push(event(battle, `${move.name}을(를) 사용할 수 없었다.`, 'status'));
    } else if (move.id === 150) {
      events.push(event(battle, `${attacker.nickname}은(는) 튀어올랐다. 아무 일도 일어나지 않았다.`));
    } else {
      const side = battle.player.team.includes(attacker) ? battle.player : battle.enemy;
      for (const ally of side.team) {
        if (ally.hp <= 0 || !CURABLE_AILMENTS.has(ally.status ?? '')) continue;
        if (move.id === 215 && ally !== attacker && ['soundproof', 'good-as-gold'].includes(effectiveAbility(battle, ally)?.slug ?? '')) continue;
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

  let totalDamage = 0; let multiplier = 1; let activatedAbility: 'immunity' | 'absorb' | 'sturdy' | 'focus-sash' | undefined;
  const isOhko = [12, 32, 90].includes(move.id);
  let fixed = fixedMoveDamage(move.id, attacker, defender);
  if (move.id === 149) fixed = Math.max(1, Math.floor(attacker.level * (.5 + random(state))));
  const matchup = typeMultiplier(move.type, effectiveTypes(battle, defender));
  const immunity = abilityImmunity(effectiveAbility(battle, defender), move.type);
  if ((isOhko || fixed !== undefined) && immunity) { multiplier = 0; activatedAbility = immunity.heal ? 'absorb' : 'immunity'; }
  else if ((isOhko || fixed !== undefined) && matchup === 0) { multiplier = 0; events.push(event(battle, '타입 면역으로 효과가 없었다.')); }
  else if (isOhko && attacker.level < defender.level) events.push(event(battle, '상대의 레벨이 높아 일격필살이 통하지 않았다.'));
  else if (isOhko && hasSturdy(effectiveAbility(battle, defender))) { activatedAbility = 'sturdy'; }
  else if (isOhko && activeHeldTool(battle, defender) === 'focus-sash' && defender.hp === effectiveStats(battle, defender).hp) { activatedAbility = 'focus-sash'; totalDamage = Math.max(0, defender.hp - 1); defender.hp -= totalDamage; }
  else if (isOhko) { totalDamage = defender.hp; defender.hp = 0; multiplier = 1; }
  else if (fixed !== undefined) {
    const sturdy = hasSturdy(effectiveAbility(battle, defender)), sash = activeHeldTool(battle, defender) === 'focus-sash';
    const capped = (sturdy || sash) && defender.hp === effectiveStats(battle, defender).hp && fixed >= defender.hp ? defender.hp - 1 : fixed;
    if (capped !== fixed) activatedAbility = sturdy ? 'sturdy' : 'focus-sash';
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
    defender.hp = Math.min(battleMonsterMaxHp(battle, defender), defender.hp + Math.max(1, Math.floor(battleMonsterMaxHp(battle, defender) / 4)));
  }
  if (activatedAbility) {
    if (activatedAbility === 'focus-sash') (battle.consumedTools ??= []).push(defender.instanceId);
    const source = activatedAbility === 'focus-sash' ? '기합의띠' : monsterAbility(defender).name;
    const detail = activatedAbility === 'sturdy' || activatedAbility === 'focus-sash' ? '쓰러지지 않았다' : activatedAbility === 'absorb' ? '공격을 흡수해 회복했다' : '공격을 무효화했다';
    events.push(event(battle, `${defender.nickname}의 ${source}: ${detail}.`, 'status'));
  }
  if (move.power > 0 || fixed !== undefined || isOhko) {
    let text = `${attacker.nickname}의 ${move.name}! ${totalDamage} 피해.`;
    if (multiplier > 1) text += ' 효과가 굉장했다.'; if (multiplier === 0) text += ' 효과가 없다.'; else if (multiplier < 1) text += ' 효과가 별로였다.';
    events.push(event(battle, text, 'damage'));
  }

  if (move.drain && totalDamage > 0) {
    const amount = Math.max(1, Math.floor(totalDamage * Math.abs(move.drain) / 100));
    if (move.drain > 0) { const before = attacker.hp; attacker.hp = Math.min(battleMonsterMaxHp(battle, attacker), attacker.hp + amount); hpRecovered += attacker.hp - before; } else {
      const recoil = Math.min(attacker.hp, amount); attacker.hp -= recoil;
      growth.recoilDamage = attacker.hp > 0 ? Math.min(1e9, growth.recoilDamage + recoil) : 0;
    }
    events.push(event(battle, move.drain > 0 ? `${attacker.nickname}은(는) HP를 ${amount} 흡수했다.` : `${attacker.nickname}은(는) 반동으로 ${amount} 피해를 입었다.`, 'status'));
  }
  if (move.healing && move.healing > 0) {
    const amount = Math.max(1, Math.floor(battleMonsterMaxHp(battle, attacker) * move.healing / 100)); const before = attacker.hp; attacker.hp = Math.min(battleMonsterMaxHp(battle, attacker), attacker.hp + amount); hpRecovered += attacker.hp - before;
    events.push(event(battle, `${attacker.nickname}의 HP가 회복되었다.`, 'status'));
  }
  let clearedBinding = false;
  if (move.id === 499 && totalDamage > 0) {
    statStageDelta += clearStages(battle, defender);
    events.push(event(battle, `${defender.nickname}의 능력치 변화가 사라졌다.`, 'status'));
  }
  if (monsterUsesLifeOrb(attacker, totalDamage)) {
    const recoil = Math.max(1, Math.floor(battleMonsterMaxHp(battle, attacker) / 10));
    attacker.hp = Math.max(0, attacker.hp - recoil);
    events.push(event(battle, `${attacker.nickname}은(는) 생명의구슬 반동으로 ${recoil} 피해를 입었다.`, 'status'));
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
    const types = effectiveTypes(battle, ailmentTarget);
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
  if (monster.hp <= 0) return;
  if (['poison', 'burn', 'trap', 'leech-seed'].includes(monster.status ?? '')) {
    const damage = Math.max(1, Math.floor(battleMonsterMaxHp(battle, monster) / 8));
    monster.hp = Math.max(0, monster.hp - damage);
    events.push(event(battle, `${monster.nickname}은(는) ${monster.status}으로 ${damage} 피해를 입었다.`, 'status'));
    if (monster.status === 'trap') {
      monster.statusTurns = Math.max(0, (monster.statusTurns ?? 1) - 1);
      if (monster.statusTurns === 0) { monster.status = undefined; monster.statusTurns = undefined; }
    }
  }
  if (monster.hp > 0 && monster.heldTool === 'leftovers') {
    const before = monster.hp, amount = Math.max(1, Math.floor(battleMonsterMaxHp(battle, monster) / 16));
    monster.hp = Math.min(battleMonsterMaxHp(battle, monster), monster.hp + amount);
    if (monster.hp > before) events.push(event(battle, `${monster.nickname}은(는) 먹다남은음식으로 ${monster.hp - before} 회복했다.`, 'status'));
  }
}

function monsterUsesLifeOrb(monster: Monster, damage: number): boolean { return monster.heldTool === 'life-orb' && damage > 0 && monster.hp > 0; }

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
    const oldMax = battleMonsterMaxHp(battle, monster);
    monster.level++;
    const progress = evolutionProgress(monster); progress.friendship = Math.min(255, progress.friendship + 5);
    const profile = regionalProfile(monster);
    monster.stats = profile ? formStats(monster, profile) : statsFor(getSpecies(monster.speciesId), monster.level, individualValues(monster));
    const transformation = battle?.transformations?.[monster.instanceId];
    if (transformation?.kind === 'mega') transformation.stats = formStats(monster, getCombatForm(transformation.formIdentifier!)!);
    monster.hp += battleMonsterMaxHp(battle, monster) - oldMax;
    for (const learned of (profile?.levelUpMoves ?? getSpecies(monster.speciesId).moves).filter((entry) => entry.level === monster.level)) {
      learnMove(monster, learned.moveId);
    }
    if (events && battle) events.push(event(battle, `${monster.nickname}은(는) 레벨 ${monster.level}이 되었다.`, 'reward'));
  }
  const transformation = battle?.transformations?.[monster.instanceId];
  if (transformation?.kind === 'mega' || transformation?.kind === 'tera') {
    const profile = transformation.kind === 'mega' ? getCombatForm(transformation.formIdentifier!) : undefined;
    transformation.stats = profile ? formStats(monster, profile) : { ...monster.stats };
    transformation.moves = monster.moves.map(slot => ({ ...slot }));
  }
  return { instanceId: monster.instanceId, amount: applied, levelsGained: monster.level - levelBefore, shared };
}

function concludeIfNeeded(state: GameState, battle: BattleState, events: BattleLogEntry[], experienceGains: ExperienceGain[], result: BattleTurnResult): BattleTurnResult['outcome'] | undefined {
  if (!battle.player.team.some((monster) => monster.hp > 0)) {
    recoverAfterDefeat(state, result);
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
      endBattle(state, result);
      return 'won';
    }
  }
  const player = active(battle.player);
  if (player.hp <= 0) {
    const next = battle.player.team.findIndex((monster) => monster.hp > 0
      && (!battle.policyRegion || !monsterRegionalUseReason(state, battle.policyRegion, monster)));
    if (next >= 0) { battle.awaitingSwitch = 'player'; events.push(event(battle, '다음 포켓몬을 선택해야 한다.')); }
    else {
      recoverAfterDefeat(state, result);
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
  applyPreferredBattleTransformation(state);
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
    delete battle.choiceLocks?.[outgoing.instanceId];
    if (!battle.transformations?.[outgoing.instanceId]?.kind || battle.transformations[outgoing.instanceId]?.kind === 'transform') delete battle.transformations?.[outgoing.instanceId];
    battle.player.activeIndex = action.index; battle.awaitingSwitch = undefined;
    applyPreferredBattleTransformation(state);
    events.push(event(battle, `${target.nickname}, 부탁해!`));
    enemyActs(target);
  } else if (action.type === 'run') {
    if (!battle.canRun) throw new Error('이 전투에서는 도망칠 수 없습니다.');
    const player = active(battle.player); const enemy = active(battle.enemy);
    const chance = Math.min(.95, .45 + (player.stats.speed - enemy.stats.speed) / Math.max(1, enemy.stats.speed) * .3);
    if (random(state) < chance) { endBattle(state, result); events.push(event(battle, '무사히 도망쳤다.')); for (const entry of events) addLog(state, entry.text); result.battleEnded = true; result.outcome = 'escaped'; return result; }
    events.push(event(battle, '도망치지 못했다.')); enemyActs(player);
  } else if (action.type === 'catch') {
    if (battle.kind !== 'wild') throw new Error('야생 포켓몬만 잡을 수 있습니다.');
    normalizeBalls(state);
    const wild = active(battle.enemy); const species = getSpecies(wild.speciesId);
    const chance = catchProbability(wild.stats.hp, wild.hp, species.catchRate, 1, wild.status);
    if (random(state) < chance) {
      const captured = structuredClone(wild); captured.status = undefined; captured.statusTurns = undefined;
      const existing = allOwned(state).filter(candidate => candidate.speciesId === captured.speciesId && candidate.regionalForm === captured.regionalForm);
      if (state.player.team.length < 6) state.player.team.push(captured); else state.player.box.push(captured);
      state.dex.seen = uniqueSorted([...state.dex.seen, captured.speciesId]);
      recordCapture(state, captured.speciesId);
      endBattle(state, result);
      if (state.autoMergeDuplicates && existing.length) {
        const target = existing.find(candidate => state.player.team.includes(candidate)) ?? existing[0];
        if (target) mergeDuplicateMonsters(state, target.instanceId, [captured.instanceId]);
      }

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
  const outcome = concludeIfNeeded(state, battle, events, experienceGains, result);
  if (outcome) { result.battleEnded = true; result.outcome = outcome; }
  else battle.turn++;
  if (outcome === 'won' && battle.kind === 'gym' && battle.gymBadge) {
    result.gymVictory = { badge: battle.gymBadge, money: 1500 * battle.gymBadge, ...(battle.campaignRegion ? { region: battle.campaignRegion } : {}) };
  }
  for (const entry of events) addLog(state, entry.text);
  return result;
}

function recoverAfterDefeat(state: GameState, result: BattleTurnResult): void {
  endBattle(state, result);
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

function heldToolReturnCounts(monsters: readonly Monster[]): Map<EquippableItem, number> {
  const counts = new Map<EquippableItem, number>();
  for (const monster of monsters) if (monster.heldTool) counts.set(monster.heldTool, (counts.get(monster.heldTool) ?? 0) + 1);
  return counts;
}

function assertHeldToolsCanReturn(state: GameState, monsters: readonly Monster[]): Map<EquippableItem, number> {
  const counts = heldToolReturnCounts(monsters);
  for (const [tool, count] of counts) {
    if (state.inventory[tool] > 1_000_000_000 - count) throw new Error(`${ITEM_LABELS[tool]} 재고가 너무 많습니다.`);
  }
  return counts;
}

function returnHeldTools(state: GameState, counts: ReadonlyMap<EquippableItem, number>): void {
  for (const [tool, count] of counts) state.inventory[tool] += count;
}

export function isMonsterInBattle(state: GameState, instanceId: string): boolean {
  return Boolean(state.battle?.player.team.some(monster => monster.instanceId === instanceId));
}

export function setAutoMergeDuplicates(state: GameState, enabled: boolean): void {
  state.autoMergeDuplicates = enabled;
}

export function assignHeldTool(state: GameState, instanceId: string, tool?: EquippableItem): void {
  if (state.battle || state.captureOffer) throw new Error('전투와 포획 선택을 마친 뒤 도구를 바꿀 수 있습니다.');
  const monster = findOwned(state, instanceId);
  const stone = tool?.startsWith('mega-stone:') ? MEGA_STONES.find(item => item.id === tool) : undefined;
  if (tool !== undefined && !EQUIPPABLE_ITEMS.includes(tool)) throw new Error('장착할 수 없는 도구입니다.');
  if (stone && stone.speciesId !== monster.speciesId) throw new Error('이 포켓몬에게 맞지 않는 메가진화석입니다.');
  const previous = monster.heldTool;
  if (previous === tool) return;
  if (tool !== undefined && state.inventory[tool] <= 0) throw new Error(`${ITEM_LABELS[tool]} 재고가 없습니다.`);
  if (previous !== undefined && state.inventory[previous] >= 1_000_000_000) throw new Error('도구 재고가 너무 많습니다.');
  if (tool !== undefined) state.inventory[tool]--;
  if (previous !== undefined) state.inventory[previous]++;
  monster.heldTool = tool;
  if (monster.preferredTransformation?.kind === 'mega'
    && monster.heldTool !== megaStoneId(monster.preferredTransformation.formIdentifier)) delete monster.preferredTransformation;
}

export function assignMonsterAbility(state: GameState, instanceId: string, slot: number): MonsterAbility {
  if (state.battle || state.captureOffer) throw new Error('전투와 포획 선택을 마친 뒤 특성을 바꿀 수 있습니다.');
  if (!Number.isInteger(slot) || slot < 1 || slot > 3) throw new Error('특성 슬롯이 올바르지 않습니다.');
  const monster = findOwned(state, instanceId), ability = monsterAbilities(monster).find(candidate => candidate.slot === slot);
  if (!ability) throw new Error('이 포켓몬에게 없는 특성 슬롯입니다.');
  monster.ability = ability;
  return ability;
}

export function assignAlolaForm(state: GameState, instanceId: string, enabled: boolean): string | undefined {
  if (state.battle || state.captureOffer) throw new Error('전투와 포획 선택을 마친 뒤 모습을 바꿀 수 있습니다.');
  const monster = findOwned(state, instanceId), profile = getAlolaCombatForm(monster.speciesId);
  if (enabled && !profile) throw new Error('이 포켓몬은 알로라 모습이 없습니다.');
  const oldMax = monster.stats.hp, hpRatio = monster.hp / Math.max(1, oldMax);
  monster.regionalForm = enabled ? profile!.identifier : undefined;
  monster.stats = enabled ? formStats(monster, profile!) : statsFor(getSpecies(monster.speciesId), monster.level, individualValues(monster));
  monster.hp = Math.max(monster.hp > 0 ? 1 : 0, Math.min(monster.stats.hp, Math.round(monster.stats.hp * hpRatio)));
  monster.ability = enabled ? combatFormAbility(profile!) ?? monster.ability : abilityForSpecies(monster.speciesId, monster.ability?.slot ?? 1, monster.ability?.hidden);
  monster.moves = enabled ? formMoves(profile!, monster.level) : knownMoves(getSpecies(monster.speciesId), monster.level);
  reconcileMoveOrder(monster);
  normalizeMovePpReserve(monster);
  return monster.regionalForm;
}

export function activateBattleTransformation(state: GameState, kind: 'mega' | 'tera', option: { instanceId?: string; formIdentifier?: string; teraType?: PokemonType } = {}): BattleTransformation {
  const battle = state.battle;
  if (!battle) throw new Error('진행 중인 전투가 없습니다.');
  const monster = active(battle.player);
  if (monster.hp <= 0 || battle.awaitingSwitch) throw new Error('기절한 포켓몬은 변신할 수 없습니다.');
  if (option.instanceId && option.instanceId !== monster.instanceId) throw new Error('현재 전투 중인 포켓몬만 변신할 수 있습니다.');
  if (battle.transformations?.[monster.instanceId]) throw new Error('이미 전투 변신을 사용했습니다.');
  let transformation: BattleTransformation;
  if (kind === 'mega') {
    if (battle.playerMegaUsed) throw new Error('이 전투에서는 이미 메가진화를 사용했습니다.');
    const profile = getMegaCombatForm(monster.speciesId, option.formIdentifier);
    if (!profile || !getPokemonFormModelSource(profile.identifier)) throw new Error('메가진화할 수 없는 포켓몬입니다.');
    if (monster.heldTool !== megaStoneId(profile.identifier)) throw new Error('해당 메가진화석을 장착해야 합니다.');
    transformation = { kind, speciesId: monster.speciesId, formIdentifier: profile.identifier, types: [...profile.types], ability: combatFormAbility(profile), stats: formStats(monster, profile), moves: monster.moves.map(slot => ({ ...slot })), hpAdjusted: true };
    monster.hp = scaleHp(monster.hp, monster.stats.hp, transformation.stats.hp, true);
    battle.playerMegaUsed = true;
  } else {
    if (battle.playerTeraUsed) throw new Error('이 전투에서는 이미 테라스탈을 사용했습니다.');
    const teraType = option.teraType ?? effectiveTypes(battle, monster)[0];
    if (!['normal','fire','water','electric','grass','ice','fighting','poison','ground','flying','psychic','bug','rock','ghost','dragon','dark','steel','fairy'].includes(teraType)) throw new Error('테라 타입이 올바르지 않습니다.');
    transformation = { kind, speciesId: monster.speciesId, types: [teraType], teraType, stats: structuredClone(effectiveStats(battle, monster)), moves: structuredClone(monster.moves) };
    battle.playerTeraUsed = true;
  }
  battle.transformations ??= {};
  battle.transformations[monster.instanceId] = transformation;
  return transformation;
}

function preferredTransformationValid(monster: Monster, preference: PreferredTransformation): boolean {
  if (!preference || typeof preference !== 'object' || Array.isArray(preference)) return false;
  if (preference.kind === 'mega') {
    const profile = typeof preference.formIdentifier === 'string' && getMegaCombatForm(monster.speciesId, preference.formIdentifier);
    return Boolean(profile && getPokemonFormModelSource(profile.identifier)) && Object.keys(preference).every(key => key === 'kind' || key === 'formIdentifier');
  }
  return preference.kind === 'tera' && typeof preference.teraType === 'string' && Object.hasOwn(TYPE_EFFECTIVENESS, preference.teraType)
    && Object.keys(preference).every(key => key === 'kind' || key === 'teraType');
}

export function assignPreferredTransformation(state: GameState, instanceId: string, preference?: PreferredTransformation): void {
  if (state.battle || state.captureOffer) throw new Error('전투와 포획 선택을 마친 뒤 변신 설정을 바꿀 수 있습니다.');
  const monster = findOwned(state, instanceId);
  if (preference !== undefined && !preferredTransformationValid(monster, preference)) throw new Error('설정할 수 없는 변신입니다.');
  if (preference?.kind === 'mega') {
    const stone = megaStoneForSpecies(monster.speciesId, preference.formIdentifier)!;
    if (monster.heldTool !== stone.id) {
      if (state.inventory[stone.id] <= 0) throw new Error(`${stone.name} 재고가 없습니다.`);
      if (monster.heldTool !== undefined && state.inventory[monster.heldTool] >= 1_000_000_000) throw new Error('도구 재고가 너무 많습니다.');
      state.inventory[stone.id]--;
      if (monster.heldTool !== undefined) state.inventory[monster.heldTool]++;
      monster.heldTool = stone.id;
    }
  } else if (monster.heldTool?.startsWith('mega-stone:')) {
    if (state.inventory[monster.heldTool] >= 1_000_000_000) throw new Error('도구 재고가 너무 많습니다.');
    state.inventory[monster.heldTool]++;
    delete monster.heldTool;
  }
  monster.preferredTransformation = preference ? { ...preference } : undefined;
}

/** Resolve the saved setup before the entrant's first decision, without using a turn. */
export function applyPreferredBattleTransformation(state: GameState): void {
  const battle = state.battle;
  if (!battle || battle.awaitingSwitch) return;
  const monster = active(battle.player), preference = monster?.preferredTransformation;
  if (!monster || monster.hp <= 0 || !preference || battle.transformations?.[monster.instanceId]) return;
  if (preference.kind === 'mega' ? battle.playerMegaUsed : battle.playerTeraUsed) return;
  if (!preferredTransformationValid(monster, preference)) return;
  if (preference.kind === 'mega' && monster.heldTool !== megaStoneId(preference.formIdentifier)) return;
  activateBattleTransformation(state, preference.kind, preference);
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
    delete state.battle.choiceLocks?.[id];
  }
  if (state.battle.consumedTools) state.battle.consumedTools = state.battle.consumedTools.filter(id => !removedIds.has(id));
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
  const maxHp = battleMonsterMaxHp(state.battle, monster);
  if (monster.hp >= maxHp) throw new Error('이미 HP가 가득 찼습니다.');
  monster.hp = Math.min(maxHp, monster.hp + HEALING_ITEM_HP[item]); state.inventory[item]--;
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

export type EvolutionPurchaseQuote = { ready: boolean; requiredItem?: InventoryItem; missing: number; cost: number; affordable: boolean };

export function evolutionPurchaseQuote(state: GameState, monster: Monster, evolution: Evolution, supplied?: InventoryItem): EvolutionPurchaseQuote {
  const ready = evolutionRoute(state, monster, evolution, supplied);
  if (ready) return { ready: true, requiredItem: ready.item, missing: 0, cost: 0, affordable: true };
  if (isMonsterInBattle(state, monster.instanceId)) return { ready: false, missing: 0, cost: 0, affordable: false };
  let requiredItem: InventoryItem | undefined;
  if (supplied === 'evolution-catalyst') {
    if (needsSpecialEvolution(monster.speciesId, evolution) && monster.level >= specialEvolutionLevel(monster.speciesId, evolution.target)) requiredItem = supplied;
  } else {
    const candidates = monsterEvolutionItemsFor(monster, evolution, state);
    requiredItem = supplied && candidates.includes(supplied) ? supplied : supplied === undefined ? candidates[0] : undefined;
  }
  if (!requiredItem || !SHOP_ITEMS.includes(requiredItem)) return { ready: false, requiredItem, missing: 0, cost: 0, affordable: false };
  const stocked = { ...state, inventory: { ...state.inventory, [requiredItem]: Math.max(1, state.inventory[requiredItem]) } };
  if (!evolutionRoute(stocked, monster, evolution, supplied ?? requiredItem)) return { ready: false, requiredItem, missing: 0, cost: 0, affordable: false };
  const missing = Math.max(0, 1 - state.inventory[requiredItem]), cost = missing * ITEM_PRICES[requiredItem];
  return { ready: false, requiredItem, missing, cost, affordable: missing > 0 && state.player.money >= cost };
}

export function evolve(state: GameState, instanceId: string, option: { targetId?: number; item?: InventoryItem; autoBuyMissing?: boolean } = {}): Monster {
  const monster = findOwned(state, instanceId);
  if (isMonsterInBattle(state, instanceId)) throw new Error('전투 중에는 참가 포켓몬을 진화시킬 수 없습니다.');
  const evolutions = getSpecies(monster.speciesId).evolutions.filter((evolution) => option.targetId === undefined || evolution.target === option.targetId);
  let evolution = evolutions.find((candidate) => evolutionReady(state, monster, candidate, option.item));
  if (!evolution && option.autoBuyMissing) evolution = evolutions.find(candidate => evolutionPurchaseQuote(state, monster, candidate, option.item).affordable);
  if (!evolution) throw new Error('현재 조건으로 가능한 진화가 없습니다.');
  const heldStone = monster.heldTool?.startsWith('mega-stone:') ? MEGA_STONES.find(item => item.id === monster.heldTool) : undefined;
  const returnStone = heldStone && heldStone.speciesId !== evolution.target ? heldStone.id : undefined;
  if (returnStone && state.inventory[returnStone] >= 1_000_000_000) throw new Error(`${ITEM_LABELS[returnStone]} 재고가 너무 많습니다.`);
  const quote = evolutionPurchaseQuote(state, monster, evolution, option.item);
  if (!quote.ready && option.autoBuyMissing) {
    if (!quote.requiredItem || !quote.affordable || quote.missing !== 1) throw new Error('진화 도구를 구매할 수 없습니다.');
    state.player.money -= quote.cost; state.inventory[quote.requiredItem]++;
    addLog(state, `${ITEM_LABELS[quote.requiredItem]} 자동 구매 · ₩${quote.cost.toLocaleString('ko-KR')}`);
  }
  const route = evolutionRoute(state, monster, evolution, option.item)!;
  const requiredItem = route.item;
  if (requiredItem) state.inventory[requiredItem]--;
  if (returnStone) {
    state.inventory[returnStone]++;
    delete monster.heldTool;
    if (monster.preferredTransformation?.kind === 'mega') delete monster.preferredTransformation;
  }
  // Shedinja is a second individual: keep Nincada/Ninjask's identity and neural memory.
  if (route.shed) {
    const shed = createMonster(state, 292, monster.level, monster.originRegion);
    state.player.team.push(shed);
    const ninjask = getSpecies(monster.speciesId).evolutions.find(candidate => candidate.target === 291)!;
    applyEvolution(state, monster, ninjask);
    state.dex.seen = uniqueSorted([...state.dex.seen, 292]); recordCapture(state, 292);
    addLog(state, '남은 팀 자리에 껍질몬이 나타났다.'); return shed;
  }
  const leaveShell = monster.speciesId === 290 && evolution.target === 291
    && state.player.team.includes(monster) && state.player.team.length < 6 && state.inventory['poke-ball'] > 0;
  if (leaveShell) {
    const shed = createMonster(state, 292, monster.level, monster.originRegion);
    state.player.team.push(shed);
    state.dex.seen = uniqueSorted([...state.dex.seen, 292]); recordCapture(state, 292);
    addLog(state, '남은 팀 자리에 껍질몬이 나타났다.');
  }
  return applyEvolution(state, monster, evolution);
}

function applyEvolution(state: GameState, monster: Monster, evolution: Evolution): Monster {
  const before = getSpecies(monster.speciesId), after = getSpecies(evolution.target);
  const wasAlola = regionalProfile(monster)?.kind === 'alola';
  if (before.growthRate !== after.growthRate) {
    const floor = experienceAtLevel(monster.level, before.growthRate), ceiling = experienceAtLevel(monster.level + 1, before.growthRate);
    const progress = ceiling > floor ? (monster.xp - floor) / (ceiling - floor) : 0;
    const nextFloor = experienceAtLevel(monster.level, after.growthRate), nextCeiling = experienceAtLevel(monster.level + 1, after.growthRate);
    monster.xp = nextFloor + (nextCeiling > nextFloor ? Math.min(nextCeiling - nextFloor - 1, Math.floor((nextCeiling - nextFloor) * Math.max(0, Math.min(1, progress)))) : 0);
  }
  const oldMax = monster.stats.hp;
  const previousAbility = monsterAbility(monster);
  monster.speciesId = evolution.target; monster.nickname = getSpecies(evolution.target).name;
  if (monster.preferredTransformation && !preferredTransformationValid(monster, monster.preferredTransformation)) delete monster.preferredTransformation;
  const regionalTarget = state.evolutionContext?.regionId === 'alola' && [25, 102, 104].includes(before.id);
  const evolvedForm = wasAlola || regionalTarget ? getAlolaCombatForm(evolution.target) : undefined;
  monster.regionalForm = evolvedForm?.identifier;
  monster.ability = evolvedForm ? combatFormAbility(evolvedForm, previousAbility.slot) ?? combatFormAbility(evolvedForm)! : abilityForSpecies(evolution.target, previousAbility.slot, previousAbility.hidden);
  if (!isValidGender(monster.speciesId, monster.gender)) monster.gender = genderFor(monster.speciesId, monster.instanceId);
  evolutionProgress(monster).gender = monster.gender!;
  monster.stats = evolvedForm ? formStats(monster, evolvedForm) : statsFor(getSpecies(evolution.target), monster.level, individualValues(monster));
  monster.hp = Math.min(monster.stats.hp, monster.hp + monster.stats.hp - oldMax);
  for (const learned of evolvedForm ? formMoves(evolvedForm, monster.level) : knownMoves(getSpecies(evolution.target), monster.level)) {
    learnMove(monster, learned.moveId);
  }
  reconcileMoveOrder(monster);
  normalizeMovePpReserve(monster);
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

export function monsterEvolutionItemsFor(monster: Monster, evolution: Evolution, state?: GameState): InventoryItem[] {
  if (monster.regionalForm === 'sandshrew-alola' || monster.regionalForm === 'vulpix-alola') return ['ice-stone'];
  if (monster.regionalForm === 'meowth-alola' || monster.regionalForm === 'rattata-alola') return [];
  if (monster.speciesId === 27) return [];
  if (monster.speciesId === 37) return ['fire-stone'];
  const explicit = ITEM_EVOLUTION_RULES.find(rule => rule.from === monster.speciesId && rule.to === evolution.target)?.item;
  const source = state ? sourceEvolutionItemsForMonster(state, monster, evolution) : sourceEvolutionItems(monster.speciesId, evolution.target);
  const filteredSource = source.map(normalizeEvolutionItem).filter((item): item is InventoryItem => !!item);
  if (!state) return [...new Set([...(explicit ? [explicit] : []), ...filteredSource])];
  return evolutionFormSupported(state, monster, evolution) ? [...new Set([...(explicit ? [explicit] : []), ...filteredSource])] : [];
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
    'friendship-treat': '개체 친밀도 +20 · 걷기와 레벨업으로도 상승합니다.', 'beauty-treat': '개체 아름다움 +20', 'affection-treat': '개체 애정 +1' } as Partial<Record<InventoryItem, string>>)[item] ?? evolutionUses.get(item) ?? '';
}

export function evolutionRoute(state: GameState, monster: Monster, evolution: Evolution, supplied?: InventoryItem): { item?: InventoryItem; shed?: boolean } | undefined {
  if (isMonsterInBattle(state, monster.instanceId)) return undefined;
  if (monster.speciesId === 104 && state.evolutionContext?.regionId === 'alola') {
    if (monster.level < 28) return undefined;
    if (supplied === 'evolution-catalyst') return state.inventory[supplied] > 0 ? { item: supplied } : undefined;
    return supplied === undefined && state.evolutionContext.period === 'night' ? {} : undefined;
  }
  if (monster.regionalForm === 'sandshrew-alola' || monster.regionalForm === 'vulpix-alola') {
    return (supplied === undefined || supplied === 'ice-stone') && state.inventory['ice-stone'] > 0 ? { item: 'ice-stone' } : undefined;
  }
  if (monster.regionalForm === 'meowth-alola' || monster.regionalForm === 'rattata-alola') {
    if (supplied === 'evolution-catalyst') return state.inventory[supplied] > 0 && (monster.speciesId !== 19 || monster.level >= 20) ? { item: supplied } : undefined;
    if (supplied !== undefined) return undefined;
    return monster.speciesId === 52 ? evolutionProgress(monster).friendship >= 160 ? {} : undefined
      : monster.level >= 20 && state.evolutionContext?.period === 'night' ? {} : undefined;
  }
  if (supplied === 'evolution-catalyst') return evolutionFormSupported(state, monster, evolution) && needsSpecialEvolution(monster.speciesId, evolution)
    && monster.level >= specialEvolutionLevel(monster.speciesId, evolution.target) && state.inventory[supplied] > 0 ? { item: supplied } : undefined;
  if (supplied === undefined) {
    const natural = naturalEvolution(state, monster, evolution);
    if (natural) return natural.trigger === 4 ? { shed: true } : {};
    // Compatibility for authored data without a source row. Source-backed rows never bypass predicates.
    if (!sourceEvolutionRules(monster.speciesId, evolution.target).length && evolution.method === 'level' && monster.level >= (evolution.level ?? 1)) return {};
  }
  const item = monsterEvolutionItemsFor(monster, evolution, state).find(item => state.inventory[item] > 0 && (supplied === undefined || item === supplied));
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
    delete state.battle.choiceLocks?.[monster.instanceId];
    if (state.battle.consumedTools) state.battle.consumedTools = state.battle.consumedTools.filter(id => id !== monster.instanceId);
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

/** Legacy schema bounds retained while basic balls are unlimited. */
export const BALL_REFILL_INTERVAL = 30;
export const BALL_REFILL_CAP = 20;
/** Validate finite legacy stock/progress without accumulating or persisting Infinity. */
export function replenishBalls(state: GameState, elapsedSeconds: number): number {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > 5) throw new Error('보충 시간이 올바르지 않습니다.');
  normalizeBalls(state); state.ballRefillSeconds = 0; return 0;
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
  const returnedTools = assertHeldToolsCanReturn(state, [monster]);
  returnHeldTools(state, returnedTools);
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
  if (donors.some(donor => donor.speciesId !== target.speciesId || donor.regionalForm !== target.regionalForm)) throw new Error('같은 종과 모습끼리 합칠 수 있습니다.');
  battleRemovalActiveId(state, new Set(donorIds));
  const donorLevels = donors.reduce((sum, donor) => sum + donor.level, 0);
  const highestDonorLevel = Math.max(...donors.map(donor => donor.level));
  const baselineLevel = Math.max(target.level, highestDonorLevel);
  const bonusLevels = Math.max(1, Math.floor(duplicateMergeValue({ level: baselineLevel }).levels));
  const uncappedToLevel = baselineLevel + bonusLevels, toLevel = Math.min(100, uncappedToLevel);
  const gainedLevels = toLevel - target.level, totalLevels = gainedLevels;
  const growth = getSpecies(target.speciesId).growthRate;
  const startXp = experienceAtLevel(target.level, growth), nextXp = experienceAtLevel(Math.min(100, target.level + 1), growth);
  const progress = target.level >= 100 ? 0 : Math.max(0, Math.min(1, (target.xp - startXp) / (nextXp - startXp)));
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
  const donors = plan.donorIds.map(id => findOwned(state, id));
  const returnedTools = assertHeldToolsCanReturn(state, donors);
  const activeId = battleRemovalActiveId(state, ids);
  const team = state.player.team.filter(monster => !ids.has(monster.instanceId));
  const box = state.player.box.filter(monster => !ids.has(monster.instanceId) && (!plan.movesToTeam || monster !== target));
  if (plan.movesToTeam) team.push(target);
  // Stage growth before any collection mutation; keep the original neural objects intact.
  const grown: Monster = { ...target, evolutionProgress: structuredClone(evolutionProgress(target)), moves: structuredClone(target.moves), moveOrder: target.moveOrder?.slice(), movePpReserve: structuredClone(target.movePpReserve) };
  gainExperience(grown, plan.gainedXp);
  Object.assign(target, { xp: grown.xp, level: grown.level, stats: grown.stats, hp: grown.hp,
    moves: grown.moves, moveOrder: grown.moveOrder, movePpReserve: grown.movePpReserve, evolutionProgress: grown.evolutionProgress });
  returnHeldTools(state, returnedTools);
  state.player.team = team; state.player.box = box;
  reconcileBattleRemoval(state, ids, activeId);
  addLog(state, `${target.nickname} · ${plan.count}마리 합치기 · Lv.${plan.toLevel}`);
  return plan;
}

export type CollectionMergeGroup = ReturnType<typeof previewDuplicateMerge> & { speciesId: number; targetId: string };
export type CollectionMergePlan = { groups: CollectionMergeGroup[]; totalDonors: number; totalGainedLevels: number };

export function previewCollectionMerge(state: GameState, policyRegion?: CampaignRegion, preferredTargetId?: string): CollectionMergePlan {
  if (state.captureOffer) throw new Error('포획 선택을 마친 뒤 합칠 수 있습니다.');
  if (state.battle) throw new Error('전투를 마친 뒤 컬렉션 전체를 합칠 수 있습니다.');
  const bySpecies = new Map<string, Monster[]>();
  for (const monster of allOwned(state)) {
    const key = `${monster.speciesId}:${monster.regionalForm ?? ''}`;
    const group = bySpecies.get(key) ?? [];
    group.push(monster); bySpecies.set(key, group);
  }
  const groups: CollectionMergeGroup[] = [];
  for (const monsters of bySpecies.values()) {
    const speciesId = monsters[0].speciesId;
    if (monsters.length < 2) continue;
    const preferred = monsters.find(monster => monster.instanceId === preferredTargetId);
    const target = preferred ?? monsters.find(monster => state.player.team.includes(monster)) ?? monsters[0];
    const donorIds = monsters.filter(monster => monster !== target).map(monster => monster.instanceId);
    groups.push({ speciesId, targetId: target.instanceId, ...previewDuplicateMerge(state, target.instanceId, donorIds, policyRegion) });
  }
  return { groups, totalDonors: groups.reduce((sum, group) => sum + group.count, 0), totalGainedLevels: groups.reduce((sum, group) => sum + group.gainedLevels, 0) };
}

export function mergeCollectionDuplicates(state: GameState, plan: CollectionMergePlan, policyRegion?: CampaignRegion): CollectionMergePlan {
  const allDonors: Monster[] = [], involvedIds = new Set<string>();
  for (const group of plan.groups) {
    if (involvedIds.has(group.targetId) || group.donorIds.some(id => involvedIds.has(id))) throw new Error('합치기 대상이 중복되었습니다. 다시 확인해 주세요.');
    involvedIds.add(group.targetId); for (const id of group.donorIds) involvedIds.add(id);
    const current = previewDuplicateMerge(state, group.targetId, group.donorIds, policyRegion);
    if (group.speciesId !== findOwned(state, group.targetId).speciesId || current.gainedXp !== group.gainedXp || current.toLevel !== group.toLevel) throw new Error('합치기 대상이 변경되었습니다. 다시 확인해 주세요.');
    allDonors.push(...group.donorIds.map(id => findOwned(state, id)));
  }
  assertHeldToolsCanReturn(state, allDonors);
  for (const group of plan.groups) mergeDuplicateMonsters(state, group.targetId, group.donorIds, policyRegion);
  return plan;
}

export function serializeGame(state: GameState): string { assertPlayable(state); return JSON.stringify(state); }

export function restoreGame(json: string): GameState {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('저장 JSON을 읽을 수 없습니다.'); }
  return validateGame(value);
}

/** Engineered victory rule: the unlimited basic ball guarantees this defeated individual. */
export function captureDefeatedWild(state: GameState, ball: BallItem): boolean {
  if (!['poke-ball', 'great-ball', 'ultra-ball'].includes(ball)) return false;
  normalizeBalls(state); ball = 'poke-ball';
  const monster = state.captureOffer;
  if (!monster || state.battle || !['poke-ball', 'great-ball', 'ultra-ball'].includes(ball) || (state.player.team.length >= 6 && state.player.box.length >= 10000)) return false;
  const existing = allOwned(state).filter(candidate => candidate.speciesId === monster.speciesId && candidate.regionalForm === monster.regionalForm);
  monster.hp = Math.max(1, monster.hp); monster.status = undefined; monster.statusTurns = undefined;
  if (state.player.team.length < 6) state.player.team.push(monster); else state.player.box.push(monster);
  state.dex.seen = uniqueSorted([...state.dex.seen, monster.speciesId]);
  recordCapture(state, monster.speciesId);
  state.captureOffer = undefined;
  if (state.autoMergeDuplicates && existing.length) {
    const target = existing.find(candidate => state.player.team.includes(candidate)) ?? existing[0];
    if (target) mergeDuplicateMonsters(state, target.instanceId, [monster.instanceId]);
  }
  addLog(state, `${monster.nickname} 포획 성공! 무한 ${ITEM_LABELS[ball]}을 사용했다.`);
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
  if (state.autoMergeDuplicates !== undefined && typeof state.autoMergeDuplicates !== 'boolean') throw new Error('자동 합치기 설정이 손상되었습니다.');
  state.autoMergeDuplicates ??= false;
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
  for (const tool of HELD_TOOLS) if (!Object.hasOwn(state.inventory, tool)) state.inventory[tool] = 0;
  for (const stone of MEGA_STONES) if (!Object.hasOwn(state.inventory, stone.id)) state.inventory[stone.id] = 0;
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
    const heldStone = monster.heldTool?.startsWith('mega-stone:') ? MEGA_STONES.find(item => item.id === monster.heldTool) : undefined;
    if (monster.heldTool !== undefined && !EQUIPPABLE_ITEMS.includes(monster.heldTool)
      || heldStone !== undefined && heldStone.speciesId !== monster.speciesId) throw new Error('장착 도구가 잘못되었습니다.');
    if (monster.preferredTransformation !== undefined && !preferredTransformationValid(monster, monster.preferredTransformation)) throw new Error('자동 변신 설정이 잘못되었습니다.');
    if (monster.preferredTransformation?.kind === 'mega'
      && monster.heldTool !== megaStoneId(monster.preferredTransformation.formIdentifier)) delete monster.preferredTransformation;
    let form: PokemonCombatFormProfile | undefined;
    if (monster.regionalForm !== undefined) {
      form = getCombatForm(monster.regionalForm);
      if (!form || form.kind !== 'alola' || form.speciesId !== monster.speciesId) throw new Error('지역 모습이 원본 종과 맞지 않습니다.');
    }
    const savedAbility = monster.ability!;
    const formAbility = form && combatFormAbility(form, savedAbility.slot);
    const currentAbility = formAbility && savedAbility.id === formAbility.id && savedAbility.slot === formAbility.slot
      && savedAbility.hidden === formAbility.hidden && savedAbility.slug === formAbility.slug
      ? formAbility : form ? undefined : canonicalAbility(monster.ability, monster.speciesId);
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
    const expectedStats = form ? formStats(monster, form) : statsFor(species, monster.level, monster.ivs);
    const transformation = state.battle?.transformations?.[monster.instanceId];
    const battleMember = state.player.team.includes(monster) || state.battle?.enemy.team.includes(monster);
    const mega = battleMember && transformation?.kind === 'mega' && transformation.hpAdjusted === true && getMegaCombatForm(monster.speciesId, transformation.formIdentifier);
    const maxHp = mega && getPokemonFormModelSource(mega.identifier) ? formStats(monster, mega).hp : expectedStats.hp;
    if (!monster.stats || (Object.keys(expectedStats) as (keyof MonsterStats)[]).some((key) => monster.stats[key] !== expectedStats[key]) || !Number.isFinite(monster.hp) || monster.hp < 0 || monster.hp > maxHp) throw new Error('능력치/HP가 잘못되었습니다.');
    if (!Array.isArray(monster.moves) || monster.moves.length > 4) throw new Error('기술 데이터가 잘못되었습니다.');
    for (const slot of monster.moves) { const move = getMove(slot.moveId); if (!Number.isInteger(slot.pp) || slot.pp < 0 || slot.pp > move.pp) throw new Error('PP가 잘못되었습니다.'); }
    const knownMoveIds = new Set(monster.moves.map((slot) => slot.moveId));
    if (monster.moveOrder !== undefined) {
      if (!Array.isArray(monster.moveOrder) || monster.moveOrder.length > 4 || monster.moveOrder.length !== new Set(monster.moveOrder).size || monster.moveOrder.some((moveId) => !Number.isSafeInteger(moveId) || !knownMoveIds.has(moveId))) throw new Error('기술 배치가 잘못되었습니다.');
    }
    normalizeMovePpReserve(monster);
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
        else if (!owned.ability || member.ability.id !== owned.ability.id || member.ability.slot !== owned.ability.slot
          || member.ability.hidden !== owned.ability.hidden || member.ability.slug !== owned.ability.slug) throw new Error('전투 특성이 소유 개체 데이터와 맞지 않습니다.');
        else member.ability = structuredClone(owned.ability);
        member.heldTool = owned.heldTool;
        member.preferredTransformation = owned.preferredTransformation
          ? structuredClone(owned.preferredTransformation) : undefined;
        member.regionalForm = owned.regionalForm;
        normalizeMovePpReserve(member);
        if (member.evolutionProgress) member.evolutionProgress.gender = member.gender!;
      }
    }
    const canonicalTeam = (team: Monster[]) => JSON.stringify(team, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    if (!Array.isArray(battle.player.team) || canonicalTeam(battle.player.team) !== canonicalTeam(state.player.team)) throw new Error('전투 팀과 플레이어 팀이 일치하지 않습니다.');
    if (battle.awaitingSwitch !== undefined && battle.awaitingSwitch !== 'player') throw new Error('강제 교체 상태가 손상되었습니다.');
    const activePlayer = state.player.team[battle.player.activeIndex];
    if ((activePlayer.hp === 0) !== (battle.awaitingSwitch === 'player') && state.player.team.some((monster) => monster.hp > 0)) throw new Error('강제 교체 대상이 일치하지 않습니다.');
    const battleIds = new Set([...state.player.team, ...battle.enemy.team].map((monster) => monster.instanceId));
    if (battle.choiceLocks !== undefined) {
      if (!battle.choiceLocks || typeof battle.choiceLocks !== 'object' || Array.isArray(battle.choiceLocks)) throw new Error('도구의 기술 고정 기록이 손상되었습니다.');
      for (const [id, moveId] of Object.entries(battle.choiceLocks)) {
        const monster = [...state.player.team, ...battle.enemy.team].find(monster => monster.instanceId === id);
        if (!monster?.heldTool?.startsWith('choice-') || !Number.isSafeInteger(moveId)) throw new Error('도구의 기술 고정 기록이 손상되었습니다.');
        getMove(moveId);
      }
    }
    if (battle.consumedTools !== undefined && (!Array.isArray(battle.consumedTools) || new Set(battle.consumedTools).size !== battle.consumedTools.length
      || battle.consumedTools.some(id => !battleIds.has(id) || [...state.player.team, ...battle.enemy.team].find(monster => monster.instanceId === id)?.heldTool !== 'focus-sash'))) throw new Error('소모 도구 기록이 손상되었습니다.');
    if (battle.statStages) for (const [instanceId, stages] of Object.entries(battle.statStages)) {
      if (!battleIds.has(instanceId) || !stages || Object.entries(stages).some(([stat, stage]) => !['attack', 'defense', 'specialAttack', 'specialDefense', 'speed', 'accuracy', 'evasion'].includes(stat) || !Number.isInteger(stage) || stage < -6 || stage > 6)) throw new Error('능력 단계가 손상되었습니다.');
    }
    if (battle.transformations) for (const [instanceId, form] of Object.entries(battle.transformations)) {
      if (!battleIds.has(instanceId) || !form || !Number.isInteger(form.speciesId) || !form.stats || !Array.isArray(form.moves) || form.moves.length > 4) throw new Error('변신 상태가 손상되었습니다.');
      getSpecies(form.speciesId);
      if (form.kind !== undefined && !['transform', 'mega', 'tera'].includes(form.kind)) throw new Error('변신 종류가 손상되었습니다.');
      if (form.hpAdjusted !== undefined && (form.kind !== 'mega' || form.hpAdjusted !== true)) throw new Error('변신 HP 기록이 손상되었습니다.');
      if (form.types !== undefined && (!Array.isArray(form.types) || !form.types.length || form.types.length > 2 || form.types.some(type => !['normal','fire','water','electric','grass','ice','fighting','poison','ground','flying','psychic','bug','rock','ghost','dragon','dark','steel','fairy'].includes(type)))) throw new Error('변신 타입이 손상되었습니다.');
      const source = [...state.player.team, ...battle.enemy.team].find(monster => monster.instanceId === instanceId)!;
      if (form.kind === 'mega' || form.kind === 'tera') {
        if (form.speciesId !== source.speciesId || JSON.stringify(form.moves) !== JSON.stringify(source.moves)) throw new Error('전투 변신 원본 기술이 일치하지 않습니다.');
        if (state.player.team.includes(source) && !(form.kind === 'mega' ? battle.playerMegaUsed : battle.playerTeraUsed)) throw new Error('전투 변신 사용 기록이 손상되었습니다.');
        if (form.kind === 'tera' && (form.ability !== undefined || form.formIdentifier !== undefined || JSON.stringify(form.stats) !== JSON.stringify(source.stats))) throw new Error('테라스탈 능력치가 손상되었습니다.');
      }
      if (form.kind === 'mega') {
        const profile = form.formIdentifier && getMegaCombatForm(form.speciesId, form.formIdentifier);
        if (profile && !getPokemonFormModelSource(profile.identifier)) {
          delete battle.transformations[instanceId];
          continue;
        }
        const source = [...state.player.team, ...battle.enemy.team].find(monster => monster.instanceId === instanceId);
        if (!profile || !source || profile.identifier !== form.formIdentifier || JSON.stringify(form.types) !== JSON.stringify(profile.types)) throw new Error('메가진화 모습이 손상되었습니다.');
        const expected = formStats(source, profile), expectedAbility = combatFormAbility(profile);
        if ((Object.keys(expected) as (keyof MonsterStats)[]).some(key => form.stats[key] !== expected[key])
          || (expectedAbility && (!form.ability || form.ability.id !== expectedAbility.id || form.ability.slug !== expectedAbility.slug))) throw new Error('메가진화 능력치/특성이 손상되었습니다.');
        if (form.hpAdjusted === undefined) {
          source.hp = scaleHp(source.hp, source.stats.hp, expected.hp, true);
          form.hpAdjusted = true;
        }
      }
      if (form.kind === 'tera' && (!form.teraType || form.types?.length !== 1 || form.types[0] !== form.teraType)) throw new Error('테라스탈 타입이 손상되었습니다.');
      if ((Object.values(form.stats) as unknown[]).some((stat) => !Number.isFinite(stat) || (stat as number) <= 0 || (stat as number) > 10000)) throw new Error('변신 능력치가 손상되었습니다.');
      for (const slot of form.moves) { const move = getMove(slot.moveId); if (!Number.isInteger(slot.pp) || slot.pp < 0 || slot.pp > (form.kind === 'mega' || form.kind === 'tera' ? move.pp : Math.min(5, move.pp))) throw new Error('변신 기술 PP가 손상되었습니다.'); }
    }
    if (battle.playerMegaUsed !== undefined && typeof battle.playerMegaUsed !== 'boolean') throw new Error('메가진화 사용 기록이 손상되었습니다.');
    if (battle.playerTeraUsed !== undefined && typeof battle.playerTeraUsed !== 'boolean') throw new Error('테라스탈 사용 기록이 손상되었습니다.');
    battle.player.team = state.player.team;
  }

  applyPreferredBattleTransformation(state);
  return state;
}

function assertPlayable(state: GameState): void {
  if (state.schemaVersion !== SAVE_SCHEMA_VERSION) throw new Error('게임 저장 스키마가 일치하지 않습니다.');
}
