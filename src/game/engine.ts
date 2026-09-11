import { Brain, type BrainState } from '../core/brain';
import { getMove, getSpecies, POKEMON } from '../data/pokemon';
import type { BaseStats, Evolution, PokemonMove, PokemonSpecies, PokemonType } from './contracts';
import { calculateDamage, catchProbability, turnOrder, typeMultiplier } from './battle';
import { getRegion, REGIONS } from './regions';

export const SAVE_SCHEMA_VERSION = 2 as const;
export type BallItem = 'poke-ball' | 'great-ball' | 'ultra-ball';
export type InventoryItem = BallItem | 'potion' | 'super-potion' | 'rare-candy' | 'fire-stone' | 'water-stone' | 'thunder-stone' | 'leaf-stone' | 'moon-stone' | 'link-cable';
export type BattleKind = 'wild' | 'gym' | 'champion';

export type MonsterStats = BaseStats;
export type MonsterMove = { moveId: number; pp: number };
export type Monster = {
  instanceId: string;
  speciesId: number;
  nickname: string;
  level: number;
  xp: number;
  hp: number;
  stats: MonsterStats;
  moves: MonsterMove[];
  status?: string;
  statusTurns?: number;
  brain?: BrainState;
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
  awaitingSwitch?: 'player';
  gymBadge?: number;
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
  result: 'hit' | 'missed' | 'immune' | 'failed' | 'status' | 'struggle';
};
export type ExperienceGain = { instanceId: string; amount: number; levelsGained: number; shared: boolean };
export type BattleTurnResult = {
  battleEnded: boolean;
  outcome?: 'won' | 'lost' | 'caught' | 'escaped';
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
  inventory: Record<InventoryItem, number>;
  dex: { seen: number[]; caught: number[] };
  regionId: string;
  defeatedGyms: number[];
  championDefeated: boolean;
  /** Undefined in legacy schema-v2 saves is migrated to enabled by validateGame. */
  experienceShare?: boolean;
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
};
export const ITEM_LABELS: Readonly<Record<InventoryItem, string>> = {
  'poke-ball': '몬스터볼', 'great-ball': '슈퍼볼', 'ultra-ball': '하이퍼볼',
  potion: '상처약', 'super-potion': '좋은상처약', 'rare-candy': '이상한사탕',
  'fire-stone': '불꽃의돌', 'water-stone': '물의돌', 'thunder-stone': '천둥의돌',
  'leaf-stone': '리프의돌', 'moon-stone': '달의돌', 'link-cable': '연결의끈',
};
const BALL_MULTIPLIER: Record<BallItem, number> = { 'poke-ball': 1, 'great-ball': 1.5, 'ultra-ball': 2 };
const INVENTORY_ITEMS = Object.keys(ITEM_PRICES) as InventoryItem[];

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

export function statsFor(species: PokemonSpecies, level: number): MonsterStats {
  const stat = (base: number) => Math.floor(2 * base * level / 100) + 5;
  return {
    hp: Math.floor(2 * species.baseStats.hp * level / 100) + level + 10,
    attack: stat(species.baseStats.attack), defense: stat(species.baseStats.defense),
    specialAttack: stat(species.baseStats.specialAttack), specialDefense: stat(species.baseStats.specialDefense),
    speed: stat(species.baseStats.speed),
  };
}

export function experienceAtLevel(level: number, growthRate: string): number {
  const n = Math.max(1, Math.min(100, level));
  const rate = growthRate.toLowerCase();
  if (rate === 'fast') return Math.floor(4 * n ** 3 / 5);
  if (rate === 'slow') return Math.floor(5 * n ** 3 / 4);
  if (rate === 'medium-slow') return Math.max(0, Math.floor(6 * n ** 3 / 5 - 15 * n ** 2 + 100 * n - 140));
  // Medium and unknown source labels use the documented cubic baseline.
  return n ** 3;
}

function knownMoves(species: PokemonSpecies, level: number): MonsterMove[] {
  const learned = species.moves
    .filter((entry) => entry.level <= level)
    .sort((a, b) => a.level - b.level)
    .filter((entry, index, entries) => entries.findIndex((other) => other.moveId === entry.moveId) === index)
    .slice(-4);
  return learned.map(({ moveId }) => ({ moveId, pp: getMove(moveId).pp }));
}

export function createMonster(state: Pick<GameState, 'nextInstanceId'>, speciesId: number, level: number): Monster {
  const species = getSpecies(speciesId);
  const normalizedLevel = Math.max(1, Math.min(100, Math.floor(level)));
  const stats = statsFor(species, normalizedLevel);
  return {
    instanceId: `mon-${state.nextInstanceId++}`,
    speciesId,
    nickname: species.name,
    level: normalizedLevel,
    xp: experienceAtLevel(normalizedLevel, species.growthRate),
    hp: stats.hp,
    stats,
    moves: knownMoves(species, normalizedLevel),
  };
}

export function createGame(starterId: 1 | 4 | 7, seed: number | string): GameState {
  if (![1, 4, 7].includes(starterId)) throw new Error('스타터는 1, 4, 7 중 하나여야 합니다.');
  if (POKEMON.length !== 151) throw new Error(`151종 데이터가 필요합니다. 현재 ${POKEMON.length}종입니다.`);
  const state: GameState = {
    schemaVersion: SAVE_SCHEMA_VERSION,
    seed: String(seed), rngState: hashSeed(seed), nextInstanceId: 1,
    player: { money: 3000, badges: 0, team: [], box: [] },
    inventory: {
      'poke-ball': 8, 'great-ball': 0, 'ultra-ball': 0, potion: 3, 'super-potion': 0,
      'rare-candy': 0, 'fire-stone': 0, 'water-stone': 0, 'thunder-stone': 0,
      'leaf-stone': 0, 'moon-stone': 0, 'link-cable': 0,
    },
    dex: { seen: [starterId], caught: [starterId] }, regionId: REGIONS[0].id,
    defeatedGyms: [], championDefeated: false, experienceShare: true, logs: [],
  };
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
    const wild = createMonster(state, speciesId, encounterLevel(state, region.minBadges, speciesId));
    state.dex.seen = uniqueSorted([...state.dex.seen, speciesId]);
    state.battle = {
      kind: 'wild', regionId, player: { team: state.player.team, activeIndex: firstHealthy(state.player.team) },
      enemy: { team: [wild], activeIndex: 0 }, turn: 1, canRun: true,
    };
    const text = `야생 ${getSpecies(speciesId).name}이(가) 나타났다.`;
    addLog(state, text);
    return { kind: 'encounter', speciesId, amount: 1, text };
  }
  if (roll < .88) {
    const available: InventoryItem[] = ['poke-ball', 'potion', 'rare-candy'];
    if (state.player.badges >= 3) available.push('great-ball', 'super-potion');
    if (state.player.badges >= 6) available.push('ultra-ball');
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
  if (state.battle) throw new Error('이미 전투 중입니다.');
  const region = getRegion(regionId);
  if (!region.gym) throw new Error('이 지역에는 체육관이 없습니다.');
  if (state.defeatedGyms.includes(region.gym.badge)) throw new Error('이미 이긴 체육관입니다.');
  if (region.gym.badge !== state.player.badges + 1) throw new Error('체육관은 순서대로 도전해야 합니다.');
  if (state.player.badges < region.minBadges) throw new Error(`배지 ${region.minBadges}개가 필요합니다.`);
  state.regionId = regionId;
  const enemy = createMonster(state, region.gym.speciesId, region.gym.level);
  state.battle = { kind: 'gym', regionId, player: { team: state.player.team, activeIndex: firstHealthy(state.player.team) }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: false, gymBadge: region.gym.badge };
  addLog(state, `${region.gym.leader}에게 도전했다.`);
  return state.battle;
}

export function challengeChampion(state: GameState): BattleState {
  assertPlayable(state);
  if (state.battle) throw new Error('이미 전투 중입니다.');
  if (state.player.badges < 8) throw new Error('챔피언 도전에는 배지 8개가 필요합니다.');
  if (state.championDefeated) throw new Error('이미 챔피언을 이겼습니다.');
  const enemy = [149, 143, 131, 130, 65, 68].map((id, index) => createMonster(state, id, 72 + index));
  state.dex.seen = uniqueSorted([...state.dex.seen, ...enemy.map((monster) => monster.speciesId)]);
  state.battle = { kind: 'champion', regionId: 'pokemon-league', player: { team: state.player.team, activeIndex: firstHealthy(state.player.team) }, enemy: { team: enemy, activeIndex: 0 }, turn: 1, canRun: false };
  addLog(state, '챔피언에게 도전했다.');
  return state.battle;
}

function firstHealthy(team: Monster[]): number {
  const index = team.findIndex((monster) => monster.hp > 0);
  if (index < 0) throw new Error('싸울 수 있는 포켓몬이 없습니다. 치료소를 이용하세요.');
  return index;
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
  }, types: getSpecies(effectiveSpeciesId(battle, monster)).types, status: monster.status };
}

function validMoveIndexes(monster: Monster, battle: BattleState): number[] {
  return effectiveMoves(battle, monster).map((move, index) => move.pp > 0 ? index : -1).filter((index) => index >= 0);
}

function circularMoveIndex(monster: Monster, battle: BattleState, requested: number): number {
  const moves = effectiveMoves(battle, monster); const count = moves.length;
  if (!count) return -1;
  const start = ((Math.floor(requested) % count) + count) % count;
  for (let offset = 0; offset < count; offset++) {
    const index = (start + offset) % count;
    if (moves[index].pp > 0) return index;
  }
  return -1;
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
  if (!slot || slot.pp <= 0) {
    const damage = Math.max(1, Math.floor(defender.stats.hp / 8)); defender.hp = Math.max(0, defender.hp - damage);
    attacker.hp = Math.max(0, attacker.hp - Math.max(1, Math.floor(attacker.stats.hp / 4)));
    events.push(event(battle, `${attacker.nickname}은(는) 발버둥쳐 ${damage} 피해를 주었다.`, 'damage'));
    executedMoves.push({ actorInstanceId: attacker.instanceId, targetInstanceId: defender.instanceId, moveId: -1,
      moveType: 'normal', damageClass: 'physical', damagingMove: true, executed: true, hit: true,
      typeMultiplier: 1, damage, result: 'struggle' });
    return;
  }
  slot.pp--; const move = getMove(slot.moveId);
  const damagingMove = move.damageClass !== 'status' && (move.power > 0 || fixedMoveDamage(move.id, attacker, defender) !== undefined || [12, 32, 90].includes(move.id));
  const attackerStages = battle.statStages?.[attacker.instanceId] ?? {}; const defenderStages = battle.statStages?.[defender.instanceId] ?? {};
  const accuracy = move.accuracy * stageMultiplier(attackerStages.accuracy) / stageMultiplier(defenderStages.evasion);
  if (move.accuracy > 0 && random(state) * 100 >= accuracy) {
    events.push(event(battle, `${attacker.nickname}의 ${move.name}은(는) 빗나갔다.`));
    executedMoves.push({ actorInstanceId: attacker.instanceId, targetInstanceId: defender.instanceId,
      moveId: move.id, moveType: move.type, damageClass: move.damageClass, damagingMove,
      executed: true, hit: false, typeMultiplier: 1, damage: 0, result: 'missed' });
    return;
  }

  if (move.id === 144) {
    battle.transformations ??= {};
    battle.transformations[attacker.instanceId] = { speciesId: effectiveSpeciesId(battle, defender), stats: structuredClone(effectiveStats(battle, defender)), moves: effectiveMoves(battle, defender).map((entry) => ({ moveId: entry.moveId, pp: Math.min(5, getMove(entry.moveId).pp) })) };
    events.push(event(battle, `${attacker.nickname}은(는) ${defender.nickname}의 모습으로 변신했다.`, 'status'));
    executedMoves.push({ actorInstanceId: attacker.instanceId, targetInstanceId: defender.instanceId,
      moveId: move.id, moveType: move.type, damageClass: move.damageClass, damagingMove: false,
      executed: true, hit: true, typeMultiplier: 1, damage: 0, result: 'status' });
    return;
  }

  let totalDamage = 0; let multiplier = 1;
  const isOhko = [12, 32, 90].includes(move.id);
  let fixed = fixedMoveDamage(move.id, attacker, defender);
  if (move.id === 149) fixed = Math.max(1, Math.floor(attacker.level * (.5 + random(state))));
  const matchup = typeMultiplier(move.type, getSpecies(effectiveSpeciesId(battle, defender)).types);
  if ((isOhko || fixed !== undefined) && matchup === 0) { multiplier = 0; events.push(event(battle, '타입 면역으로 효과가 없었다.')); }
  else if (isOhko && attacker.level < defender.level) events.push(event(battle, '상대의 레벨이 높아 일격필살이 통하지 않았다.'));
  else if (isOhko) { totalDamage = defender.hp; defender.hp = 0; multiplier = 1; }
  else if (fixed !== undefined) { totalDamage = Math.min(defender.hp, fixed); defender.hp -= totalDamage; }
  else if (move.power > 0) {
    const hits = move.minHits && move.maxHits ? move.minHits + Math.floor(random(state) * (move.maxHits - move.minHits + 1)) : 1;
    for (let hit = 0; hit < hits && defender.hp > 0; hit++) {
      const result = calculateDamage(combatant(attacker, battle), combatant(defender, battle), move, .85 + random(state) * .15);
      multiplier = result.multiplier; const dealt = Math.min(defender.hp, result.damage); defender.hp -= dealt; totalDamage += dealt;
    }
  }
  if (move.power > 0 || fixed !== undefined || isOhko) {
    let text = `${attacker.nickname}의 ${move.name}! ${totalDamage} 피해.`;
    if (multiplier > 1) text += ' 효과가 굉장했다.'; if (multiplier === 0) text += ' 효과가 없다.'; else if (multiplier < 1) text += ' 효과가 별로였다.';
    events.push(event(battle, text, 'damage'));
  }

  if (move.drain && totalDamage > 0) {
    const amount = Math.max(1, Math.floor(totalDamage * Math.abs(move.drain) / 100));
    if (move.drain > 0) attacker.hp = Math.min(attacker.stats.hp, attacker.hp + amount); else attacker.hp = Math.max(0, attacker.hp - amount);
    events.push(event(battle, move.drain > 0 ? `${attacker.nickname}은(는) HP를 ${amount} 흡수했다.` : `${attacker.nickname}은(는) 반동으로 ${amount} 피해를 입었다.`, 'status'));
  }
  if (move.healing && move.healing > 0) {
    const amount = Math.max(1, Math.floor(attacker.stats.hp * move.healing / 100)); attacker.hp = Math.min(attacker.stats.hp, attacker.hp + amount);
    events.push(event(battle, `${attacker.nickname}의 HP가 회복되었다.`, 'status'));
  }
  if (move.id === 156) { attacker.hp = attacker.stats.hp; attacker.status = 'sleep'; attacker.statusTurns = 3; events.push(event(battle, `${attacker.nickname}은(는) 잠들어 완전히 회복했다.`, 'status')); }

  const selfByCategory = move.metaCategory === 8;
  const foeByCategory = move.metaCategory === 7;
  const stageTarget = selfByCategory ? attacker : foeByCategory ? defender : SELF_TARGETS.has(move.targetId ?? 10) ? attacker : defender;
  const statChance = move.statChance && move.statChance > 0 ? move.statChance : move.damageClass === 'status' ? 100 : move.effectChance ?? 100;
  if (move.statChanges?.length && random(state) * 100 < statChance) for (const change of move.statChanges) {
    const stat = battleStat(change.stat); if (!stat) continue;
    const applied = changeStage(battle, stageTarget, stat, change.change);
    if (applied) events.push(event(battle, `${stageTarget.nickname}의 ${change.stat} 단계가 ${applied > 0 ? '올랐다' : '내려갔다'}.`, 'status'));
  }

  const ailmentTarget = SELF_TARGETS.has(move.targetId ?? 10) ? attacker : defender;
  const ailmentChance = move.ailmentChance && move.ailmentChance > 0 ? move.ailmentChance : move.damageClass === 'status' ? 100 : move.effectChance ?? 0;
  if (ailmentTarget.hp > 0 && move.ailment && move.ailment !== 'none' && !ailmentTarget.status && random(state) * 100 < ailmentChance) {
    const types = getSpecies(effectiveSpeciesId(battle, ailmentTarget)).types;
    const immune = (move.ailment === 'poison' && (types.includes('poison') || types.includes('steel'))) || (move.ailment === 'burn' && types.includes('fire')) || (move.ailment === 'freeze' && types.includes('ice')) || (move.ailment === 'paralysis' && types.includes('electric'));
    if (immune) events.push(event(battle, `${ailmentTarget.nickname}에게는 상태이상이 통하지 않았다.`, 'status'));
    else { ailmentTarget.status = move.ailment; ailmentTarget.statusTurns = move.ailment === 'sleep' ? 2 + Math.floor(random(state) * 3) : move.ailment === 'confusion' || move.ailment === 'trap' ? 2 + Math.floor(random(state) * 4) : undefined; events.push(event(battle, `${ailmentTarget.nickname}은(는) ${move.ailment} 상태가 되었다.`, 'status')); }
  }
  if (!totalDamage && !move.statChanges?.length && !move.healing && !move.ailment && move.id !== 144) events.push(event(battle, `${move.name}의 특수 효과는 이 로컬 규칙에서 축약되어 변화가 없었다.`));
  const failed = isOhko && attacker.level < defender.level;
  executedMoves.push({ actorInstanceId: attacker.instanceId, targetInstanceId: defender.instanceId,
    moveId: move.id, moveType: move.type, damageClass: move.damageClass, damagingMove,
    executed: true, hit: true, typeMultiplier: multiplier, damage: totalDamage,
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

function gainExperience(monster: Monster, amount: number, events?: BattleLogEntry[], battle?: BattleState, shared = false): ExperienceGain | undefined {
  if (monster.level >= 100) return undefined;
  const applied = Math.max(0, Math.floor(amount));
  if (!applied) return undefined;
  const levelBefore = monster.level;
  monster.xp += applied;
  while (monster.level < 100 && monster.xp >= experienceAtLevel(monster.level + 1, getSpecies(monster.speciesId).growthRate)) {
    const oldMax = monster.stats.hp;
    monster.level++;
    monster.stats = statsFor(getSpecies(monster.speciesId), monster.level);
    monster.hp += monster.stats.hp - oldMax;
    const currentIds = new Set(monster.moves.map((slot) => slot.moveId));
    for (const learned of getSpecies(monster.speciesId).moves.filter((entry) => entry.level === monster.level)) {
      if (!currentIds.has(learned.moveId)) {
        if (monster.moves.length === 4) monster.moves.shift();
        monster.moves.push({ moveId: learned.moveId, pp: getMove(learned.moveId).pp });
      }
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
    const fullAmount = Math.max(1, Math.floor(getSpecies(enemy.speciesId).baseExperience * enemy.level / 7));
    if (winner.hp > 0) {
      const activeGain = gainExperience(winner, fullAmount, events, battle, false);
      if (activeGain) experienceGains.push(activeGain);
    }
    if (state.experienceShare !== false) {
      const sharedAmount = Math.max(1, Math.floor(fullAmount * .5));
      for (const teammate of battle.player.team) {
        if (teammate.instanceId === winner.instanceId || teammate.hp <= 0) continue;
        const sharedGain = gainExperience(teammate, sharedAmount, events, battle, true);
        if (sharedGain) experienceGains.push(sharedGain);
      }
    }
    const next = battle.enemy.team.findIndex((monster) => monster.hp > 0);
    if (next >= 0) { battle.enemy.activeIndex = next; events.push(event(battle, `상대가 ${active(battle.enemy).nickname}을(를) 내보냈다.`)); }
    else {
      if (battle.kind === 'gym' && battle.gymBadge) {
        state.defeatedGyms = uniqueSorted([...state.defeatedGyms, battle.gymBadge]);
        state.player.badges = state.defeatedGyms.length;
        state.player.money += 1500 * battle.gymBadge;
        events.push(event(battle, `배지 ${battle.gymBadge}을(를) 얻었다.`, 'reward'));
      } else if (battle.kind === 'champion') {
        state.championDefeated = true; state.player.money += 20000;
        events.push(event(battle, '챔피언이 되었다!', 'reward'));
      } else state.player.money += Math.max(30, enemy.level * 8);
      state.battle = undefined;
      return 'won';
    }
  }
  const player = active(battle.player);
  if (player.hp <= 0) {
    const next = battle.player.team.findIndex((monster) => monster.hp > 0);
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
    if (state.inventory[action.ball] <= 0) throw new Error(`${action.ball}이(가) 없습니다.`);
    state.inventory[action.ball]--;
    const wild = active(battle.enemy); const species = getSpecies(wild.speciesId);
    const chance = catchProbability(wild.stats.hp, wild.hp, species.catchRate, BALL_MULTIPLIER[action.ball], wild.status);
    if (random(state) < chance) {
      const captured = structuredClone(wild); captured.status = undefined; captured.statusTurns = undefined;
      if (state.player.team.length < 6) state.player.team.push(captured); else state.player.box.push(captured);
      state.dex.seen = uniqueSorted([...state.dex.seen, captured.speciesId]);
      state.dex.caught = uniqueSorted([...state.dex.caught, captured.speciesId]);
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
    for (const slot of monster.moves) slot.pp = getMove(slot.moveId).pp;
  }
  addLog(state, '치료소에서 팀이 회복했다.');
}

export function buyItem(state: GameState, item: InventoryItem, quantity = 1): void {
  if (state.battle) throw new Error('전투 중에는 상점을 이용할 수 없습니다.');
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('수량은 양의 정수여야 합니다.');
  const price = ITEM_PRICES[item];
  if (!price) throw new Error('판매하지 않는 물건입니다.');
  const cost = price * quantity;
  if (state.player.money < cost) throw new Error('돈이 부족합니다.');
  state.player.money -= cost; state.inventory[item] += quantity;
  addLog(state, `${ITEM_LABELS[item]} ${quantity}개 · ₩${(ITEM_PRICES[item] * quantity).toLocaleString('ko-KR')} 구매 완료.`);
}

function allOwned(state: GameState): Monster[] { return [...state.player.team, ...state.player.box]; }
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

export function useItem(state: GameState, item: InventoryItem, targetInstanceId?: string): void {
  if (!targetInstanceId) throw new Error('대상 포켓몬을 선택해야 합니다.');
  if (item === 'potion' || item === 'super-potion') { useHealingItem(state, item, targetInstanceId); return; }
  if (item === 'rare-candy') {
    if (state.battle) throw new Error('전투 중에는 이상한사탕을 사용할 수 없습니다.');
    if (state.inventory[item] <= 0) throw new Error('rare-candy이(가) 없습니다.');
    const monster = findOwned(state, targetInstanceId);
    if (monster.level >= 100) throw new Error('이미 최대 레벨입니다.');
    state.inventory[item]--; gainExperience(monster, experienceAtLevel(monster.level + 1, getSpecies(monster.speciesId).growthRate) - monster.xp);
    return;
  }
  throw new Error('이 아이템은 진화 또는 전투 전용입니다.');
}

export function evolve(state: GameState, instanceId: string, option: { targetId?: number; item?: InventoryItem } = {}): Monster {
  if (state.battle) throw new Error('전투 중에는 진화할 수 없습니다.');
  const monster = findOwned(state, instanceId);
  const evolutions = getSpecies(monster.speciesId).evolutions.filter((evolution) => option.targetId === undefined || evolution.target === option.targetId);
  const evolution = evolutions.find((candidate) => evolutionReady(state, monster, candidate, option.item));
  if (!evolution) throw new Error('현재 조건으로 가능한 진화가 없습니다.');
  const requiredItem = evolution.method === 'trade' ? 'link-cable' : evolution.method === 'stone' ? normalizeEvolutionItem(evolution.item ?? option.item) : undefined;
  if (requiredItem) state.inventory[requiredItem]--;
  const oldMax = monster.stats.hp;
  monster.speciesId = evolution.target; monster.nickname = getSpecies(evolution.target).name;
  monster.stats = statsFor(getSpecies(evolution.target), monster.level);
  monster.hp = Math.min(monster.stats.hp, monster.hp + monster.stats.hp - oldMax);
  for (const learned of knownMoves(getSpecies(evolution.target), monster.level)) {
    if (!monster.moves.some((slot) => slot.moveId === learned.moveId)) { if (monster.moves.length === 4) monster.moves.shift(); monster.moves.push(learned); }
  }
  state.dex.seen = uniqueSorted([...state.dex.seen, evolution.target]); state.dex.caught = uniqueSorted([...state.dex.caught, evolution.target]);
  addLog(state, `${monster.nickname}(으)로 진화했다.`); return monster;
}

function normalizeEvolutionItem(item?: string): InventoryItem | undefined {
  if (!item) return undefined;
  const normalized = item.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
  return INVENTORY_ITEMS.includes(normalized as InventoryItem) ? normalized as InventoryItem : undefined;
}

function evolutionReady(state: GameState, monster: Monster, evolution: Evolution, supplied?: InventoryItem): boolean {
  if (evolution.method === 'level') return monster.level >= (evolution.level ?? 1);
  const required = evolution.method === 'trade' ? 'link-cable' : normalizeEvolutionItem(evolution.item ?? supplied);
  return !!required && state.inventory[required] > 0 && (supplied === undefined || supplied === required);
}

export function availableEvolutions(state: GameState, instanceId: string): Evolution[] {
  const monster = findOwned(state, instanceId);
  return getSpecies(monster.speciesId).evolutions.filter((evolution) => evolutionReady(state, monster, evolution));
}

export function swapTeam(state: GameState, teamIndex: number, boxIndex: number): void {
  if (state.battle) throw new Error('전투 중에는 팀을 바꿀 수 없습니다.');
  const teamMonster = state.player.team[teamIndex]; const boxMonster = state.player.box[boxIndex];
  if (!teamMonster || !boxMonster) throw new Error('교체 위치가 올바르지 않습니다.');
  state.player.team[teamIndex] = boxMonster; state.player.box[boxIndex] = teamMonster;
}

export function depositMonster(state: GameState, teamIndex: number): void {
  if (state.battle || state.player.team.length <= 1) throw new Error('지금은 맡길 수 없습니다.');
  const [monster] = state.player.team.splice(teamIndex, 1); if (!monster) throw new Error('잘못된 팀 위치입니다.');
  state.player.box.push(monster);
}

export function withdrawMonster(state: GameState, boxIndex: number): void {
  if (state.battle || state.player.team.length >= 6) throw new Error('지금은 데려올 수 없습니다.');
  const [monster] = state.player.box.splice(boxIndex, 1); if (!monster) throw new Error('잘못된 박스 위치입니다.');
  state.player.team.push(monster);
}

export function serializeGame(state: GameState): string { assertPlayable(state); return JSON.stringify(state); }

export function restoreGame(json: string): GameState {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('저장 JSON을 읽을 수 없습니다.'); }
  return validateGame(value);
}

/** Engineered victory rule: one available ball guarantees this defeated individual. */
export function captureDefeatedWild(state: GameState, ball: BallItem): boolean {
  const monster = state.captureOffer;
  if (!monster || state.battle || !['poke-ball', 'great-ball', 'ultra-ball'].includes(ball) || state.inventory[ball] <= 0 || (state.player.team.length >= 6 && state.player.box.length >= 10000)) return false;
  state.inventory[ball]--;
  monster.hp = Math.max(1, monster.hp); monster.status = undefined; monster.statusTurns = undefined;
  if (state.player.team.length < 6) state.player.team.push(monster); else state.player.box.push(monster);
  state.dex.seen = uniqueSorted([...state.dex.seen, monster.speciesId]);
  state.dex.caught = uniqueSorted([...state.dex.caught, monster.speciesId]);
  state.captureOffer = undefined;
  addLog(state, `${monster.nickname} 포획 성공! ${ITEM_LABELS[ball]} 1개를 사용했다.`);
  return true;
}

export function validateGame(value: unknown): GameState {
  if (!value || typeof value !== 'object') throw new Error('저장 데이터는 객체여야 합니다.');
  const state = value as GameState;
  if (state.schemaVersion !== SAVE_SCHEMA_VERSION) throw new Error(`지원하지 않는 저장 스키마입니다: ${String(state.schemaVersion)}`);
  if (state.experienceShare !== undefined && typeof state.experienceShare !== 'boolean') throw new Error('경험치 공유 설정이 손상되었습니다.');
  state.experienceShare ??= true;
  if (typeof state.seed !== 'string' || !state.seed || state.seed.length > 200) throw new Error('시드가 손상되었습니다.');
  if (!Number.isInteger(state.rngState) || state.rngState <= 0 || state.rngState > 0xffffffff || !Number.isSafeInteger(state.nextInstanceId) || state.nextInstanceId < 1) throw new Error('난수/개체 ID 상태가 손상되었습니다.');
  if (!state.player || !Number.isSafeInteger(state.player.money) || state.player.money < 0 || !Number.isInteger(state.player.badges) || state.player.badges < 0 || state.player.badges > 8 || !Array.isArray(state.player.team) || !Array.isArray(state.player.box) || state.player.team.length < 1 || state.player.team.length > 6 || state.player.box.length > 10000) throw new Error('플레이어/팀/박스 데이터가 손상되었습니다.');
  if (!state.inventory || !state.dex || !Array.isArray(state.dex.seen) || !Array.isArray(state.dex.caught)) throw new Error('가방 또는 도감 데이터가 손상되었습니다.');
  for (const item of INVENTORY_ITEMS) if (!Number.isInteger(state.inventory[item]) || state.inventory[item] < 0) throw new Error(`가방 수량이 잘못되었습니다: ${item}`);
  for (const id of [...state.dex.seen, ...state.dex.caught]) if (!Number.isInteger(id) || id < 1 || id > 151) throw new Error('도감 번호가 잘못되었습니다.');
  if (!Array.isArray(state.defeatedGyms) || state.defeatedGyms.length !== state.player.badges || state.defeatedGyms.some((badge, index) => badge !== index + 1)) throw new Error('배지 진행이 손상되었습니다.');
  if (typeof state.championDefeated !== 'boolean' || (state.championDefeated && state.player.badges !== 8)) throw new Error('챔피언 진행이 손상되었습니다.');
  if (!Array.isArray(state.logs) || state.logs.length > 200 || state.logs.some((log) => typeof log !== 'string' || log.length > 500)) throw new Error('로그가 손상되었습니다.');
  const region = getRegion(state.regionId);
  if (region.minBadges > state.player.badges) throw new Error('잠기지 않은 지역 진행이 손상되었습니다.');
  if (state.dex.caught.some((id) => !state.dex.seen.includes(id))) throw new Error('잡은 도감은 발견 도감에 포함되어야 합니다.');
  const ids = new Set<string>(); let maximumGeneratedId = 0;
  if (state.captureOffer && (state.battle || state.captureOffer.hp !== 0 || !state.dex.seen.includes(state.captureOffer.speciesId))) throw new Error('승리 후 포획 대상이 올바르지 않습니다.');
  const monsters = [...state.player.team, ...state.player.box, ...(state.battle?.enemy.team ?? []), ...(state.captureOffer ? [state.captureOffer] : [])];
  for (const monster of monsters) {
    if (!monster || typeof monster.instanceId !== 'string' || ids.has(monster.instanceId)) throw new Error('개체 ID가 없거나 중복되었습니다.');
    ids.add(monster.instanceId); const species = getSpecies(monster.speciesId);
    const match = /^mon-(\d+)$/.exec(monster.instanceId); if (match) maximumGeneratedId = Math.max(maximumGeneratedId, Number(match[1]));
    if (typeof monster.nickname !== 'string' || !monster.nickname || monster.nickname.length > 40 || !Number.isInteger(monster.level) || monster.level < 1 || monster.level > 100 || !Number.isSafeInteger(monster.xp) || monster.xp < experienceAtLevel(monster.level, species.growthRate) || (monster.level < 100 && monster.xp >= experienceAtLevel(monster.level + 1, species.growthRate))) throw new Error('이름/레벨/경험치가 잘못되었습니다.');
    const expectedStats = statsFor(species, monster.level);
    if (!monster.stats || (Object.keys(expectedStats) as (keyof MonsterStats)[]).some((key) => monster.stats[key] !== expectedStats[key]) || !Number.isFinite(monster.hp) || monster.hp < 0 || monster.hp > monster.stats.hp) throw new Error('능력치/HP가 잘못되었습니다.');
    if (!Array.isArray(monster.moves) || monster.moves.length > 4) throw new Error('기술 데이터가 잘못되었습니다.');
    for (const slot of monster.moves) { const move = getMove(slot.moveId); if (!Number.isInteger(slot.pp) || slot.pp < 0 || slot.pp > move.pp) throw new Error('PP가 잘못되었습니다.'); }
    if (monster.status !== undefined && (typeof monster.status !== 'string' || !monster.status || monster.status.length > 40)) throw new Error('상태이상이 잘못되었습니다.');
    if (monster.statusTurns !== undefined && (!Number.isInteger(monster.statusTurns) || monster.statusTurns < 1 || monster.statusTurns > 10)) throw new Error('상태이상 지속 시간이 잘못되었습니다.');
    if (monster.brain !== undefined) Brain.restore(monster.brain);
  }
  if (state.nextInstanceId <= maximumGeneratedId) throw new Error('다음 개체 ID가 기존 ID보다 커야 합니다.');
  if (state.battle) {
    const battle = state.battle;
    if (!['wild', 'gym', 'champion'].includes(battle.kind) || !Number.isInteger(battle.turn) || battle.turn < 1 || typeof battle.canRun !== 'boolean' || !Array.isArray(battle.enemy?.team) || battle.enemy.team.length < 1 || !Number.isInteger(battle.enemy.activeIndex) || battle.enemy.activeIndex < 0 || battle.enemy.activeIndex >= battle.enemy.team.length || !Number.isInteger(battle.player?.activeIndex) || battle.player.activeIndex < 0 || battle.player.activeIndex >= state.player.team.length) throw new Error('전투 상태가 손상되었습니다.');
    if (battle.kind === 'wild' ? !battle.canRun || battle.enemy.team.length !== 1 : battle.canRun) throw new Error('전투 도주 규칙이 손상되었습니다.');
    if (battle.kind === 'gym' && (!Number.isInteger(battle.gymBadge) || battle.gymBadge !== state.player.badges + 1)) throw new Error('체육관 전투 진행이 손상되었습니다.');
    if (battle.kind === 'champion' && state.player.badges !== 8) throw new Error('챔피언 전투 조건이 손상되었습니다.');
    if (battle.kind !== 'champion') {
      const battleRegion = getRegion(battle.regionId);
      if (battle.regionId !== state.regionId || battleRegion.minBadges > state.player.badges) throw new Error('전투 지역이 손상되었습니다.');
    } else if (battle.regionId !== 'pokemon-league') throw new Error('챔피언 전투 지역이 손상되었습니다.');
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
