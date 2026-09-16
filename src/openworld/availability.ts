import { WORLDS, regionForVersion, type WorldRegionId } from './atlas';
import { getVersionSpeciesIds } from '../data/pokemon-versions';
import { EXPANSION_ASSET_AUDIT } from '../data/expansion-asset-availability';

// Atlas definitions also decode old saves. They are not a list of shipped maps.
// Public map facts may be reconstructed with our own 3D terrain and cleared assets.
// Only regions with a verified geometry, traversal and encounter implementation ship.
const playableRegions = new Set<WorldRegionId>(['kanto', 'johto', 'hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'hisui', 'paldea']);
export const PLAYABLE_WORLDS = WORLDS.filter(world => playableRegions.has(world.id));
const expansionNatives = Object.entries(EXPANSION_ASSET_AUDIT.regions).filter(([region]) => playableRegions.has(region as WorldRegionId))
  .flatMap(([, { nationalDex: [first, last] }]) => Array.from({ length: last - first + 1 }, (_, index) => first + index));
const playableSpeciesIds = Object.freeze([...new Set([...PLAYABLE_WORLDS.flatMap(world => getVersionSpeciesIds(world.defaultVersion)), ...expansionNatives])].sort((a, b) => a - b));
const playableSpecies = new Set(playableSpeciesIds);
export const PLAYABLE_SPECIES_IDS = playableSpeciesIds;
const nativeDexRanges: Readonly<Partial<Record<WorldRegionId, readonly [number, number]>>> = {
  kanto: [1, 151], johto: [152, 251], hoenn: [252, 386], sinnoh: [387, 493],
  unova: [494, 649], kalos: [650, 721], alola: [722, 809], galar: [810, 898],
  hisui: [899, 905], paldea: [906, 1025],
};
/** Species whose native region has a shipped map, optionally narrowed to one version dex. */
export function getPlayableSpeciesIds(version = 'national'): number[] {
  let versionIds: readonly number[];
  try { versionIds = getVersionSpeciesIds(version); }
  catch { return []; }
  if (!versionIds.length) return [];
  if (version !== 'national') {
    try { if (!isPlayableWorldRegion(regionForVersion(version))) return []; }
    catch { return []; }
  }
  return versionIds.filter(id => playableSpecies.has(id));
}
/** Native National Dex range for a shipped region, including version-independent supplements. */
export function getRegionalNativeSpeciesIds(region: WorldRegionId): number[] {
  const range = nativeDexRanges[region];
  if (!range || !isPlayableWorldRegion(region)) return [];
  return Array.from({ length: range[1] - range[0] + 1 }, (_, index) => range[0] + index)
    .filter(id => playableSpecies.has(id));
}
export function isPlayableSpecies(id: number): boolean {
  return Number.isSafeInteger(id) && playableSpecies.has(id);
}
export function isPlayableWorldRegion(id: string): boolean {
  return playableRegions.has(id as WorldRegionId);
}
export function playableWorldRegionForVersion(version: string): WorldRegionId {
  const region = version === 'national' ? 'kanto' : regionForVersion(version);
  return isPlayableWorldRegion(region) ? region : 'kanto';
}
export function isPlayableAdventureVersion(version: string): boolean {
  return version === 'national' || isPlayableWorldRegion(regionForVersion(version));
}
