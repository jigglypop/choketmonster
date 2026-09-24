import { REGIONAL_ENCOUNTER_POOLS, REGIONAL_ENCOUNTER_SOURCE, type RegionalEncounterPool, type RegionalEncounterSlot } from './regional-encounters.generated';
import { KANTO_LOCATIONS, type KantoLocation } from '../openworld/kanto';
import { JOHTO_LOCATIONS } from '../openworld/johto';
import { baseWildBand, fitWildSlots, placeRareSpecies, preferredRareBiome, rareSpawnLevels, wildLevelRange, type RareAnchor, type RareBiome } from './wild-levels';
import { combineEncounterPeriods } from './encounter-runtime';
import { isLegendarySpecies } from '../game/legendary';
import { DUNGEON_PLANS } from '../openworld/dungeons';

export type EncounterRegion = 'kanto' | 'johto';
export type EncounterPeriod = 'morning' | 'day' | 'night';
export type EncounterOrigin = 'source' | 'supplemental';
export type RegionalEncounter = { speciesId: number; minLevel: number; maxLevel: number; origin: EncounterOrigin; sourceLocationId?: string; sourceAreaId?: number; method?: string };
/** One dungeon floor: its source areas (undefined: the whole location) and whether it holds the location's rare slots. */
export type EncounterFloor = { areas?: readonly string[]; supplemental: boolean };

export const WORLD_DAY_SECONDS = 20 * 60;
export const REGIONAL_DEX_LIMIT = { kanto: 151, johto: 251 } as const;
export const REGIONAL_WORLD_LOCATION_IDS = {
  kanto: ['pallet','route-1','viridian','route-2-south','viridian-forest','route-2-north','pewter','route-3','mt-moon','route-4','cerulean','route-24','route-25','cerulean-cave','route-5','saffron','route-6','vermilion','diglett-cave-east','diglett-cave-west','route-11','route-12','lavender','pokemon-tower','route-10-south','rock-tunnel','route-10-north','power-plant','route-9','route-8','route-7','celadon','route-16','route-17','route-18','fuchsia','safari-zone','route-15','route-14','route-13','route-19','route-20-east','seafoam-islands','route-20-west','cinnabar','pokemon-mansion','route-21','route-22','route-23','victory-road','indigo-plateau'],
  johto: ['new-bark','route-27','tohjo-falls','mt-silver','route-29','cherrygrove','route-30','route-31','violet','sprout-tower','route-32','ruins-of-alph','union-cave','route-33','azalea','slowpoke-well','ilex-forest','route-34','goldenrod','route-35','national-park','route-36','route-37','ecruteak','burned-tower','bell-tower','route-38','route-39','olivine','lighthouse','route-40','whirl-islands','route-41','cianwood','route-42-west','mt-mortar','route-42-east','mahogany','route-43','lake-of-rage','route-44','ice-path','blackthorn','dragons-den','route-45','route-46','dark-cave-east','dark-cave-west'],
} as const;
export const SELECTED_ENCOUNTER_VERSIONS = {
  kanto: { version: 'red', candidates: { red: 78, yellow: 73, firered: 67, leafgreen: 66 } },
  johto: { version: 'crystal', candidates: { gold: 86, crystal: 100, heartgold: 94, soulsilver: 94 } },
} as const;
export { REGIONAL_ENCOUNTER_SOURCE };

const ALIASES: Record<EncounterRegion, Record<string, string>> = {
  kanto: { pallet: 'pallet-town', viridian: 'viridian-city', pewter: 'pewter-city', cerulean: 'cerulean-city', saffron: 'saffron-city', vermilion: 'vermilion-city', lavender: 'lavender-town', celadon: 'celadon-city', fuchsia: 'fuchsia-city', cinnabar: 'cinnabar-island', 'route-2-south': 'kanto-route-2', 'route-2-north': 'kanto-route-2', 'route-10-south': 'kanto-route-10', 'route-10-north': 'kanto-route-10', 'route-20-east': 'kanto-sea-route-20', 'route-20-west': 'kanto-sea-route-20', 'diglett-cave-east': 'digletts-cave', 'diglett-cave-west': 'digletts-cave', 'victory-road':'kanto-victory-road-2', 'power-plant':'kanto-power-plant', 'safari-zone':'kanto-safari-zone' },
  johto: { 'new-bark': 'new-bark-town', cherrygrove: 'cherrygrove-city', violet: 'violet-city', azalea: 'azalea-town', goldenrod: 'goldenrod-city', ecruteak: 'ecruteak-city', olivine: 'olivine-city', cianwood: 'cianwood-city', mahogany: 'mahogany-town', blackthorn: 'blackthorn-city', lighthouse: 'olivine-lighthouse', 'route-42-west': 'johto-route-42', 'route-42-east': 'johto-route-42', 'dark-cave-west': 'dark-cave', 'dark-cave-east': 'dark-cave' },
};

export function encounterPeriodAt(seconds: number): EncounterPeriod {
  const hour = ((seconds % WORLD_DAY_SECONDS) + WORLD_DAY_SECONDS) % WORLD_DAY_SECONDS / WORLD_DAY_SECONDS * 24;
  return hour >= 4 && hour < 10 ? 'morning' : hour >= 10 && hour < 20 ? 'day' : 'night';
}

export function sourceLocationId(region: EncounterRegion, worldLocationId: string): string {
  const alias = ALIASES[region][worldLocationId];
  if (alias) return alias;
  if (region === 'kanto' && /^route-(19|20|21)$/.test(worldLocationId)) return `kanto-sea-${worldLocationId}`;
  if (region === 'johto' && /^route-(40|41)$/.test(worldLocationId)) return `johto-sea-${worldLocationId}`;
  if (/^route-\d+$/.test(worldLocationId)) return `${region}-route-${worldLocationId.slice(6)}`;
  return worldLocationId;
}

type RuntimeEncounterPool=Readonly<Omit<RegionalEncounterPool,'slots'>&{slots:readonly RegionalEncounterSlot[]}>;
const sourcePoolCache=new Map<string,readonly RuntimeEncounterPool[]>();
export function regionalSourcePools(region: EncounterRegion, worldLocationId: string, period: EncounterPeriod, biome?: string):readonly RuntimeEncounterPool[] {
  const locationId = sourceLocationId(region, worldLocationId);
  const preferred = biome === 'lake' ? 'surf' : 'walk';
  const key=`${region}|${locationId}|${period}|${preferred}`;
  const cached=sourcePoolCache.get(key);if(cached)return cached;
  const pools = REGIONAL_ENCOUNTER_POOLS[region].filter(pool => pool.locationId === locationId && pool.period === period)
    .map(pool=>Object.freeze({...pool,slots:Object.freeze(pool.slots.filter(slot=>slot.speciesId<=REGIONAL_DEX_LIMIT[region]))})).filter(pool=>pool.slots.length);
  const exact=pools.filter(pool => pool.method === preferred);
  // Crystal exposes Dragon's Den only as a surf table. The current cave scene
  // has one uniform floor biome, so this named bridge keeps its sole original
  // table rather than inventing a generic cave fallback.
  const result=Object.freeze(exact.length ? exact : region==='johto'&&worldLocationId==='dragons-den'&&biome==='rock' ? pools.filter(pool=>pool.method==='surf') : []);
  sourcePoolCache.set(key,result);return result;
}

const TOWN_LOCATION_IDS: Record<EncounterRegion, ReadonlySet<string>> = {
  kanto: new Set(['pallet','viridian','pewter','cerulean','saffron','vermilion','lavender','celadon','fuchsia','cinnabar']),
  johto: new Set(['new-bark','cherrygrove','violet','azalea','goldenrod','ecruteak','olivine','cianwood','mahogany','blackthorn']),
};
/** Surface halves of one source location use only their own entrance's table, as their dungeon floors do. */
const SURFACE_AREAS: Record<EncounterRegion, Readonly<Record<string, readonly string[]>>> = {
  kanto: {},
  johto: { 'dark-cave-west': ['violet-city-entrance'], 'dark-cave-east': ['blackthorn-city-entrance'] },
};
const LOCATIONS: Record<EncounterRegion, ReadonlyMap<string, KantoLocation>> = {
  kanto: new Map(KANTO_LOCATIONS.map(location => [location.id, location])),
  johto: new Map(JOHTO_LOCATIONS.map(location => [location.id, location])),
};
/** The location's wild band before dungeon depth: Kanto's authored bands and Johto's game bands. */
export function regionalBaseBand(region: EncounterRegion, worldLocationId: string): { minLevel: number; maxLevel: number } {
  const location = LOCATIONS[region].get(worldLocationId);
  return location ? baseWildBand(region, location) : { minLevel: 1, maxLevel: 100 };
}
const runtimePoolCache=new Map<string,readonly RuntimeEncounterPool[]>();
/**
 * All source time tables combined with equal per-period mass. Towns never emit wild encounters. A dungeon floor passes its own source areas.
 * Slots keep their species unless it lies far below its evolution level in this band; then its pre-evolution takes the slot (wildSpeciesForBand).
 */
export function regionalRuntimePools(region: EncounterRegion, worldLocationId: string, period: EncounterPeriod, biome?: string, areas?: readonly string[]): readonly RuntimeEncounterPool[] {
  if (TOWN_LOCATION_IDS[region].has(worldLocationId)) return [];
  const scope=areas??SURFACE_AREAS[region][worldLocationId];
  const locationId=sourceLocationId(region,worldLocationId),preferred=biome==='lake'?'surf':'walk',inArea=(pool:RegionalEncounterPool)=>!scope||scope.includes(pool.areaName);
  const key=`${region}|${worldLocationId}|${period}|${preferred}|${biome==='rock'?'rock':''}|${scope?.join(',')??'*'}`;const cached=runtimePoolCache.get(key);if(cached)return cached;
  const source=REGIONAL_ENCOUNTER_POOLS[region].filter(pool=>pool.locationId===locationId&&pool.method===preferred&&inArea(pool))
    .map(pool=>({...pool,slots:pool.slots.filter(slot=>slot.speciesId<=REGIONAL_DEX_LIMIT[region])})).filter(pool=>pool.slots.length);
  const bridge=!source.length&&region==='johto'&&worldLocationId==='dragons-den'&&biome==='rock'
    ? REGIONAL_ENCOUNTER_POOLS[region].filter(pool=>pool.locationId===locationId&&pool.method==='surf'&&inArea(pool)) : source;
  const band=regionalBaseBand(region,worldLocationId);
  const result=Object.freeze(combineEncounterPeriods(bridge,period).map(pool=>Object.freeze({...pool,slots:Object.freeze(fitWildSlots(pool.slots,()=>band))})));
  runtimePoolCache.set(key,result);return result;
}

export function regionalSpeciesIds(region: EncounterRegion): number[] {
  return Array.from({ length: REGIONAL_DEX_LIMIT[region] }, (_, index) => index + 1);
}

export function sourceSpeciesIds(region: EncounterRegion): number[] {
  return [...new Set(REGIONAL_ENCOUNTER_POOLS[region].flatMap(pool => pool.slots.map(slot => slot.speciesId)))].sort((a, b) => a - b);
}

type SourceHabitat = { locationId: string; method: 'walk' | 'surf'; slots: readonly RegionalEncounterSlot[] };
const sourceHabitatCache = new Map<EncounterRegion, readonly SourceHabitat[]>();
/**
 * Source tables the 3D world actually uses: grass tables on land places, surf tables on sea places,
 * and Dragon's Den's surf-only table on its floors. A surf table beside a land route with no water,
 * or a grass table on open sea, never spawns; its species count as missing.
 */
function sourceHabitats(region: EncounterRegion): readonly SourceHabitat[] {
  const cached = sourceHabitatCache.get(region); if (cached) return cached;
  const habitats: SourceHabitat[] = [];
  for (const locationId of REGIONAL_WORLD_LOCATION_IDS[region]) {
    const location = LOCATIONS[region].get(locationId);
    if (!location || TOWN_LOCATION_IDS[region].has(locationId)) continue;
    const sea = location.kind === 'sea', slots = regionalRuntimePools(region, locationId, 'day', sea ? 'lake' : 'rock').flatMap(pool => pool.slots);
    if (slots.length) habitats.push({ locationId, method: sea || (region === 'johto' && locationId === 'dragons-den') ? 'surf' : 'walk', slots });
  }
  sourceHabitatCache.set(region, habitats); return habitats;
}

/** Species that spawn from the original tables somewhere in the region's 3D world. */
export function runtimeSourceSpeciesIds(region: EncounterRegion): number[] {
  return [...new Set(sourceHabitats(region).flatMap(habitat => habitat.slots.map(slot => slot.speciesId)))].sort((a,b) => a-b);
}

/** Regional dex species the original tables never spawn; only these get an authored rare distribution. */
export function supplementalSpeciesIds(region: EncounterRegion): number[] {
  const source = new Set(runtimeSourceSpeciesIds(region));
  return regionalSpeciesIds(region).filter(speciesId => !source.has(speciesId));
}

export type SupplementalEncounterRule = { speciesId: number; locationId: string; period: EncounterPeriod; biome: RareBiome; requiredBadges: number; minLevel: number; origin: 'supplemental'; rarity: 'rare' };
type AuthoredAnchor = readonly [locationId: string, biome: RareBiome, badges: number];
/** Rare places and the badge stage each belongs to. Their level is the place's own band. */
const RARE_ANCHORS: Record<EncounterRegion, readonly AuthoredAnchor[]> = {
  kanto: [
    ['route-1','meadow',0],['route-24','meadow',1],['route-11','meadow',2],['route-8','meadow',3],['route-16','meadow',4],['route-15','meadow',5],['pokemon-mansion','meadow',7],['route-23','meadow',8],
    ['viridian-forest','forest',0],['route-19','lake',5],['route-20-east','lake',6],['route-21','lake',7],
    ['mt-moon','rock',0],['diglett-cave-east','rock',2],['rock-tunnel','rock',3],['power-plant','rock',5],['seafoam-islands','rock',6],['victory-road','rock',8],['cerulean-cave','rock',8],
  ],
  johto: [
    ['route-29','meadow',0],['route-32','meadow',1],['route-34','meadow',2],['route-37','meadow',3],['route-38','meadow',4],['route-43','meadow',5],['route-44','meadow',7],['route-27','meadow',8],
    ['ilex-forest','forest',2],['national-park','forest',3],['route-40','lake',4],['lake-of-rage','lake',6],
    ['union-cave','rock',1],['slowpoke-well','rock',2],['whirl-islands','rock',4],['mt-mortar','rock',5],['ice-path','rock',7],['dragons-den','rock',8],['mt-silver','rock',8],
  ],
};
const supplementalRuleCache = new Map<EncounterRegion, SupplementalEncounterRule[]>();
/**
 * Rare slots for species missing from the original tables. Placement follows biology, not Pokédex
 * order: the evolution level floor, base stat total and species class (starter, pseudo-legendary)
 * choose the badge stage, and the anchor's band must hold that level (placeRareSpecies).
 * Legendary and mythical Pokémon get no rare slot: they wait only in their lairs (dungeons.ts).
 */
export function supplementalEncounterRules(region: EncounterRegion): SupplementalEncounterRule[] {
  const cached = supplementalRuleCache.get(region); if (cached) return cached;
  const anchors: RareAnchor[] = RARE_ANCHORS[region].map(([locationId, biome, badges]) => ({ locationId, biome, stages: [badges, badges], gate: badges, ...regionalBaseBand(region, locationId) })), load = new Map<string, number>();
  const rules = supplementalSpeciesIds(region).filter(speciesId => !isLegendarySpecies(speciesId)).map((speciesId): SupplementalEncounterRule => {
    const { anchor, requiredBadges, minLevel } = placeRareSpecies(region, speciesId, anchors, preferredRareBiome(speciesId), load);
    return { speciesId, locationId: anchor.locationId, biome: anchor.biome, requiredBadges, minLevel, period: (['morning','day','night'] as const)[speciesId % 3], origin: 'supplemental', rarity: 'rare' };
  });
  supplementalRuleCache.set(region, rules); return rules;
}

/** Rare rules for a place: on the surface by biome; inside a dungeon only on its anchor floor, whatever the floor's ground. */
export function regionalSupplementalRules(region: EncounterRegion, worldLocationId: string, biome: string, badges: number, floor?: EncounterFloor): SupplementalEncounterRule[] {
  if (floor && !floor.supplemental) return [];
  return supplementalEncounterRules(region).filter(rule => rule.locationId === worldLocationId && (floor || rule.biome === biome) && rule.requiredBadges <= badges);
}

/** Level range of a rare spawn in a band, from its placement minimum. */
export function supplementalRuleLevels(rule: Pick<SupplementalEncounterRule, 'speciesId' | 'minLevel'>, band: { min: number; max: number }): { minLevel: number; maxLevel: number } {
  return rareSpawnLevels(rule.minLevel, band);
}

/**
 * Every twentieth spawn advances through the authored missing-species pool; other spawns use original slot weights.
 * The returned level range is the runtime range: the band (with dungeon depth) raised to the species' evolution floor.
 */
export function chooseRegionalEncounter(region: EncounterRegion, worldLocationId: string, period: EncounterPeriod, biome: string, badges: number, spawnSerial: number, random: () => number, fallbackLevel: { min: number; max: number }, floor?: EncounterFloor): RegionalEncounter {
  const supplemental = regionalSupplementalRules(region, worldLocationId, biome, badges, floor);
  if (supplemental.length && spawnSerial % 20 === 0) {
    const rule = supplemental[((Math.floor(spawnSerial / 20) - 1) % supplemental.length + supplemental.length) % supplemental.length];
    return { speciesId: rule.speciesId, ...supplementalRuleLevels(rule, fallbackLevel), origin: 'supplemental' };
  }
  const pools = regionalRuntimePools(region, worldLocationId, period, biome, floor?.areas);
  const slots = pools.flatMap(pool => pool.slots.map(slot => ({ slot, pool })));
  if (!slots.length) throw new Error(`No ${period} encounter at ${region}:${worldLocationId}:${biome}`);
  const total = slots.reduce((sum, item) => sum + item.slot.weight, 0);
  let roll = random() * total;
  const selected = slots.find(item => (roll -= item.slot.weight) < 0) ?? slots.at(-1)!;
  return { speciesId: selected.slot.speciesId, ...wildLevelRange(selected.slot.speciesId, fallbackLevel.min, fallbackLevel.max), origin: 'source', sourceLocationId: selected.pool.locationId, sourceAreaId: selected.pool.areaId, method: selected.pool.method };
}

export function regionalSpeciesHabitats(speciesId: number) {
  const results: Array<{ region: EncounterRegion; locationIds: string[]; periods: EncounterPeriod[]; methods: string[]; requiredBadges: number; origin: EncounterOrigin; rarity: number | 'rare' }> = [];
  // Legendary and mythical Pokémon are found only at their lairs, reached from the lair's own map place or its entrance.
  if (isLegendarySpecies(speciesId)) {
    for (const plan of DUNGEON_PLANS.filter(item => item.legendary?.includes(speciesId) && (item.regionId === 'kanto' || item.regionId === 'johto'))) {
      const places = plan.regionId === 'kanto' ? KANTO_LOCATIONS : JOHTO_LOCATIONS;
      results.push({ region: plan.regionId as EncounterRegion, locationIds: [places.some(place => place.id === plan.id) ? plan.id : plan.surfaceLocations[0]], periods: ['morning','day','night'], methods: ['walk'], requiredBadges: 8, origin: 'supplemental', rarity: 'rare' });
    }
    return results;
  }
  for (const region of ['kanto','johto'] as const) {
    const habitats = speciesId <= REGIONAL_DEX_LIMIT[region] ? sourceHabitats(region).filter(habitat => habitat.slots.some(slot => slot.speciesId === speciesId)) : [];
    if (habitats.length) results.push({ region, locationIds: [...new Set(habitats.map(habitat => habitat.locationId))], periods: ['morning','day','night'], methods: [...new Set(habitats.map(habitat => habitat.method))], requiredBadges: 0, origin: 'source', rarity: Math.min(...habitats.flatMap(habitat => habitat.slots.filter(slot => slot.speciesId === speciesId).map(slot => slot.weight))) });
    const rules=supplementalEncounterRules(region).filter(rule=>rule.speciesId===speciesId);
    for(const rule of rules) results.push({region,locationIds:[rule.locationId],periods:['morning','day','night'],methods:[rule.biome==='lake'?'surf':'walk'],requiredBadges:rule.requiredBadges,origin:'supplemental',rarity:'rare'});
  }
  return results;
}

/** Equal-area/time game index over the fixed FireRed/HG walk/surf tables plus the authored 5% rare cycle. */
const frequencyCache = new Map<number,number>();
function populateFrequencyCache():void {
  if(frequencyCache.size)return;
  const totals=new Map<number,number>(); let contextWeight=0;
  const periodWeight:Record<EncounterPeriod,number>={morning:6,day:10,night:8};
  for(const region of ['kanto','johto'] as const) for(const locationId of REGIONAL_WORLD_LOCATION_IDS[region]) for(const period of ['morning','day','night'] as const) for(const biome of ['meadow','forest','lake','rock'] as const){
    const pools=regionalRuntimePools(region,locationId,period,biome),rare=supplementalEncounterRules(region).filter(rule=>rule.locationId===locationId&&rule.biome===biome&&rule.requiredBadges<=8);
    if(!pools.length&&!rare.length) continue;
    const contextHours=periodWeight[period]; contextWeight+=contextHours;
    const slots=pools.flatMap(pool=>pool.slots), slotWeight=slots.reduce((sum,slot)=>sum+slot.weight,0);
    for(const slot of slots) totals.set(slot.speciesId,(totals.get(slot.speciesId)??0)+contextHours*slot.weight/Math.max(1,slotWeight)*(rare.length?.95:1));
    for(const rule of rare) totals.set(rule.speciesId,(totals.get(rule.speciesId)??0)+contextHours*.05/rare.length);
  }
  for(let speciesId=1;speciesId<=251;speciesId++)frequencyCache.set(speciesId,(totals.get(speciesId)??0)/Math.max(1,contextWeight)*100);
}
export function regionalEncounterFrequency(speciesId: number): number {
  populateFrequencyCache(); return frequencyCache.get(speciesId)??0;
}
