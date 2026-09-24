import { expansionEncounterPoolOrigin, expansionEncounterPools, type ExpansionEncounterPool, type ExpansionRegion } from './expansion-encounters';
import { getWorldAtlas } from '../openworld/atlas';
import { surfaceBadges } from '../openworld/dungeon-gates';
import type { EncounterFloor, EncounterPeriod, RegionalEncounter, SupplementalEncounterRule } from './regional-encounters';
import { combineEncounterPeriods } from './encounter-runtime';
import { bandStages, fitWildSlots, levelCapForBadges, placeRareSpecies, preferredRareBiome, rareSpawnLevels, rareSpawnProfile, wildLevelRange, type RareAnchor, type RareBiome } from './wild-levels';

export function isExpansionRegion(region: string): region is ExpansionRegion { return ['hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'hisui', 'paldea'].includes(region); }
const ranges = { hoenn: [252,386], sinnoh: [387,493], unova: [494,649], kalos:[650,721], alola:[722,809], galar:[810,898], hisui:[899,905], paldea:[906,1025] } as const;

type RuntimePool = ExpansionEncounterPool;
const lowestLevel = (pool: RuntimePool) => Math.min(...pool.slots.map(slot => slot.minLevel));
/** Fewest badges with which expansionRuntimePools opens this area of a place. */
function areaOpeningBadges(pools: readonly RuntimePool[], pool: RuntimePool): number {
  for (let badges = 0; badges < 8; badges++) {
    const cap = levelCapForBadges(badges);
    if (lowestLevel(pool) <= cap || pools.every(other => lowestLevel(other) > cap)) return badges;
  }
  return 8;
}

const runtimePoolCache = new Map<string, readonly RuntimePool[]>();
/**
 * All source time tables combined with equal per-period mass. Towns never emit wild encounters. A dungeon floor passes its own source areas.
 * Each slot keeps its own source level range, raised to the species' evolution floor; a slot far below that floor
 * spawns as its pre-evolution. With badges, an area whose lowest level is above the local level cap stays closed
 * while the place has a lower area (Slumbering Weald's Lv.45 depths wait while its Lv.2 edge is open).
 */
export function expansionRuntimePools(region: ExpansionRegion, locationId: string, method: 'walk'|'surf', period: EncounterPeriod, areas?: readonly string[], badges?: number): readonly RuntimePool[] {
  const key=`${region}|${locationId}|${method}|${period}|${areas?.join(',')??'*'}|${badges===undefined?'all':Math.max(0,Math.min(8,Math.floor(badges)))}`;
  const cached=runtimePoolCache.get(key); if (cached) return cached;
  const atlas=getWorldAtlas(region),location=atlas.locations.find(item=>item.id===locationId);
  const pools=!location || location.kind==='town' ? [] : combineEncounterPeriods(expansionEncounterPools(region,locationId,method).filter(pool=>!areas||areas.includes(pool.areaName)),period)
    .map(pool=>Object.freeze({...pool,slots:fitWildSlots(pool.slots,slot=>slot)}));
  const result=Object.freeze(badges === undefined ? pools : pools.filter(pool=>areaOpeningBadges(pools,pool)<=badges));
  runtimePoolCache.set(key,result); return result;
}

const sourceCache = new Map<ExpansionRegion, ReadonlySet<number>>();
/**
 * Species the original tables spawn somewhere in the 3D world: walk tables on land places, surf tables on sea places.
 * A surf table beside a land route with no water, or a walk table on open sea, never spawns.
 */
export function expansionSourceSpeciesIds(region: ExpansionRegion): number[] {
  let source = sourceCache.get(region);
  if (!source) {
    source = new Set(getWorldAtlas(region).locations.filter(location => location.kind !== 'town')
      .flatMap(location => expansionRuntimePools(region, location.id, location.kind === 'sea' ? 'surf' : 'walk', 'day').flatMap(pool => pool.slots.map(slot => slot.speciesId))));
    sourceCache.set(region, source);
  }
  return [...source].sort((a, b) => a - b);
}

const cache = new Map<ExpansionRegion, SupplementalEncounterRule[]>();
/**
 * Original walk/surf tables are fixed; native species they never spawn get explicitly authored rare slots.
 * Placement follows biology (wild-levels.ts): evolution floor, base stat total and class set the badge stage and
 * minimum level, and the place's band must hold it. Eight-badge species (legendaries, pseudo-legendary finals,
 * 570+ totals) keep one lair per species spread over the region's habitats and spawn from Lv.50.
 */
export function expansionSupplementalRules(region: ExpansionRegion): SupplementalEncounterRule[] {
  const cached = cache.get(region); if (cached) return cached;
  const atlas = getWorldAtlas(region), source = new Set(expansionSourceSpeciesIds(region));
  const places = atlas.locations.filter(location => location.kind !== 'town' && expansionEncounterPools(region, location.id).some(pool => pool.method === 'walk' || pool.method === 'surf'));
  const anchors: RareAnchor[] = places.map(location => {
    const gate = Math.max(location.requiredBadges, surfaceBadges(atlas, location.id));
    return { locationId: location.id, biome: atlas.sample(location.x, location.z).biome as RareBiome, stages: bandStages(region, location.minLevel, location.maxLevel, gate), gate, minLevel: location.minLevel, maxLevel: location.maxLevel };
  });
  const [first, last] = ranges[region];
  const rules: SupplementalEncounterRule[] = [], load = new Map<string, number>();
  for (let speciesId = first; speciesId <= last; speciesId++) {
    if (source.has(speciesId)) continue;
    const preferred = preferredRareBiome(speciesId, true), profile = rareSpawnProfile(speciesId);
    let placement: { anchor: RareAnchor; requiredBadges: number; minLevel: number };
    if (profile.minBadges === 8) {
      const habitat = anchors.filter(anchor => anchor.biome === preferred && expansionEncounterPools(region, anchor.locationId, preferred === 'lake' ? 'surf' : 'walk').length);
      const walkable = anchors.filter(anchor => expansionEncounterPools(region, anchor.locationId, 'walk').length);
      const candidates = habitat.length ? habitat : walkable.length ? walkable : anchors;
      const anchor = candidates[speciesId % candidates.length];
      placement = { anchor, requiredBadges: 8, minLevel: profile.minLevel };
    } else placement = placeRareSpecies(region, speciesId, anchors, preferred, load);
    rules.push({ speciesId, locationId: placement.anchor.locationId, biome: placement.anchor.biome, period: (['morning', 'day', 'night'] as const)[speciesId % 3],
      requiredBadges: placement.requiredBadges, minLevel: placement.minLevel, origin: 'supplemental', rarity: 'rare' });
  }
  cache.set(region, rules); return rules;
}

/** Rare rules for a place: on the surface by biome; inside a dungeon only on its anchor floor. */
function expansionRules(region: ExpansionRegion, locationId: string, badges: number, biome: string | undefined, floor?: EncounterFloor) {
  if (floor && !floor.supplemental) return [];
  return expansionSupplementalRules(region).filter(rule => rule.locationId === locationId && rule.requiredBadges <= badges && (floor || !biome || rule.biome === biome));
}

/** Without serial this is the complete habitat catalog; spawning passes its exact rare-cycle serial. */
export function expansionEncounterSpecies(region: ExpansionRegion, locationId: string, badges: number, period?: EncounterPeriod, biome?: string, serial?: number, floor?: EncounterFloor): number[] {
  const methods: ReadonlyArray<'walk' | 'surf'> = biome === undefined ? ['walk', 'surf'] : [biome === 'lake' ? 'surf' : 'walk'];
  const source = methods.flatMap(value => expansionRuntimePools(region, locationId, value, period ?? 'day', floor?.areas, badges)).flatMap(pool => pool.slots.map(slot => slot.speciesId));
  const added = serial === undefined || serial % 20 === 0
    ? expansionRules(region, locationId, badges, biome, floor).map(rule => rule.speciesId)
    : [];
  return [...new Set([...source, ...added])].sort((a, b) => a - b);
}

/**
 * levels is the place's band plus dungeon depth. Rare slots start at their placement minimum inside it;
 * source slots use their own table range shifted by the same depth, never below the evolution floor.
 */
export function chooseExpansionEncounter(region: ExpansionRegion, locationId: string, period: EncounterPeriod, biome: string, badges: number, serial: number, random: () => number, levels: { min: number; max: number }, floor?: EncounterFloor): RegionalEncounter {
  const rules = expansionRules(region, locationId, badges, biome, floor);
  if (rules.length && serial % 20 === 0) {
    const rule = rules[(Math.max(0, Math.floor(serial / 20) - 1)) % rules.length];
    return { speciesId: rule.speciesId, ...rareSpawnLevels(rule.minLevel, levels), origin: 'supplemental' };
  }
  const slots = expansionRuntimePools(region, locationId, biome === 'lake' ? 'surf' : 'walk', period, floor?.areas, badges).flatMap(pool => pool.slots.map(slot => ({ slot, pool })));
  if (!slots.length) throw new Error(`No ${period} encounter at ${region}:${locationId}:${biome}`);
  let roll = random() * slots.reduce((sum, { slot }) => sum + slot.weight, 0);
  const selected = slots.find(({ slot }) => (roll -= slot.weight) < 0) ?? slots.at(-1)!;
  const location = getWorldAtlas(region).locations.find(item => item.id === locationId), shift = Math.max(0, levels.min - (location?.minLevel ?? levels.min));
  return { ...selected.slot, ...wildLevelRange(selected.slot.speciesId, selected.slot.minLevel + shift, selected.slot.maxLevel + shift), origin: expansionEncounterPoolOrigin(selected.pool), sourceLocationId: selected.pool.locationId, sourceAreaId: selected.pool.areaId, method: selected.pool.method };
}

type ExpansionHabitat = { region: ExpansionRegion; locationIds: string[]; periods: EncounterPeriod[]; methods: string[]; requiredBadges: number; origin: 'source' | 'supplemental'; rarity: number | 'rare' };
let habitatCache: Map<number, ExpansionHabitat[]> | undefined;
/** Where each species spawns: the tables the world uses (after evolution-floor fitting) and the rare slots. */
export function expansionSpeciesHabitats(speciesId: number): readonly ExpansionHabitat[] {
  if (!habitatCache) {
    habitatCache = new Map();
    const add = (id: number, habitat: ExpansionHabitat) => { const items = habitatCache!.get(id) ?? []; items.push(habitat); habitatCache!.set(id, items); };
    for (const region of ['hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'hisui', 'paldea'] as const) {
      const records = new Map<number, ExpansionHabitat>();
      for (const location of getWorldAtlas(region).locations.filter(location=>location.kind!=='town')) {
        const method = location.kind === 'sea' ? 'surf' : 'walk', pools = expansionRuntimePools(region, location.id, method, 'day');
        for (const pool of pools) for (const slot of pool.slots) {
          const requiredBadges = Math.max(location.requiredBadges, areaOpeningBadges(pools, pool));
          const record = records.get(slot.speciesId) ?? { region, locationIds: [], periods: ['morning','day','night'], methods: [], requiredBadges, origin: expansionEncounterPoolOrigin(pool), rarity: slot.weight };
          if (!record.locationIds.includes(location.id)) record.locationIds.push(location.id);
          if (!record.methods.includes(pool.method)) record.methods.push(pool.method);
          record.rarity = Math.min(record.rarity as number, slot.weight); record.requiredBadges = Math.min(record.requiredBadges, requiredBadges);
          records.set(slot.speciesId, record);
        }
      }
      for (const [id, record] of records) add(id, record);
      for (const rule of expansionSupplementalRules(region)) add(rule.speciesId, { region, locationIds: [rule.locationId], periods: ['morning','day','night'], methods: [rule.biome === 'lake' ? 'surf' : 'walk'], requiredBadges: rule.requiredBadges, origin: 'supplemental', rarity: 'rare' });
    }
  }
  return habitatCache.get(speciesId) ?? [];
}
