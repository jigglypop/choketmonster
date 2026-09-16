export type RuntimePeriod = 'morning' | 'day' | 'night';

type WeightedSlot = { speciesId: number; minLevel: number; maxLevel: number; weight: number };
type PeriodPool<S extends WeightedSlot> = { areaId: number; areaName: string; method: string; period: RuntimePeriod; slots: S[] };

/**
 * Combines the preserved morning/day/night source tables for runtime use.
 * Each available period contributes the same total mass, so a source that
 * repeats an unchanged day table three times is not counted three times.
 */
export function combineEncounterPeriods<S extends WeightedSlot, P extends PeriodPool<S>>(pools: readonly P[], period: RuntimePeriod): P[] {
  const groups = new Map<string, P[]>();
  for (const pool of pools) {
    const key = `${pool.areaId}|${pool.method}`;
    const items = groups.get(key) ?? [];
    items.push(pool); groups.set(key, items);
  }
  return [...groups.values()].map(items => {
    const periods = [...new Set(items.map(item => item.period))];
    const merged = new Map<number, S>();
    const mass = new Map<number, number>();
    for (const sourcePeriod of periods) {
      const periodPools = items.filter(item => item.period === sourcePeriod);
      const total = periodPools.flatMap(item => item.slots).reduce((sum, slot) => sum + slot.weight, 0);
      if (!total) continue;
      for (const slot of periodPools.flatMap(item => item.slots)) {
        const prior = merged.get(slot.speciesId);
        merged.set(slot.speciesId, { ...(prior ?? slot), minLevel: Math.min(prior?.minLevel ?? slot.minLevel, slot.minLevel), maxLevel: Math.max(prior?.maxLevel ?? slot.maxLevel, slot.maxLevel) });
        mass.set(slot.speciesId, (mass.get(slot.speciesId) ?? 0) + slot.weight / total / periods.length * 100);
      }
    }
    const first = items[0];
    return { ...first, period, slots: [...merged.entries()].map(([speciesId, slot]) => ({ ...slot, speciesId, weight: mass.get(speciesId)! })) } as P;
  });
}
