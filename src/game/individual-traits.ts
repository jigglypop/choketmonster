import { SPECIES_ABILITIES, type SourceAbility } from '../data/pokemon-abilities.generated';
import type { BaseStats, PokemonSpecies, PokemonType } from './contracts';

export type IndividualValues = BaseStats;
export type AbilityImplementation = 'implemented' | 'partial' | 'display-only';
export type MonsterAbility = SourceAbility & {
  effect: AbilityImplementation;
  description: string;
};

export const LEGACY_INDIVIDUAL_VALUES: Readonly<IndividualValues> = Object.freeze({
  hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0,
});
export const INDIVIDUAL_VALUE_KEYS = Object.keys(LEGACY_INDIVIDUAL_VALUES) as (keyof IndividualValues)[];

type AbilityRule = { description: string; effect?: Exclude<AbilityImplementation, 'display-only'> };
const ABILITY_RULES: Readonly<Record<string, AbilityRule>> = {
  overgrow: { effect: 'implemented', description: 'HP가 1/3 이하일 때 풀타입 공격 위력이 1.5배가 됩니다.' },
  blaze: { effect: 'implemented', description: 'HP가 1/3 이하일 때 불꽃타입 공격 위력이 1.5배가 됩니다.' },
  torrent: { effect: 'implemented', description: 'HP가 1/3 이하일 때 물타입 공격 위력이 1.5배가 됩니다.' },
  swarm: { effect: 'implemented', description: 'HP가 1/3 이하일 때 벌레타입 공격 위력이 1.5배가 됩니다.' },
  levitate: { effect: 'implemented', description: '땅타입 공격의 피해를 받지 않습니다.' },
  sturdy: { effect: 'implemented', description: '일격필살을 막고, HP가 가득 찼을 때 한 번의 공격으로 쓰러지지 않습니다.' },
  'water-absorb': { effect: 'implemented', description: '물타입 공격을 무효화하고 최대 HP의 1/4을 회복합니다.' },
  'volt-absorb': { effect: 'implemented', description: '전기타입 공격을 무효화하고 최대 HP의 1/4을 회복합니다.' },
  'flash-fire': { effect: 'partial', description: '불꽃타입 공격은 무효화합니다. 이후 불꽃 공격 강화는 아직 적용하지 않습니다.' },
  'lightning-rod': { effect: 'partial', description: '전기타입 공격은 무효화합니다. 특수공격 상승과 공격 유도는 아직 적용하지 않습니다.' },
  'motor-drive': { effect: 'partial', description: '전기타입 공격은 무효화합니다. 스피드 상승은 아직 적용하지 않습니다.' },
  'sap-sipper': { effect: 'partial', description: '풀타입 공격은 무효화합니다. 공격 상승은 아직 적용하지 않습니다.' },
  'storm-drain': { effect: 'partial', description: '물타입 공격은 무효화합니다. 특수공격 상승과 공격 유도는 아직 적용하지 않습니다.' },
  'dry-skin': { effect: 'partial', description: '물타입 공격을 무효화하고 최대 HP의 1/4을 회복합니다. 날씨와 불꽃 약점 효과는 아직 적용하지 않습니다.' },
  insomnia: { effect: 'partial', description: '잠자기 사용을 막습니다. 상대 기술에 의한 수면 면역은 아직 적용하지 않습니다.' },
  'vital-spirit': { effect: 'partial', description: '잠자기 사용을 막습니다. 상대 기술에 의한 수면 면역은 아직 적용하지 않습니다.' },
  comatose: { effect: 'partial', description: '잠자기 사용을 막습니다. 그 밖의 절대안깸 효과는 아직 적용하지 않습니다.' },
  soundproof: { effect: 'partial', description: '다른 팀원의 치료방울을 받지 않습니다. 그 밖의 소리 기술 면역은 아직 적용하지 않습니다.' },
  'good-as-gold': { effect: 'partial', description: '다른 팀원의 치료방울을 받지 않습니다. 그 밖의 변화 기술 면역은 아직 적용하지 않습니다.' },
};

function hash(text: string): number {
  let value = 2166136261;
  for (const character of text) { value ^= character.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0 || 0x6d2b79f5;
}

function next(value: number): number {
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  return value >>> 0;
}

function describe(source: SourceAbility): MonsterAbility {
  const rule = ABILITY_RULES[source.slug];
  return { ...source, effect: rule?.effect ?? 'display-only',
    description: rule?.description ?? '원본 특성 이름과 슬롯만 보존합니다. 전투 효과는 아직 적용하지 않습니다.' };
}

export function speciesAbilities(speciesId: number): readonly MonsterAbility[] {
  const abilities = SPECIES_ABILITIES[speciesId];
  if (!abilities?.length) throw new Error(`특성 원본 데이터가 없습니다: ${speciesId}`);
  return abilities.map(describe);
}

export function abilityForSpecies(speciesId: number, slot: number, hidden?: boolean): MonsterAbility {
  const abilities = speciesAbilities(speciesId);
  const source = abilities.find(ability => ability.slot === slot)
    ?? abilities.find(ability => hidden === undefined || ability.hidden === hidden)
    ?? abilities[0];
  return { ...source };
}

function generatedAbility(speciesId: number, roll: number): MonsterAbility {
  const abilities = speciesAbilities(speciesId), hidden = abilities.filter(ability => ability.hidden);
  const ordinary = abilities.filter(ability => !ability.hidden);
  // Hidden abilities remain rare while ordinary source slots share the remaining outcomes.
  const pool = hidden.length && roll % 32 === 0 ? hidden : ordinary.length ? ordinary : hidden;
  return { ...pool[Math.floor(roll / 32) % pool.length] };
}

export function createIndividualTraits(seed: string | number, instanceId: string, speciesId: number): {
  ivs: IndividualValues; ability: MonsterAbility;
} {
  let value = hash(`${seed}:${instanceId}:${speciesId}:individual-traits`);
  const ivs = {} as IndividualValues;
  for (const key of INDIVIDUAL_VALUE_KEYS) { value = next(value); ivs[key] = value % 32; }
  value = next(value);
  return { ivs, ability: generatedAbility(speciesId, value) };
}

export function legacyIndividualTraits(instanceId: string, speciesId: number): { ivs: IndividualValues; ability: MonsterAbility } {
  return { ivs: { ...LEGACY_INDIVIDUAL_VALUES }, ability: generatedAbility(speciesId, hash(`legacy:${instanceId}:${speciesId}`)) };
}

export function statsWithIndividualValues(species: PokemonSpecies, level: number, ivs: IndividualValues = LEGACY_INDIVIDUAL_VALUES): BaseStats {
  const normal = (base: number, iv: number) => Math.floor((2 * base + iv) * level / 100) + 5;
  return {
    hp: Math.floor((2 * species.baseStats.hp + ivs.hp) * level / 100) + level + 10,
    attack: normal(species.baseStats.attack, ivs.attack), defense: normal(species.baseStats.defense, ivs.defense),
    specialAttack: normal(species.baseStats.specialAttack, ivs.specialAttack),
    specialDefense: normal(species.baseStats.specialDefense, ivs.specialDefense), speed: normal(species.baseStats.speed, ivs.speed),
  };
}

export function isValidIndividualValues(value: unknown): value is IndividualValues {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === INDIVIDUAL_VALUE_KEYS.length
    && INDIVIDUAL_VALUE_KEYS.every(key => Number.isInteger(record[key]) && (record[key] as number) >= 0 && (record[key] as number) <= 31);
}

export function isValidAbility(value: unknown, speciesId: number): value is MonsterAbility {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as MonsterAbility;
  const canonical = speciesAbilities(speciesId).find(ability => ability.id === candidate.id && ability.slot === candidate.slot);
  return !!canonical && candidate.hidden === canonical.hidden && candidate.slug === canonical.slug && candidate.name === canonical.name
    && candidate.englishName === canonical.englishName && candidate.effect === canonical.effect && candidate.description === canonical.description;
}

export function lowHpPowerMultiplier(ability: Pick<MonsterAbility, 'slug'> | undefined, hp: number, maxHp: number, type: PokemonType): number {
  if (hp * 3 > maxHp) return 1;
  const boosted = ({ overgrow: 'grass', blaze: 'fire', torrent: 'water', swarm: 'bug' } as const)[ability?.slug as 'overgrow'];
  return boosted === type ? 1.5 : 1;
}

export function abilityImmunity(ability: Pick<MonsterAbility, 'slug'> | undefined, type: PokemonType): { heal: boolean } | undefined {
  const immunity = ({ levitate: 'ground', 'water-absorb': 'water', 'volt-absorb': 'electric',
    'flash-fire': 'fire', 'lightning-rod': 'electric', 'motor-drive': 'electric', 'sap-sipper': 'grass',
    'storm-drain': 'water', 'dry-skin': 'water' } as const)[ability?.slug as 'levitate'];
  if (immunity !== type) return undefined;
  return { heal: ability?.slug === 'water-absorb' || ability?.slug === 'volt-absorb' || ability?.slug === 'dry-skin' };
}

export function hasSturdy(ability: Pick<MonsterAbility, 'slug'> | undefined): boolean { return ability?.slug === 'sturdy'; }
