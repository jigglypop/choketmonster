import { getWorldAtlas } from './atlas';
import { caveMouths, insideCaveMouth } from './caves';
import type { WorldSample } from './types';
import { WORLD_SCALE, type ScenePoint } from './world-space';

/** An indoor hall laid over its town building or league stadium. Outside the hall the surface stays as it is. */
export type GymScene = {
  kind: 'gym' | 'league';
  sceneId: string;
  regionId: string;
  locationId: string;
  minX: number; maxX: number; minZ: number; maxZ: number;
  floorY: number;
  /** Walkable ground in front of the building on the surface. */
  door: ScenePoint;
  /** Arrival point just inside the hall entrance. */
  entrance: ScenePoint;
  /** Exit mat inside the entrance. */
  exit: ScenePoint;
  /** Where the leader stands at the far end of the court. */
  leader: ScenePoint;
  /** Where the challenger stands across the court from the leader. */
  challenger: ScenePoint;
  /** The marked battle court. Stepping onto it starts the leader battle. */
  court: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Where the challenger's partner battles: half a gap short of the court centre, facing the opponent across it. */
  battleSpot: ScenePoint;
  contains(x: number, z: number, margin?: number): boolean;
  sample(x: number, z: number): WorldSample;
};

const HALL_WIDTH = 22, HALL_DEPTH = 34, WALL_CLEARANCE = 1.4;
/** The league hall is wider and deeper to hold the statue gallery before the court. */
const LEAGUE_WIDTH = 28, LEAGUE_DEPTH = 46;
/** The league stadium's entry walk ends this far south of its centre. */
const STADIUM_FRONT = 10;
const scenes = new Map<string, GymScene | null>();
/** Metres between the two battling Pokémon in a hall; they stand either side of the court centre. */
export const HALL_BATTLE_GAP = 6;

export const LEAGUE_LOCATION_IDS: Readonly<Partial<Record<string, string>>> = Object.freeze({
  johto: 'tohjo-falls', kanto: 'indigo-plateau', hoenn: 'ever-grande-city',
  sinnoh: 'sinnoh-pokemon-league', unova: 'unova-pokemon-league',
  kalos: 'kalos-pokemon-league', alola: 'alola-pokemon-league',
  galar: 'galar-pokemon-league', hisui: 'temple-of-sinnoh', paldea: 'paldea-pokemon-league',
});

export function isRegionalLeagueLocation(region: string, locationId: string): boolean {
  return LEAGUE_LOCATION_IDS[region] === locationId;
}

export const gymSceneId = (regionId: string, locationId: string) => `gym:${regionId}:${locationId}`;
export const leagueSceneId = (regionId: string, locationId: string) => `league:${regionId}:${locationId}`;
export const isGymSceneId = (sceneId: string | undefined): boolean => Boolean(sceneId?.startsWith('gym:') || sceneId?.startsWith('league:'));

/** The gym building is the town's third building; towns without it use a spot behind the square. */
export function gymBuildingPoint(regionId: string, locationId: string): ScenePoint | undefined {
  const atlas = getWorldAtlas(regionId), place = atlas.locations.find(item => item.id === locationId);
  if (!place) return undefined;
  if (place.kind !== 'town') return fieldGymPoint(regionId, place);
  const offset = atlas.buildingOffsets(place)[2] ?? [0, 5 * WORLD_SCALE];
  return { x: place.x + offset[0], z: place.z + offset[1] };
}

/** Building centre to the walkable ground before its door (-z): the front wall, then the step out. */
const DOOR_REACH = 3.3 * WORLD_SCALE;
const fieldGyms = new Map<string, ScenePoint | undefined>();
/**
 * A gym away from any town (Alola trial sites, Hisui arenas, Paldea's mountain gym) stands where its place's
 * clearing meets rock or woods north of it, so its door faces the clearing like a town gym's. It keeps clear of
 * cave mouths and of the league stadium; open ground with no edge in reach takes the nearest walkable door.
 */
function fieldGymPoint(regionId: string, place: { id: string; x: number; z: number }): ScenePoint | undefined {
  const key = `${regionId}:${place.id}`;
  if (fieldGyms.has(key)) return fieldGyms.get(key);
  const atlas = getWorldAtlas(regionId), blocked = (x: number, z: number) => atlas.sample(x, z).blocked, mouths = caveMouths(regionId);
  const league = atlas.locations.find(item => item.id === LEAGUE_LOCATION_IDS[regionId]);
  const usable = (building: ScenePoint) => {
    const door = { x: building.x, z: building.z - DOOR_REACH };
    if (blocked(door.x, door.z) || blocked(door.x, door.z + 1.5)) return false;
    if (league && Math.hypot(building.x - league.x, building.z - league.z) < 18) return false;
    return !mouths.some(mouth => insideCaveMouth(mouth, door.x, door.z, 2) || insideCaveMouth(mouth, building.x, building.z, 4));
  };
  const walled = (building: ScenePoint) => [[0, 0], [-2.8, 0], [2.8, 0], [-2.8, 2.4], [2.8, 2.4], [0, 2.4]].every(([dx, dz]) => blocked(building.x + dx, building.z + dz));
  const candidates: ScenePoint[] = [];
  for (let reach = 4; reach <= 30; reach++) for (const offset of [0, -2, 2, -4, 4, -6, 6, -8, 8]) candidates.push({ x: place.x + offset, z: place.z + reach });
  const point = candidates.find(building => usable(building) && walled(building)) ?? candidates.find(usable);
  fieldGyms.set(key, point);
  return point;
}

export const onGymCourt = (scene: GymScene, x: number, z: number): boolean =>
  x >= scene.court.minX && x <= scene.court.maxX && z >= scene.court.minZ && z <= scene.court.maxZ;

type HallLayout = { kind: GymScene['kind']; centerX: number; front: number; outside: ScenePoint; width: number; depth: number };

function hallLayout(kind: string, regionId: string, locationId: string): HallLayout | undefined {
  if (kind === 'gym') {
    const building = gymBuildingPoint(regionId, locationId); if (!building) return undefined;
    // Buildings face -z. The hall runs back from the front wall of the building.
    const front = building.z - 1.7 * WORLD_SCALE;
    return { kind, centerX: building.x, front, outside: { x: building.x, z: front - 1.6 * WORLD_SCALE }, width: HALL_WIDTH, depth: HALL_DEPTH };
  }
  if (kind === 'league') {
    const stadium = getWorldAtlas(regionId).locations.find(item => item.id === locationId); if (!stadium) return undefined;
    // The stadium opens to the south (+z). The hall is laid out beyond its entry walk.
    const outside = { x: stadium.x, z: stadium.z + STADIUM_FRONT };
    return { kind, centerX: stadium.x, front: outside.z + 1.5, outside, width: LEAGUE_WIDTH, depth: LEAGUE_DEPTH };
  }
  return undefined;
}

export function getGymScene(sceneId: string): GymScene | undefined {
  if (!isGymSceneId(sceneId)) return undefined;
  const cached = scenes.get(sceneId);
  if (cached !== undefined) return cached ?? undefined;
  const [kind, regionId, locationId] = sceneId.split(':');
  const layout = regionId && locationId ? hallLayout(kind, regionId, locationId) : undefined;
  if (!layout) { scenes.set(sceneId, null); return undefined; }
  const atlas = getWorldAtlas(regionId), { centerX, front, width, depth } = layout;
  const door = atlas.nearestWalkable(layout.outside.x, layout.outside.z, 8) ?? layout.outside;
  const minX = centerX - width / 2, maxX = centerX + width / 2, minZ = front, maxZ = front + depth;
  const floorY = atlas.sample(door.x, door.z).height;
  const contains = (x: number, z: number, margin = 0) => x >= minX - margin && x <= maxX + margin && z >= minZ - margin && z <= maxZ + margin;
  const sample = (x: number, z: number): WorldSample => {
    if (![x, z].every(Number.isFinite)) return { height: floorY, exactHeight: true, biome: 'rock', blocked: true };
    if (contains(x, z, 2)) return { height: floorY, exactHeight: true, biome: 'meadow', blocked: !contains(x, z, -WALL_CLEARANCE) };
    return { ...atlas.sample(x, z), exactHeight: true };
  };
  const leader = { x: centerX, z: maxZ - (layout.kind === 'league' ? 6 : 4.5) };
  const challenger = { x: centerX, z: layout.kind === 'league' ? leader.z - 17 : minZ + 12 };
  const courtInset = layout.kind === 'league' ? 6 : 4;
  const court = { minX: minX + courtInset, maxX: maxX - courtInset, minZ: challenger.z + 1.5, maxZ: leader.z - 3 };
  const battleSpot = { x: centerX, z: (court.minZ + court.maxZ) / 2 - HALL_BATTLE_GAP / 2 };
  const scene: GymScene = {
    kind: layout.kind, sceneId, regionId, locationId, minX, maxX, minZ, maxZ, floorY, door,
    entrance: { x: centerX, z: minZ + 4 }, exit: { x: centerX, z: minZ + 2 },
    leader, challenger, court, battleSpot, contains, sample,
  };
  scenes.set(sceneId, scene);
  return scene;
}
