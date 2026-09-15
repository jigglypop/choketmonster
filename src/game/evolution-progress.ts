import { EVOLUTION_SPECIES_TRAITS } from '../data/evolution-rules';

/** Game growth records, independent of each individual's neural state. */
export type EvolutionProgress = {
  gender: 'female' | 'male' | 'genderless';
  friendship: number; beauty: number; affection: number;
  steps: number; damageTaken: number; recoilDamage: number; criticalHits: number;
  defeatedBisharp: number; coins: number; moveUses: Record<string, number>;
};
export type EvolutionContext = {
  period: 'day' | 'night' | 'dusk'; regionId: string; locationId: string;
  raining: boolean; multiplayer: boolean;
};
type Individual = { instanceId: string; speciesId: number; evolutionProgress?: EvolutionProgress };

export function initialEvolutionProgress(monster: Pick<Individual, 'instanceId' | 'speciesId'>): EvolutionProgress {
  const traits = EVOLUTION_SPECIES_TRAITS[monster.speciesId];
  // Stable legacy migration; never draw from the simulation or neural RNG.
  let hash = 2166136261;
  for (const char of monster.instanceId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const rate = traits?.genderRate ?? -1;
  return { gender: rate < 0 ? 'genderless' : hash % 8 < rate ? 'female' : 'male',
    friendship: traits?.baseHappiness ?? 70, beauty: 0, affection: 0, steps: 0,
    damageTaken: 0, recoilDamage: 0, criticalHits: 0, defeatedBisharp: 0, coins: 0, moveUses: {} };
}
export function evolutionProgress(monster: Individual): EvolutionProgress {
  return monster.evolutionProgress ??= initialEvolutionProgress(monster);
}
export function addEvolutionSteps(monster: Individual, steps: number): void {
  if (!Number.isSafeInteger(steps) || steps <= 0) return;
  const progress = evolutionProgress(monster), before = Math.floor(progress.steps / 128);
  progress.steps = Math.min(1e9, progress.steps + steps);
  progress.friendship = Math.min(255, progress.friendship + Math.floor(progress.steps / 128) - before);
}
export function validateEvolutionProgress(value: EvolutionProgress): void {
  const counters = ['steps', 'damageTaken', 'recoilDamage', 'criticalHits', 'defeatedBisharp', 'coins'] as const;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['female', 'male', 'genderless'].includes(value.gender)
    || !['friendship', 'beauty', 'affection'].every(key => Number.isSafeInteger(value[key as 'friendship']) && value[key as 'friendship'] >= 0 && value[key as 'friendship'] <= 255)
    || counters.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1e9)
    || !value.moveUses || typeof value.moveUses !== 'object' || Array.isArray(value.moveUses)
    || Object.keys(value.moveUses).length > 1000
    || Object.entries(value.moveUses).some(([key, count]) => !/^[1-9]\d*$/.test(key) || Number(key) > 1000 || !Number.isSafeInteger(count) || count < 0 || count > 1e9)
    || Object.keys(value).some(key => !['gender', 'friendship', 'beauty', 'affection', ...counters, 'moveUses'].includes(key))) throw new Error('진화 성장 기록이 잘못되었습니다.');
}
export function validateEvolutionContext(value: EvolutionContext): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['day', 'night', 'dusk'].includes(value.period)
    || typeof value.regionId !== 'string' || !value.regionId || value.regionId.length > 40
    || typeof value.locationId !== 'string' || !value.locationId || value.locationId.length > 100
    || typeof value.raining !== 'boolean' || typeof value.multiplayer !== 'boolean'
    || Object.keys(value).some(key => !['period', 'regionId', 'locationId', 'raining', 'multiplayer'].includes(key))) throw new Error('진화 환경 기록이 잘못되었습니다.');
}
