import { getMove, getSpecies } from '../data/pokemon';
import { EVOLUTION_SOURCE_RULES, EVOLUTION_SOURCE_ITEMS, EVOLUTION_SPECIES_TRAITS, EVOLUTION_CONDITION_NAMES, type EvolutionSourceRule } from '../data/evolution-rules';
import { getAlolaCombatForm, getCombatForm } from '../data/pokemon-combat-forms';
import type { Evolution } from './contracts';
import type { GameState, InventoryItem, Monster } from './engine';
import { initialEvolutionProgress } from './evolution-progress';

const byPair = new Map<string, EvolutionSourceRule[]>();
for (const rule of EVOLUTION_SOURCE_RULES) {
  const key = `${rule.from}>${rule.to}`;
  byPair.set(key, [...(byPair.get(key) ?? []), rule]);
}
export const sourceEvolutionRules = (from: number, to: number) => byPair.get(`${from}>${to}`) ?? [];
const sourceItem = (value: string) => EVOLUTION_SOURCE_ITEMS[Number(value)];
export function sourceEvolutionItems(from: number, to: number): string[] {
  const rules = [...sourceEvolutionRules(from, to)].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const items = rules.flatMap(rule => {
    const item = sourceItem(rule.conditions.trigger_item_id || rule.conditions.held_item_id);
    return item ? [item.id] : rule.trigger === 2 ? ['link-cable'] : [];
  });
  return [...new Set(items)];
}

function currentFormId(monster: Monster): number | undefined {
  return monster.regionalForm ? getCombatForm(monster.regionalForm)?.formId : EVOLUTION_SPECIES_TRAITS[monster.speciesId]?.defaultFormId;
}

function resultingFormId(state: GameState, monster: Monster, target: number): number | undefined {
  const current = monster.regionalForm ? getCombatForm(monster.regionalForm) : undefined;
  const becomesAlola = current?.kind === 'alola' || (state.evolutionContext?.regionId === 'alola' && [25, 102, 104].includes(monster.speciesId));
  return (becomesAlola ? getAlolaCombatForm(target)?.formId : undefined) ?? EVOLUTION_SPECIES_TRAITS[target]?.defaultFormId;
}

function ruleMatchesForm(state: GameState, monster: Monster, rule: EvolutionSourceRule): boolean {
  const base = Number(rule.conditions.base_form_id || 0), evolved = Number(rule.conditions.evolved_form_id || 0);
  return (!base || base === currentFormId(monster)) && (!evolved || evolved === resultingFormId(state, monster, rule.to));
}

/** True when at least one source route belongs to the monster's represented form and resulting represented form. */
export function evolutionFormSupported(state: GameState, monster: Monster, evolution: Evolution): boolean {
  const rules = sourceEvolutionRules(monster.speciesId, evolution.target);
  return !rules.length || rules.some(rule => ruleMatchesForm(state, monster, rule));
}

export function sourceEvolutionItemsForMonster(state: GameState, monster: Monster, evolution: Evolution): string[] {
  const items = sourceEvolutionRules(monster.speciesId, evolution.target).filter(rule => ruleMatchesForm(state, monster, rule)).flatMap(rule => {
    const item = sourceItem(rule.conditions.trigger_item_id || rule.conditions.held_item_id);
    return item ? [item.id] : rule.trigger === 2 ? ['link-cable'] : [];
  });
  return [...new Set(items)];
}
export function needsSpecialEvolution(from: number, evolution: Evolution): boolean {
  return evolution.method === 'special' || sourceEvolutionRules(from, evolution.target).some(rule => rule.trigger > 3
    || (rule.conditions.base_form_id && Number(rule.conditions.base_form_id) !== EVOLUTION_SPECIES_TRAITS[from]?.defaultFormId)
    || (rule.conditions.evolved_form_id && Number(rule.conditions.evolved_form_id) !== EVOLUTION_SPECIES_TRAITS[evolution.target]?.defaultFormId)
    || Object.keys(rule.conditions).some(key => !['minimum_level', 'trigger_item_id', 'held_item_id', 'base_form_id', 'evolved_form_id'].includes(key)));
}
export function specialEvolutionLevel(from: number, to: number): number {
  if (from === 290 && to === 292) return 20;
  const rules = sourceEvolutionRules(from, to).filter(rule => rule.isDefault);
  return rules.length ? Math.min(...rules.map(rule => Number(rule.conditions.minimum_level || 1))) : 1;
}

const conditionNames: Record<string, string> = {
  gender_id: '성별', location_id: '장소', held_item_id: '지닌 도구', time_of_day: '시간',
  known_move_id: '배운 기술', known_move_type_id: '배운 기술 타입', minimum_happiness: '친밀도',
  minimum_beauty: '아름다움', minimum_affection: '애정', relative_physical_stats: '공격·방어',
  party_species_id: '동료', party_type_id: '동료 타입', trade_species_id: '교환 상대',
  needs_overworld_rain: '비', turn_upside_down: '기기 뒤집기', needs_multiplayer: '멀티플레이',
  near_special_rock: '특수 바위 근처', region_id: '지방', base_form_id: '진화 전 모습', evolved_form_id: '진화 후 모습',
  used_move_id: '사용할 기술', minimum_move_count: '기술 사용', minimum_steps: '걷기', minimum_damage_taken: '기절 없이 받은 피해',
};
const triggerNames: Record<number, string> = { 1: '레벨업', 2: '교환', 3: '도구 사용', 4: '빈 팀 자리 + 몬스터볼',
  5: '사탕 장식 + 회전', 6: '악의 탑', 7: '물의 탑', 8: '한 전투에서 급소 3회', 9: '피해 후 특수 장소 통과',
  10: '특수 레벨업', 11: '속공 기술 사용', 12: '강공 기술 사용', 13: '반동 피해 누적', 14: '기술 사용',
  15: '대장의징표를 지닌 절각참 3마리 쓰러뜨리기', 16: '모으령의코인 999개' };
const typeNames: Record<string, string> = { normal: '노말', fire: '불꽃', water: '물', electric: '전기', grass: '풀', ice: '얼음', fighting: '격투', poison: '독', ground: '땅', flying: '비행', psychic: '에스퍼', bug: '벌레', rock: '바위', ghost: '고스트', dragon: '드래곤', dark: '악', steel: '강철', fairy: '페어리' };
function conditionLabel(key: string, value: string): string {
  if (key === 'minimum_level') return `Lv.${value}`;
  if (key === 'trigger_item_id' || key === 'held_item_id') return `${key === 'held_item_id' ? '지닌 도구 ' : ''}${sourceItem(value)?.name ?? value}`;
  if (key === 'gender_id') return Number(value) === 1 ? '암컷' : Number(value) === 2 ? '수컷' : '성별 없음';
  if (key === 'time_of_day') return ({ day: '낮', night: '밤', dusk: '황혼', 'full-moon': '보름달' } as Record<string, string>)[value] ?? value;
  if (key === 'known_move_id' || key === 'used_move_id') return `${getMove(Number(value)).name} ${key === 'known_move_id' ? '배우기' : '사용'}`;
  if (key === 'relative_physical_stats') return Number(value) > 0 ? '공격 > 방어' : Number(value) < 0 ? '공격 < 방어' : '공격 = 방어';
  if (key === 'party_species_id' || key === 'trade_species_id') return `${key === 'party_species_id' ? '팀에 ' : '교환 상대 '}${getSpecies(Number(value)).name}`;
  if (key === 'known_move_type_id' || key === 'party_type_id') return `${conditionNames[key]} ${typeNames[EVOLUTION_CONDITION_NAMES[key]?.[value]] ?? value}`;
  if (key.startsWith('needs_') || key === 'turn_upside_down' || key === 'near_special_rock') return conditionNames[key];
  const names = EVOLUTION_CONDITION_NAMES[key] ?? {};
  return `${conditionNames[key] ?? key} ${names[value] ?? value}${key === 'minimum_steps' ? '걸음' : key === 'minimum_move_count' ? '회' : ''}`;
}
export function sourceEvolutionDescriptions(from: number, to: number): string[] {
  return [...new Set(sourceEvolutionRules(from, to).map(rule => [triggerNames[rule.trigger] ?? `진화 ${rule.trigger}`,
    ...Object.entries(rule.conditions).filter(([key, value]) => !((key === 'base_form_id' && Number(value) === EVOLUTION_SPECIES_TRAITS[from]?.defaultFormId)
      || (key === 'evolved_form_id' && Number(value) === EVOLUTION_SPECIES_TRAITS[to]?.defaultFormId))).map(([key, value]) => conditionLabel(key, value))].join(' · ')))];
}

/** Native predicates supported by the current world. Unsupported source events stay false;
 * their explicitly labelled shop substitutes are evaluated separately by the engine. */
export function nativeEvolutionReady(state: GameState, monster: Monster, rule: EvolutionSourceRule): boolean {
  const progress = monster.evolutionProgress ?? initialEvolutionProgress(monster), c = rule.conditions, context = state.evolutionContext;
  if (rule.from !== monster.speciesId || !ruleMatchesForm(state, monster, rule)) return false;
  // Friendship values remain in old saves for compatibility, but friendship is
  // no longer a playable evolution route. Special evolutions use the catalyst.
  if ('minimum_happiness' in c) return false;
  // This route creates a second individual in the party, so defer it until an active battle ends.
  if (rule.trigger === 4) return !state.battle && monster.level >= 20 && state.player.team.length < 6 && state.inventory['poke-ball'] > 0;
  if (![1, 10, 13, 14].includes(rule.trigger)) return false;
  if (rule.trigger === 10 && rule.from !== 924) return false;
  if (rule.trigger === 13 && progress.recoilDamage < Number(c.minimum_damage_taken || 294)) return false;
  if (rule.trigger === 14 && (progress.moveUses[c.used_move_id] ?? 0) < Number(c.minimum_move_count || 1)) return false;
  for (const [key, value] of Object.entries(c)) {
    const n = Number(value);
    switch (key) {
      case 'minimum_level': if (monster.level < n) return false; break;
      case 'gender_id': if (progress.gender !== ({ 1: 'female', 2: 'male', 3: 'genderless' } as Record<number, string>)[n]) return false; break;
      case 'minimum_beauty': if (progress.beauty < n) return false; break;
      case 'minimum_affection': if (progress.affection < n) return false; break;
      case 'known_move_id': if (!monster.moves.some(move => move.moveId === n)) return false; break;
      case 'known_move_type_id': if (!monster.moves.some(move => getMove(move.moveId).type === EVOLUTION_CONDITION_NAMES[key]?.[value])) return false; break;
      case 'relative_physical_stats': if (Math.sign(monster.stats.attack - monster.stats.defense) !== n) return false; break;
      case 'party_species_id': if (!state.player.team.some(other => other.instanceId !== monster.instanceId && other.speciesId === n)) return false; break;
      case 'party_type_id': if (!state.player.team.some(other => other.instanceId !== monster.instanceId && getSpecies(other.speciesId).types.includes(EVOLUTION_CONDITION_NAMES[key]?.[value] as never))) return false; break;
      case 'time_of_day': if (!context || context.period !== value) return false; break;
      case 'location_id': if (!context || context.locationId !== EVOLUTION_CONDITION_NAMES[key]?.[value]) return false; break;
      case 'region_id': if (!context || context.regionId !== EVOLUTION_CONDITION_NAMES[key]?.[value]) return false; break;
      case 'needs_overworld_rain': if (!context?.raining) return false; break;
      case 'needs_multiplayer': if (!context?.multiplayer) return false; break;
      case 'base_form_id': case 'evolved_form_id': break;
      case 'minimum_steps': if (progress.steps < n) return false; break;
      case 'minimum_damage_taken': if ((rule.trigger === 13 ? progress.recoilDamage : progress.damageTaken) < n || monster.hp <= 0) return false; break;
      case 'used_move_id': if ((progress.moveUses[value] ?? 0) < Number(c.minimum_move_count || 1)) return false; break;
      case 'minimum_move_count': if (!c.used_move_id || (progress.moveUses[c.used_move_id] ?? 0) < n) return false; break;
      default: return false;
    }
  }
  return true;
}
export function naturalEvolution(state: GameState, monster: Monster, evolution: Evolution): EvolutionSourceRule | undefined {
  return sourceEvolutionRules(monster.speciesId, evolution.target).find(rule => nativeEvolutionReady(state, monster, rule));
}
export function evolutionGrowthSummary(monster: Monster): string {
  const p = monster.evolutionProgress ?? initialEvolutionProgress(monster);
  return `${p.gender === 'female' ? '암컷' : p.gender === 'male' ? '수컷' : '성별 없음'} · 친밀도 ${p.friendship}/255 · 아름다움 ${p.beauty}/255 · 애정 ${p.affection}/255 · ${p.steps.toLocaleString()}걸음`;
}

export const EVOLUTION_TREAT_EFFECTS = {
  'friendship-treat': { key: 'friendship', amount: 20 },
  'beauty-treat': { key: 'beauty', amount: 20 },
  'affection-treat': { key: 'affection', amount: 1 },
} as const;

export function feedEvolutionTreat(monster: Monster, item: InventoryItem, quantity: number): boolean {
  const effect = EVOLUTION_TREAT_EFFECTS[item as keyof typeof EVOLUTION_TREAT_EFFECTS];
  if (!effect) return false;
  const p = monster.evolutionProgress ?? initialEvolutionProgress(monster);
  if (p[effect.key] >= 255 || quantity > Math.ceil((255 - p[effect.key]) / effect.amount)) throw new Error('최대 성장치를 넘는 간식은 사용할 수 없습니다.');
  p[effect.key] = Math.min(255, p[effect.key] + quantity * effect.amount); monster.evolutionProgress = p; return true;
}
