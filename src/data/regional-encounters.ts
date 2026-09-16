import { REGIONAL_ENCOUNTER_POOLS, REGIONAL_ENCOUNTER_SOURCE, type RegionalEncounterPool, type RegionalEncounterSlot } from './regional-encounters.generated';
import { getSpecies } from './pokemon';
import { combineEncounterPeriods } from './encounter-runtime';

export type EncounterRegion = 'kanto' | 'johto';
export type EncounterPeriod = 'morning' | 'day' | 'night';
export type EncounterOrigin = 'source' | 'supplemental';
export type RegionalEncounter = { speciesId: number; minLevel: number; maxLevel: number; origin: EncounterOrigin; sourceLocationId?: string; sourceAreaId?: number; method?: string };

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
const runtimePoolCache=new Map<string,readonly RuntimeEncounterPool[]>();
/** All source time tables combined with equal per-period mass. Towns never emit wild encounters. */
export function regionalRuntimePools(region: EncounterRegion, worldLocationId: string, period: EncounterPeriod, biome?: string): readonly RuntimeEncounterPool[] {
  if (TOWN_LOCATION_IDS[region].has(worldLocationId)) return [];
  const locationId=sourceLocationId(region,worldLocationId),preferred=biome==='lake'?'surf':'walk';
  const key=`${region}|${locationId}|${period}|${preferred}`;const cached=runtimePoolCache.get(key);if(cached)return cached;
  const source=REGIONAL_ENCOUNTER_POOLS[region].filter(pool=>pool.locationId===locationId&&pool.method===preferred)
    .map(pool=>({...pool,slots:pool.slots.filter(slot=>slot.speciesId<=REGIONAL_DEX_LIMIT[region])})).filter(pool=>pool.slots.length);
  const bridge=!source.length&&region==='johto'&&worldLocationId==='dragons-den'&&biome==='rock'
    ? REGIONAL_ENCOUNTER_POOLS[region].filter(pool=>pool.locationId===locationId&&pool.method==='surf') : source;
  const result=Object.freeze(combineEncounterPeriods(bridge,period).map(pool=>Object.freeze({...pool,slots:Object.freeze(pool.slots)})));
  runtimePoolCache.set(key,result);return result;
}

export function regionalSpeciesIds(region: EncounterRegion): number[] {
  return Array.from({ length: REGIONAL_DEX_LIMIT[region] }, (_, index) => index + 1);
}

export function sourceSpeciesIds(region: EncounterRegion): number[] {
  return [...new Set(REGIONAL_ENCOUNTER_POOLS[region].flatMap(pool => pool.slots.map(slot => slot.speciesId)))].sort((a, b) => a - b);
}

export function supplementalSpeciesIds(region: EncounterRegion): number[] {
  return regionalSpeciesIds(region);
}

export function runtimeSourceSpeciesIds(region: EncounterRegion): number[] {
  const locations = new Set(REGIONAL_WORLD_LOCATION_IDS[region].map(id => sourceLocationId(region, id)));
  return [...new Set(REGIONAL_ENCOUNTER_POOLS[region].filter(pool => locations.has(pool.locationId) && (pool.method === 'walk' || pool.method === 'surf')).flatMap(pool => pool.slots.map(slot => slot.speciesId)).filter(id=>id<=REGIONAL_DEX_LIMIT[region]))].sort((a,b) => a-b);
}

const SPECIAL_LATE = new Set([144,145,146,150,151,243,244,245,249,250,251]);
const STARTERS = new Set([1,4,7,152,155,158]);
export type SupplementalEncounterRule = { speciesId: number; locationId: string; period: EncounterPeriod; biome: 'meadow'|'forest'|'lake'|'rock'; requiredBadges: number; origin: 'supplemental'; rarity: 'rare' };
const supplementalRuleCache = new Map<EncounterRegion, SupplementalEncounterRule[]>();
export function supplementalEncounterRules(region: EncounterRegion): SupplementalEncounterRule[] {
  const cached = supplementalRuleCache.get(region); if (cached) return cached;
  type Anchor = { locationId:string; biome:SupplementalEncounterRule['biome']; badge:number };
  const anchors:Anchor[] = region === 'kanto' ? [
    ['route-1','meadow',0],['route-24','meadow',1],['route-11','meadow',2],['route-8','meadow',3],['route-16','meadow',4],['route-15','meadow',5],['pokemon-mansion','meadow',7],['route-23','meadow',8],
    ['viridian-forest','forest',0],['route-19','lake',5],['route-20-east','lake',6],['route-21','lake',7],
    ['mt-moon','rock',0],['diglett-cave-east','rock',2],['rock-tunnel','rock',3],['power-plant','rock',5],['seafoam-islands','rock',6],['victory-road','rock',8],['cerulean-cave','rock',8],
  ].map(([locationId,biome,badge])=>({locationId:locationId as string,biome:biome as Anchor['biome'],badge:badge as number})) : [
    ['route-29','meadow',0],['route-32','meadow',1],['route-34','meadow',2],['route-37','meadow',3],['route-38','meadow',4],['route-43','meadow',5],['route-44','meadow',7],['route-27','meadow',8],
    ['ilex-forest','forest',2],['national-park','forest',3],['route-40','lake',4],['lake-of-rage','lake',6],
    ['union-cave','rock',1],['slowpoke-well','rock',2],['whirl-islands','rock',4],['mt-mortar','rock',5],['ice-path','rock',7],['dragons-den','rock',8],['mt-silver','rock',8],
  ].map(([locationId,biome,badge])=>({locationId:locationId as string,biome:biome as Anchor['biome'],badge:badge as number}));
  const rules: SupplementalEncounterRule[] = supplementalSpeciesIds(region).map((speciesId, index): SupplementalEncounterRule => {
    const types=getSpecies(speciesId).types;
    const biome: SupplementalEncounterRule['biome'] = types.includes('water') ? 'lake' : types.some(type=>type==='rock'||type==='ground') ? 'rock' : types.some(type=>type==='bug'||type==='grass') ? 'forest' : 'meadow';
    const progressionBadge = SPECIAL_LATE.has(speciesId) ? 8 : STARTERS.has(speciesId) ? 4 : Math.min(7, Math.floor(index / Math.max(1, Math.ceil(supplementalSpeciesIds(region).length / 8))));
    const forced = region==='kanto' && [144,146].includes(speciesId) ? anchors.find(anchor=>anchor.locationId===(speciesId===144?'seafoam-islands':'victory-road'))
      : region==='kanto' && [145,150,151].includes(speciesId) ? anchors.find(anchor=>anchor.locationId===(speciesId===145?'power-plant':'cerulean-cave'))
      : region==='johto' && speciesId===249 ? anchors.find(anchor=>anchor.locationId==='whirl-islands')
      : region==='johto' && speciesId===250 ? {locationId:'bell-tower',biome:'meadow' as const,badge:8}
      : region==='johto' && SPECIAL_LATE.has(speciesId) ? anchors.find(anchor=>anchor.locationId==='mt-silver') : undefined;
    const candidates=anchors.filter(anchor=>anchor.biome===biome),delta=Math.min(...candidates.map(anchor=>Math.abs(anchor.badge-progressionBadge)));
    const closest=candidates.filter(anchor=>Math.abs(anchor.badge-progressionBadge)===delta),anchor=forced??closest[speciesId%closest.length];
    const requiredBadges=Math.max(progressionBadge,anchor.badge);
    return { speciesId, biome:anchor.biome, locationId: anchor.locationId,
    period: (['morning','day','night'] as const)[speciesId % 3],
    requiredBadges,
    origin: 'supplemental', rarity: 'rare' };
  });
  supplementalRuleCache.set(region, rules); return rules;
}

/** Every twentieth spawn advances through the authored missing-species pool; other spawns use original slot weights. */
export function chooseRegionalEncounter(region: EncounterRegion, worldLocationId: string, period: EncounterPeriod, biome: string, badges: number, spawnSerial: number, random: () => number, fallbackLevel: { min: number; max: number }): RegionalEncounter {
  const supplemental = supplementalEncounterRules(region).filter(rule => rule.locationId === worldLocationId && rule.biome === biome && rule.requiredBadges <= badges);
  if (supplemental.length && spawnSerial % 20 === 0) {
    const rule = supplemental[(Math.floor(spawnSerial / 20) - 1) % supplemental.length];
    const level = SPECIAL_LATE.has(rule.speciesId) ? Math.max(50, fallbackLevel.max) : Math.max(fallbackLevel.min, 5 + rule.requiredBadges * 5);
    return { speciesId: rule.speciesId, minLevel: level, maxLevel: Math.max(level, fallbackLevel.max), origin: 'supplemental' };
  }
  const pools = regionalRuntimePools(region, worldLocationId, period, biome);
  const slots = pools.flatMap(pool => pool.slots.map(slot => ({ slot, pool })));
  if (!slots.length) {
    const speciesId = spawnSerial % 20 === 0 ? supplemental[(Math.floor(spawnSerial / 20) - 1) % supplemental.length]?.speciesId : undefined;
    if (!speciesId) throw new Error(`No ${period} encounter at ${region}:${worldLocationId}:${biome}`);
    return { speciesId, minLevel: fallbackLevel.min, maxLevel: fallbackLevel.max, origin: 'supplemental' };
  }
  const total = slots.reduce((sum, item) => sum + item.slot.weight, 0);
  let roll = random() * total;
  const selected = slots.find(item => (roll -= item.slot.weight) < 0) ?? slots.at(-1)!;
  return { ...selected.slot, origin: 'source', sourceLocationId: selected.pool.locationId, sourceAreaId: selected.pool.areaId, method: selected.pool.method };
}

export function regionalSpeciesHabitats(speciesId: number) {
  const results: Array<{ region: EncounterRegion; locationIds: string[]; periods: EncounterPeriod[]; methods: string[]; requiredBadges: number; origin: EncounterOrigin; rarity: number | 'rare' }> = [];
  for (const region of ['kanto','johto'] as const) {
    const reverse = new Map<string,string[]>();
    for (const id of REGIONAL_WORLD_LOCATION_IDS[region]) { const key=sourceLocationId(region,id), list=reverse.get(key)??[]; list.push(id); reverse.set(key,list); }
    const pools = speciesId<=REGIONAL_DEX_LIMIT[region] ? REGIONAL_ENCOUNTER_POOLS[region].filter(pool => reverse.has(pool.locationId) && (pool.method==='walk'||pool.method==='surf') && pool.slots.some(slot=>slot.speciesId===speciesId)) : [];
    if (pools.length) results.push({ region, locationIds:[...new Set(pools.flatMap(pool=>reverse.get(pool.locationId)!).filter(id=>!TOWN_LOCATION_IDS[region].has(id)))], periods:['morning','day','night'], methods:[...new Set(pools.map(pool=>pool.method))], requiredBadges:0, origin:'source', rarity:Math.min(...pools.flatMap(pool=>pool.slots.filter(slot=>slot.speciesId===speciesId).map(slot=>slot.weight))) });
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
