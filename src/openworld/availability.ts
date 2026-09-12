import { WORLDS, regionForVersion, type WorldRegionId } from './atlas';

// Atlas definitions also decode old saves. They are not a list of shipped maps.
// Additional regions stay out of gameplay until actual 3D map assets are acquired.
const playableRegions = new Set<WorldRegionId>(['kanto']);
export const PLAYABLE_WORLDS = WORLDS.filter(world => playableRegions.has(world.id));
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
