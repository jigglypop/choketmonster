import { POKEMON, getSpecies } from './pokemon';
import { EVOLUTION_SOURCE_RULES } from './evolution-rules';
import legendaryIds from './legendary-species.json';
import { GYM_TEAMS } from '../game/gym-teams';

/** Highest level usable in a region with 0..8 local badges. */
export const REGIONAL_LEVEL_CAPS = [20, 30, 40, 50, 60, 70, 80, 90, 100] as const;
export const levelCapForBadges = (badges: number): number => REGIONAL_LEVEL_CAPS[Math.max(0, Math.min(8, Math.floor(badges)))];

/**
 * Johto wild levels are game rules, not Crystal's slot levels: they follow the gym order.
 * Mt. Silver opens with eight badges, so its band sits beside the League instead of
 * inheriting Gold's Larvitar Lv.15 slot.
 */
export const JOHTO_WILD_BANDS: Readonly<Record<string, readonly [number, number]>> = {
  'route-32': [8,12], 'union-cave': [10,14], 'route-33': [10,14], 'slowpoke-well': [11,15],
  'ilex-forest': [14,18], 'route-34': [16,20], 'route-35': [18,23], 'national-park': [18,23],
  'route-36': [20,24], 'route-37': [22,26], 'burned-tower': [23,28], 'bell-tower': [28,34],
  'route-38': [26,30], 'route-39': [27,31], 'route-40': [28,32], 'route-41': [29,33],
  'whirl-islands': [30,35], 'route-42-west': [30,34], 'mt-mortar': [31,36], 'route-42-east': [32,36],
  'route-43': [33,37], 'lake-of-rage': [34,38], 'route-44': [35,39], 'ice-path': [36,40],
  'route-45': [37,41], 'dark-cave-east': [33,38], 'dragons-den': [39,43],
  'route-27': [40,45], 'tohjo-falls': [42,47], 'mt-silver': [40,50],
};

/** A location's wild band before dungeon depth and post-game overrides. */
export function baseWildBand(region: string, location: { id: string; minLevel: number; maxLevel: number }): { minLevel: number; maxLevel: number } {
  const band = region === 'johto' ? JOHTO_WILD_BANDS[location.id] : undefined;
  return band ? { minLevel: band[0], maxLevel: band[1] } : { minLevel: location.minLevel, maxLevel: location.maxLevel };
}

/** PokeAPI is_baby species. Evolving out of a baby into an older species (Pichu to Pikachu) does not raise the natural wild level. */
export const BABY_SPECIES: ReadonlySet<number> = new Set([172,173,174,175,236,238,239,240,298,360,406,433,438,439,440,446,447,458,848]);
const legendary = new Set<number>(legendaryIds);

type Parent = { from: number; method: string; level?: number };
const parents = new Map<number, Parent>();
for (const species of POKEMON) for (const evolution of species.evolutions) if (!parents.has(evolution.target)) parents.set(evolution.target, { from: species.id, method: evolution.method, level: evolution.level });

/** Level from the default PokeAPI rule for evolutions the runtime marks special, such as Tyrogue at Lv.20. */
function sourceMinimumLevel(from: number, to: number): number {
  const levels = EVOLUTION_SOURCE_RULES.filter(rule => rule.from === from && rule.to === to && rule.isDefault).map(rule => Number(rule.conditions.minimum_level || 0)).filter(level => level > 0);
  return levels.length ? Math.min(...levels) : 0;
}

const floorCache = new Map<number, number>();
/**
 * Lowest level at which a wild individual of this species is natural.
 * Level evolutions use their evolution level (Charizard 36, Ivysaur 16). Item, trade and
 * friendship evolutions have no level, so they sit ten levels past the previous stage and
 * never below Lv.20 (Raichu 20, Golem 35). A baby added after its evolution (Pichu, Happiny)
 * does not count as a stage; Togepi, Riolu and Toxel do.
 */
export function wildLevelFloor(speciesId: number): number {
  const cached = floorCache.get(speciesId); if (cached !== undefined) return cached;
  const parent = parents.get(speciesId);
  let floor = 1;
  if (parent) {
    const base = wildLevelFloor(parent.from);
    const level = parent.method === 'level' ? parent.level ?? 0 : sourceMinimumLevel(parent.from, speciesId);
    floor = BABY_SPECIES.has(parent.from) && speciesId < parent.from ? base : level ? Math.max(base, level) : Math.max(base + 10, 20);
  }
  floorCache.set(speciesId, floor); return floor;
}

/** A source slot may spawn this many levels above its band to keep its species; farther than that it spawns as a pre-evolution. */
export const WILD_FLOOR_TOLERANCE = 4;

/**
 * The species a source table slot spawns as when the local band tops out at maxLevel.
 * Close to the band the slot keeps its species and its level rises to the floor (Kakuna Lv.7
 * in Viridian Forest). Far below the floor, the latest pre-evolution that fits takes the slot
 * (Slowbro in the Lv.11-15 Slowpoke Well becomes Slowpoke), so the place keeps its band.
 */
export function wildSpeciesForBand(speciesId: number, maxLevel: number): number {
  let id = speciesId;
  for (let parent = parents.get(id); parent && wildLevelFloor(id) > maxLevel + WILD_FLOOR_TOLERANCE; parent = parents.get(id)) id = parent.from;
  return id;
}

/** A wild level range that never starts below the species' natural floor. */
export function wildLevelRange(speciesId: number, minLevel: number, maxLevel: number): { minLevel: number; maxLevel: number } {
  const low = Math.min(100, Math.max(minLevel, wildLevelFloor(speciesId)));
  return { minLevel: low, maxLevel: Math.min(100, Math.max(low, maxLevel)) };
}

type Slot = { speciesId: number; minLevel: number; maxLevel: number; weight: number };
/** Applies wildSpeciesForBand to source slots, merging a pre-evolution with its own slot. */
export function fitWildSlots<S extends Slot>(slots: readonly S[], bandFor: (slot: S) => { minLevel: number; maxLevel: number }): S[] {
  const merged = new Map<number, S>();
  for (const slot of slots) {
    const band = bandFor(slot), speciesId = wildSpeciesForBand(slot.speciesId, band.maxLevel), range = wildLevelRange(speciesId, band.minLevel, band.maxLevel);
    const prior = merged.get(speciesId);
    merged.set(speciesId, prior
      ? { ...prior, minLevel: Math.min(prior.minLevel, range.minLevel), maxLevel: Math.max(prior.maxLevel, range.maxLevel), weight: prior.weight + slot.weight }
      : { ...slot, speciesId, ...range });
  }
  return [...merged.values()];
}

const baseStatTotal = (speciesId: number) => Object.values(getSpecies(speciesId).baseStats).reduce((sum, value) => sum + value, 0);
/** Each generation's three starters, and the pseudo-legendary lines. */
const STARTER_BASES = [1,4,7,152,155,158,252,255,258,387,390,393,495,498,501,650,653,656,722,725,728,810,813,816,906,909,912];
const PSEUDO_LEGENDARY_BASES = [147,246,371,374,443,633,704,782,885,996];
function lineStages(bases: readonly number[]): Map<number, number> {
  const stages = new Map<number, number>();
  for (const base of bases) {
    let frontier = [base];
    for (let stage = 0; frontier.length; stage++) { for (const id of frontier) stages.set(id, stage); frontier = frontier.flatMap(id => getSpecies(id).evolutions.map(evolution => evolution.target)); }
  }
  return stages;
}
const starterStages = lineStages(STARTER_BASES), pseudoStages = lineStages(PSEUDO_LEGENDARY_BASES);
export const isLegendaryOrMythical = (speciesId: number) => legendary.has(speciesId);

export type RareSpawnProfile = { minLevel: number; minBadges: number };
/**
 * Where a rare (supplemental) spawn belongs, from biology instead of Pokédex order:
 * never below the evolution floor, stronger species later (base stat total), starter lines
 * from mid-game, pseudo-legendary and 570+ total species and legendaries only with eight badges.
 */
export function rareSpawnProfile(speciesId: number): RareSpawnProfile {
  const total = baseStatTotal(speciesId);
  const power = legendary.has(speciesId) || total >= 570 ? 50 : total >= 540 ? 30 : total >= 500 ? 25 : total >= 450 ? 20 : 0;
  const starter = starterStages.get(speciesId), pseudo = pseudoStages.get(speciesId);
  const minBadges = legendary.has(speciesId) || total >= 570 ? 8
    : pseudo !== undefined ? [4, 6, 8][pseudo]
    : starter !== undefined ? [4, 5, 6][starter] : 0;
  return { minLevel: Math.max(wildLevelFloor(speciesId), power), minBadges };
}

/** Running maximum of each gym's ace level: gym 1..8. */
function aceLevels(region: string): number[] {
  const teams = Object.hasOwn(GYM_TEAMS, region) ? GYM_TEAMS[region as keyof typeof GYM_TEAMS] : undefined;
  let best = 0;
  return Array.from({ length: 8 }, (_, index) => (best = Math.max(best, ...(teams?.[index + 1] ?? [[0, 5 + index * 6]]).map(([, level]) => level))));
}
/** Fewest badges after which the next gym's ace reaches this level. */
export function badgesForWildLevel(region: string, level: number): number {
  const aces = aceLevels(region), index = aces.findIndex(ace => ace >= level);
  return index < 0 ? 8 : index;
}
/** Level a player holds right after earning this many badges: the last ace beaten, less five. */
export function badgeStageLevel(region: string, badges: number): number {
  return badges <= 0 ? 1 : Math.max(1, aceLevels(region)[Math.min(8, badges) - 1] - 5);
}

export type RareBiome = 'meadow' | 'forest' | 'lake' | 'rock';
/**
 * A place that can host rare spawns. stages: the badge stages its band serves (one stage for an authored
 * anchor, a range for a wide source band such as a Lv.5-35 sea route). gate: badges needed to reach it.
 */
export type RareAnchor = { locationId: string; biome: RareBiome; stages: readonly [number, number]; gate: number; minLevel: number; maxLevel: number };
/** The badge stages a level band serves in a region. */
export const bandStages = (region: string, minLevel: number, maxLevel: number, gate = 0): [number, number] =>
  [Math.max(gate, badgesForWildLevel(region, minLevel)), Math.max(gate, badgesForWildLevel(region, maxLevel))];
const RARE_ANCHOR_SHARE = 6;
export type RarePlacement = { anchor: RareAnchor; requiredBadges: number; minLevel: number };
export function preferredRareBiome(speciesId: number, extendedRock = false): RareBiome {
  const types = getSpecies(speciesId).types;
  return types.includes('water') ? 'lake' : types.some(type => type === 'rock' || type === 'ground' || (extendedRock && type === 'steel')) ? 'rock'
    : types.some(type => type === 'bug' || type === 'grass') ? 'forest' : 'meadow';
}
/** Habitat mismatch, in badge stages: a land species takes open meadow before other ground. */
function biomePenalty(preferred: RareBiome, biome: RareBiome): number {
  if (preferred === biome) return 0;
  if (preferred === 'lake' || biome === 'lake') return 20;
  return biome === 'meadow' ? 1 : 2;
}
/**
 * Places a rare spawn on an anchor whose band can hold its minimum level, choosing the best mix of
 * habitat and badge stage (a Bulbasaur needing four badges prefers the stage-4 meadow over the stage-0
 * forest). requiredBadges never drops below the anchor's gate. The spawn level starts at the species
 * minimum; on a band spanning several stages it is lifted to the stage's level inside the band.
 */
export function placeRareSpecies(region: string, speciesId: number, anchors: readonly RareAnchor[], preferred: RareBiome, load?: Map<string, number>): RarePlacement {
  if (!anchors.length) throw new Error(`No rare encounter anchor for ${region}:${speciesId}`);
  const profile = rareSpawnProfile(speciesId);
  const need = Math.max(profile.minBadges, badgesForWildLevel(region, profile.minLevel));
  // Water species stay on water and land species on land whenever the region has such a place.
  const medium = anchors.filter(anchor => (anchor.biome === 'lake') === (preferred === 'lake')), places = medium.length ? medium : anchors;
  const holding = places.filter(anchor => anchor.maxLevel >= profile.minLevel);
  // No band reaches the minimum: use the strongest places, and the spawn level still respects it.
  const strongest = Math.max(...places.map(anchor => anchor.maxLevel));
  const eligible = holding.length ? holding : places.filter(anchor => anchor.maxLevel >= strongest - 5);
  const stageDistance = ({ stages: [low, high] }: RareAnchor) => need < low ? low - need : need > high ? need - high : 0;
  // Every RARE_ANCHOR_SHARE species already on an anchor weigh like one badge stage, so the rare cycle stays short.
  const score = (anchor: RareAnchor) => [biomePenalty(preferred, anchor.biome) + stageDistance(anchor) + Math.floor((load?.get(anchor.locationId) ?? 0) / RARE_ANCHOR_SHARE), anchor.stages[0], anchor.maxLevel];
  const compare = (a: RareAnchor, b: RareAnchor) => { const x = score(a), y = score(b); for (let index = 0; index < x.length; index++) if (x[index] !== y[index]) return x[index] - y[index]; return 0; };
  const ranked = [...eligible].sort(compare), ties = ranked.filter(anchor => compare(anchor, ranked[0]) === 0);
  const anchor = ties[speciesId % ties.length];
  load?.set(anchor.locationId, (load.get(anchor.locationId) ?? 0) + 1);
  const requiredBadges = Math.max(need, anchor.gate);
  // A band that spans several stages (Lv.5-35) starts the spawn at the stage's level; a one-stage band already is that stage.
  const stageLevel = anchor.stages[0] < anchor.stages[1] ? Math.min(anchor.maxLevel, badgeStageLevel(region, requiredBadges)) : 1;
  return { anchor, requiredBadges, minLevel: Math.max(profile.minLevel, stageLevel) };
}

/** Rare spawn levels start at the placement minimum inside the local band and span at most five levels. */
export function rareSpawnLevels(minLevel: number, band: { min: number; max: number }): { minLevel: number; maxLevel: number } {
  const low = Math.min(100, Math.max(band.min, minLevel));
  return { minLevel: low, maxLevel: Math.max(low, Math.min(band.max, low + 5)) };
}
