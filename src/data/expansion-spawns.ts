import { getSpecies } from './pokemon';
import { expansionEncounterPools, type ExpansionRegion } from './expansion-encounters';
import { getWorldAtlas } from '../openworld/atlas';
import type { EncounterPeriod, RegionalEncounter, SupplementalEncounterRule } from './regional-encounters';

export function isExpansionRegion(region: string): region is ExpansionRegion { return ['hoenn', 'sinnoh', 'unova'].includes(region); }
const ranges = { hoenn: [252, 386], sinnoh: [387, 493], unova: [494, 649] } as const;
const cache = new Map<ExpansionRegion, SupplementalEncounterRule[]>();

/** Original walk/surf tables are fixed; missing native species get explicitly authored rare slots. */
export function expansionSupplementalRules(region: ExpansionRegion): SupplementalEncounterRule[] {
  const cached = cache.get(region); if (cached) return cached;
  const atlas = getWorldAtlas(region);
  const source = new Set(atlas.locations.flatMap(location => expansionEncounterPools(region, location.id).filter(pool => pool.method === 'walk' || pool.method === 'surf').flatMap(pool => pool.slots.map(slot => slot.speciesId))));
  const [first, last] = ranges[region];
  const rules: SupplementalEncounterRule[] = [];
  for (let speciesId = first; speciesId <= last; speciesId++) {
    if (source.has(speciesId)) continue;
    const types = getSpecies(speciesId).types;
    const preferred = types.includes('water') ? 'lake' : types.some(type => ['ground', 'rock', 'steel'].includes(type)) ? 'rock' : types.some(type => ['grass', 'bug'].includes(type)) ? 'forest' : 'meadow';
    const late = speciesId >= (region === 'hoenn' ? 377 : region === 'sinnoh' ? 480 : 638);
    const requiredBadges = late ? 8 : speciesId <= first + 8 ? 4 : 2 + speciesId % 6;
    const anchors = atlas.locations.filter(location => expansionEncounterPools(region, location.id, preferred === 'lake' ? 'surf' : 'walk').length && atlas.sample(location.x, location.z).biome === preferred);
    const fallback = atlas.locations.filter(location => expansionEncounterPools(region, location.id, 'walk').length);
    const candidates = anchors.length ? anchors : fallback;
    const anchor = candidates[speciesId % candidates.length];
    if (!anchor) throw new Error(`No rare encounter anchor for ${region}:${speciesId}`);
    rules.push({ speciesId, locationId: anchor.id, biome: atlas.sample(anchor.x, anchor.z).biome, period: (['morning', 'day', 'night'] as const)[speciesId % 3], requiredBadges: Math.max(requiredBadges, anchor.requiredBadges), origin: 'supplemental', rarity: 'rare' });
  }
  cache.set(region, rules); return rules;
}

export function expansionEncounterSpecies(region: ExpansionRegion, locationId: string, badges: number, period?: EncounterPeriod, biome?: string): number[] {
  const method = biome === undefined ? undefined : biome === 'lake' ? 'surf' : 'walk';
  const source = expansionEncounterPools(region, locationId, method, period).flatMap(pool => pool.slots.map(slot => slot.speciesId));
  const added = expansionSupplementalRules(region).filter(rule => rule.locationId === locationId && rule.requiredBadges <= badges && (!period || rule.period === period) && (!biome || rule.biome === biome)).map(rule => rule.speciesId);
  return [...new Set([...source, ...added])].sort((a, b) => a - b);
}

export function chooseExpansionEncounter(region: ExpansionRegion, locationId: string, period: EncounterPeriod, biome: string, badges: number, serial: number, random: () => number, levels: { min: number; max: number }): RegionalEncounter {
  const rules = expansionSupplementalRules(region).filter(rule => rule.locationId === locationId && rule.requiredBadges <= badges && rule.period === period && rule.biome === biome);
  if (rules.length && serial % 20 === 0) {
    const rule = rules[(Math.max(0, Math.floor(serial / 20) - 1)) % rules.length];
    const minLevel = Math.max(levels.min, rule.requiredBadges === 8 ? 50 : 5 + rule.requiredBadges * 4);
    return { speciesId: rule.speciesId, minLevel, maxLevel: Math.max(minLevel, levels.max), origin: 'supplemental' };
  }
  const slots = expansionEncounterPools(region, locationId, biome === 'lake' ? 'surf' : 'walk', period).flatMap(pool => pool.slots.map(slot => ({ slot, pool })));
  if (!slots.length) throw new Error(`No ${period} encounter at ${region}:${locationId}:${biome}`);
  let roll = random() * slots.reduce((sum, { slot }) => sum + slot.weight, 0);
  const selected = slots.find(({ slot }) => (roll -= slot.weight) < 0) ?? slots.at(-1)!;
  return { ...selected.slot, origin: 'source', sourceLocationId: selected.pool.locationId, sourceAreaId: selected.pool.areaId, method: selected.pool.method };
}

type ExpansionHabitat = { region: ExpansionRegion; locationIds: string[]; periods: EncounterPeriod[]; methods: string[]; requiredBadges: number; origin: 'source' | 'supplemental'; rarity: number | 'rare' };
let habitatCache: Map<number, ExpansionHabitat[]> | undefined;
export function expansionSpeciesHabitats(speciesId: number): readonly ExpansionHabitat[] {
  if (!habitatCache) {
    habitatCache = new Map();
    const add = (id: number, habitat: ExpansionHabitat) => { const items = habitatCache!.get(id) ?? []; items.push(habitat); habitatCache!.set(id, items); };
    for (const region of ['hoenn', 'sinnoh', 'unova'] as const) {
      const records = new Map<number, ExpansionHabitat>();
      for (const location of getWorldAtlas(region).locations) for (const pool of expansionEncounterPools(region, location.id)) {
        if (pool.method !== 'walk' && pool.method !== 'surf') continue;
        for (const slot of pool.slots) {
          const record = records.get(slot.speciesId) ?? { region, locationIds: [], periods: [], methods: [], requiredBadges: location.requiredBadges, origin: 'source', rarity: slot.weight };
          if (!record.locationIds.includes(location.id)) record.locationIds.push(location.id);
          if (!record.periods.includes(pool.period)) record.periods.push(pool.period);
          if (!record.methods.includes(pool.method)) record.methods.push(pool.method);
          record.rarity = Math.min(record.rarity as number, slot.weight); record.requiredBadges = Math.min(record.requiredBadges, location.requiredBadges);
          records.set(slot.speciesId, record);
        }
      }
      for (const [id, record] of records) add(id, record);
      for (const rule of expansionSupplementalRules(region)) add(rule.speciesId, { region, locationIds: [rule.locationId], periods: [rule.period], methods: [rule.biome === 'lake' ? 'surf' : 'walk'], requiredBadges: rule.requiredBadges, origin: 'supplemental', rarity: 'rare' });
    }
  }
  return habitatCache.get(speciesId) ?? [];
}
