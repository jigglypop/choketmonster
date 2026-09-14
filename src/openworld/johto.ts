import type { WorldSample } from './types';
import type { KantoGate, KantoGym, KantoLocation, KantoLocationKind, KantoTraversal } from './kanto';
import { terrainPlateauHeight } from './terrain-elevation';
import {
  JOHTO_WORLD_LOCATION_TO_POKEAPI, johtoGoldEncounterPools, type JohtoGoldEncounterPool,
} from '../data/johto-gold-encounters';

export type JohtoLocation = KantoLocation;
export type JohtoGate = KantoGate;
export type JohtoGym = KantoGym;
export type JohtoTraversal = KantoTraversal;

export const JOHTO_MAP_VERSION = 'johto-v2' as const;
export const JOHTO_START = { x: 65, z: 70 } as const;

export const johtoGoldSourceLocationId = (id: string): string => {
  return JOHTO_WORLD_LOCATION_TO_POKEAPI[id as keyof typeof JOHTO_WORLD_LOCATION_TO_POKEAPI] ?? id;
};

function sourcePools(id: string, kind: KantoLocationKind): readonly JohtoGoldEncounterPool[] {
  const area = id === 'dark-cave-east' ? 'blackthorn-city-entrance' : id === 'dark-cave-west' ? 'violet-city-entrance' : undefined;
  const matching = (method: JohtoGoldEncounterPool['method']) => johtoGoldEncounterPools(id, method, 'day', area);
  return matching(kind === 'sea' ? 'surf' : 'walk');
}

const location = (
  id: string,
  name: string,
  x: number,
  z: number,
  kind: KantoLocationKind,
  minLevel: number,
  maxLevel: number,
  requiredBadges = 0,
): JohtoLocation => {
  const pools = sourcePools(id, kind);
  const slots = pools.flatMap(pool => pool.slots);
  return {
    id, name, x, z, kind,
    minLevel: slots.length ? Math.min(...slots.map(slot => slot.minLevel)) : minLevel,
    maxLevel: slots.length ? Math.max(...slots.map(slot => slot.maxLevel)) : maxLevel,
    encounters: [...new Set(slots.map(slot => slot.speciesId))],
    requiredBadges,
  };
};

// Coordinates preserve the relative layout of the Gold/Silver overworld:
// New Bark is southeast, Goldenrod is west-central, Ecruteak is north of it,
// the Olivine/Cianwood sea is west, and Blackthorn sits beyond the northeast mountains.
export const JOHTO_LOCATIONS: readonly JohtoLocation[] = [
  location('new-bark', '연두마을', 65, 70, 'town', 2, 4),
  location('route-27', '27번 도로', 88, 70, 'route', 28, 38),
  location('tohjo-falls', '동성폭포', 106, 60, 'cave', 30, 42),
  location('mt-silver', '은빛산', 114, 48, 'cave', 40, 55, 8),
  location('route-29', '29번 도로', 50, 65, 'route', 2, 4),
  location('cherrygrove', '무궁시티', 35, 58, 'town', 2, 5),
  location('route-30', '30번 도로', 34, 43, 'route', 3, 5),
  location('route-31', '31번 도로', 24, 30, 'route', 3, 6),
  location('violet', '도라지시티', 12, 25, 'town', 4, 8),
  location('sprout-tower', '모다피의 탑', 16, 18, 'special', 3, 6),
  location('route-32', '32번 도로', 5, 34, 'route', 4, 8),
  location('ruins-of-alph', '알프의 유적', -2, 25, 'special', 5, 10),
  location('union-cave', '연결동굴', 0, 44, 'cave', 5, 9),
  location('route-33', '33번 도로', -8, 50, 'route', 5, 9),
  location('azalea', '고동마을', -12, 55, 'town', 6, 12),
  location('slowpoke-well', '야돈의 우물', -12, 63, 'cave', 6, 10),
  location('ilex-forest', '너도밤나무숲', -25, 40, 'forest', 5, 10),
  location('route-34', '34번 도로', -35, 20, 'route', 7, 12),
  location('goldenrod', '금빛시티', -35, 0, 'town', 8, 16),
  location('route-35', '35번 도로', -34, -10, 'route', 10, 16),
  location('national-park', '자연공원', -27, -17, 'forest', 10, 18),
  location('route-36', '36번 도로', -8, -10, 'route', 12, 18),
  location('route-37', '37번 도로', -8, -20, 'route', 13, 19),
  location('ecruteak', '인주시티', -8, -28, 'town', 14, 22),
  location('burned-tower', '불탄탑', -15, -34, 'special', 14, 22),
  location('bell-tower', '방울탑', -1, -35, 'special', 20, 40),
  location('route-38', '38번 도로', -24, -25, 'route', 14, 22),
  location('route-39', '39번 도로', -38, -22, 'route', 15, 23),
  location('olivine', '담청시티', -45, -20, 'town', 16, 25),
  location('lighthouse', '빛남의 등대', -51, -27, 'special', 17, 26),
  location('route-40', '40번 수로', -55, -6, 'sea', 16, 25),
  location('whirl-islands', '소용돌이섬', -65, 2, 'cave', 20, 30),
  location('route-41', '41번 수로', -70, 7, 'sea', 18, 28),
  location('cianwood', '진청시티', -75, 10, 'town', 20, 30),
  location('route-42-west', '42번 도로 서쪽', 5, -28, 'route', 15, 24),
  location('mt-mortar', '절구산', 17, -28, 'cave', 16, 28),
  location('route-42-east', '42번 도로 동쪽', 27, -28, 'route', 16, 25),
  location('mahogany', '황토마을', 35, -28, 'town', 17, 28),
  location('route-43', '43번 도로', 35, -44, 'route', 17, 28),
  location('lake-of-rage', '분노의호수', 35, -62, 'sea', 20, 35),
  location('route-44', '44번 도로', 49, -28, 'route', 20, 32),
  location('ice-path', '얼음샛길', 61, -28, 'cave', 22, 36),
  location('blackthorn', '검은먹시티', 72, -28, 'town', 24, 40),
  location('dragons-den', '용의굴', 80, -36, 'cave', 30, 45),
  location('route-45', '45번 도로', 70, -5, 'route', 22, 36),
  location('route-46', '46번 도로', 65, 35, 'route', 3, 12),
  location('dark-cave-east', '어둠의동굴 동쪽', 56, -5, 'cave', 12, 24),
  location('dark-cave-west', '어둠의동굴 서쪽', 19, 28, 'cave', 3, 12),
];

export const JOHTO_CONNECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['new-bark', 'route-27'], ['route-27', 'tohjo-falls'], ['tohjo-falls', 'mt-silver'],
  ['new-bark', 'route-29'], ['route-29', 'cherrygrove'], ['cherrygrove', 'route-30'], ['route-30', 'route-31'], ['route-31', 'violet'],
  ['violet', 'sprout-tower'], ['violet', 'route-32'], ['route-32', 'ruins-of-alph'], ['ruins-of-alph', 'route-36'], ['route-32', 'union-cave'], ['union-cave', 'route-33'], ['route-33', 'azalea'],
  ['azalea', 'slowpoke-well'], ['azalea', 'ilex-forest'], ['ilex-forest', 'route-34'], ['route-34', 'goldenrod'],
  ['goldenrod', 'route-35'], ['route-35', 'national-park'], ['national-park', 'route-36'], ['route-36', 'violet'], ['route-36', 'route-37'], ['route-37', 'ecruteak'],
  ['ecruteak', 'burned-tower'], ['ecruteak', 'bell-tower'], ['ecruteak', 'route-38'], ['route-38', 'route-39'], ['route-39', 'olivine'], ['olivine', 'lighthouse'],
  ['olivine', 'route-40'], ['route-40', 'whirl-islands'], ['whirl-islands', 'route-41'], ['route-41', 'cianwood'],
  ['ecruteak', 'route-42-west'], ['route-42-west', 'mt-mortar'], ['mt-mortar', 'route-42-east'], ['route-42-east', 'mahogany'],
  ['mahogany', 'route-43'], ['route-43', 'lake-of-rage'], ['mahogany', 'route-44'], ['route-44', 'ice-path'], ['ice-path', 'blackthorn'], ['blackthorn', 'dragons-den'],
  ['blackthorn', 'route-45'], ['route-45', 'route-46'], ['route-46', 'route-29'],
  ['route-45', 'dark-cave-east'], ['dark-cave-west', 'route-31'],
];

export const JOHTO_SURFACE_CONNECTIONS = JOHTO_CONNECTIONS;

// Terrain stays independent of campaign state. Regional gyms and badge progress
// are supplied by game/campaign.ts; requiredBadges gates the Silver Mountain area.
export const JOHTO_GATES: readonly JohtoGate[] = [];
export const JOHTO_GYMS: readonly JohtoGym[] = [];

const byId = new Map(JOHTO_LOCATIONS.map(item => [item.id, item]));
const surfaceSegments = JOHTO_SURFACE_CONNECTIONS.map(([from, to]) => {
  const a = byId.get(from)!, b = byId.get(to)!, dx = b.x - a.x, dz = b.z - a.z;
  return { from: a, to: b, x: a.x, z: a.z, dx, dz, lengthSquared: dx * dx + dz * dz || 1 };
});
const towns = JOHTO_LOCATIONS.filter(item => item.kind === 'town');
const baseHeight = (x: number, z: number) => .2 * Math.sin((x + 11) * .085) + .16 * Math.cos((z - 7) * .075);
const townPlateaus = towns.map(item => ({ x: item.x, z: item.z, height: baseHeight(item.x, item.z) }));
const buildingOffsetCache = new Map<string, ReadonlyArray<readonly [number, number]>>();
const BUILDING_CANDIDATES = [[-5, -4], [5, -4], [-5, 4], [5, 4], [-6, 0], [6, 0], [0, -6], [0, 6]] as const;

export function distanceToJohtoPath(x: number, z: number): number {
  let nearestSquared = Infinity;
  for (const segment of surfaceSegments) {
    const t = Math.max(0, Math.min(1, ((x - segment.x) * segment.dx + (z - segment.z) * segment.dz) / segment.lengthSquared));
    const offsetX = x - segment.x - segment.dx * t, offsetZ = z - segment.z - segment.dz * t;
    nearestSquared = Math.min(nearestSquared, offsetX * offsetX + offsetZ * offsetZ);
  }
  return Math.sqrt(nearestSquared);
}

export function johtoLocationAt(x: number, z: number): JohtoLocation {
  let nearest = JOHTO_LOCATIONS[0], distanceSquared = Infinity;
  for (const item of JOHTO_LOCATIONS) {
    const dx = x - item.x, dz = z - item.z, next = dx * dx + dz * dz;
    if (next < distanceSquared) { nearest = item; distanceSquared = next; }
  }
  return nearest;
}

export function johtoBuildingOffsets(town: JohtoLocation): ReadonlyArray<readonly [number, number]> {
  const cached = buildingOffsetCache.get(town.id);
  if (cached) return cached;
  const offsets = BUILDING_CANDIDATES.filter(([dx, dz]) => distanceToJohtoPath(town.x + dx, town.z + dz) > 3.5).slice(0, 3);
  buildingOffsetCache.set(town.id, offsets);
  return offsets;
}

function townBuildingAt(x: number, z: number, town: JohtoLocation): boolean {
  return johtoBuildingOffsets(town).some(([dx, dz]) => Math.abs(x - town.x - dx) < 1.9 && Math.abs(z - town.z - dz) < 1.7);
}

export function sampleJohtoWorld(x: number, z: number): WorldSample {
  const height = baseHeight(x, z);
  const joinedHeight = (value: number) => terrainPlateauHeight(value, x, z, townPlateaus);
  if (![x, z].every(Number.isFinite) || Math.abs(x) > 120 || Math.abs(z) > 120) return { height, biome: 'rock', blocked: true };
  const nearest = johtoLocationAt(x, z), distance = Math.hypot(x - nearest.x, z - nearest.z), pathDistance = distanceToJohtoPath(x, z);
  const town = towns.find(item => Math.hypot(x - item.x, z - item.z) < 8.5);
  if (town) return { height: joinedHeight(height), biome: 'meadow', blocked: townBuildingAt(x, z, town) };
  const radius = nearest.kind === 'forest' ? 7.5 : nearest.kind === 'sea' ? 6.5 : nearest.kind === 'town' ? 8.5 : nearest.kind === 'route' ? 4.8 : 5.5;
  const playable = pathDistance < 3.2 || distance < radius;
  const westernSea = x < -48 && z > -12 && z < 22;
  const rageLake = Math.hypot(x - 35, z + 62) < 11;
  if ((westernSea || rageLake) && !playable) return { height: joinedHeight(-.7), biome: 'lake', blocked: true };
  if (pathDistance < 3.2) {
    let closest = surfaceSegments[0], closestT = 0, closestSquared = Infinity;
    for (const segment of surfaceSegments) {
      const t = Math.max(0, Math.min(1, ((x - segment.x) * segment.dx + (z - segment.z) * segment.dz) / segment.lengthSquared));
      const dx = x - segment.x - segment.dx * t, dz = z - segment.z - segment.dz * t, squared = dx * dx + dz * dz;
      if (squared < closestSquared) { closest = segment; closestT = t; closestSquared = squared; }
    }
    const surface = (kind: KantoLocationKind) => kind === 'sea' ? -.66 : height + (kind === 'cave' ? .58 : 0);
    const pathHeight = surface(closest.from.kind) + (surface(closest.to.kind) - surface(closest.from.kind)) * closestT;
    const pathBiome = closestT < .5 ? closest.from.kind : closest.to.kind;
    return { height: joinedHeight(pathHeight), biome: pathBiome === 'sea' ? 'lake' : pathBiome === 'cave' ? 'rock' : pathBiome === 'forest' ? 'forest' : 'meadow', blocked: false };
  }
  if (nearest.kind === 'sea' && playable) return { height: joinedHeight(-.66), biome: 'lake', blocked: false };
  if (playable) {
    const rocky = nearest.kind === 'cave' || nearest.id === 'route-44' || nearest.id === 'route-45';
    return { height: joinedHeight(rocky ? height + .58 : height), biome: rocky ? 'rock' : nearest.kind === 'forest' ? 'forest' : 'meadow', blocked: false };
  }
  const mountain = x > 42 || z < -32;
  return { height: joinedHeight(height + (mountain ? .72 : .18)), biome: mountain ? 'rock' : 'forest', blocked: true };
}

export function isJohtoPlayable(x: number, z: number): boolean { return !sampleJohtoWorld(x, z).blocked; }

export function evaluateJohtoTraversal(_from: { x: number; z: number }, to: { x: number; z: number }, badges: number): JohtoTraversal {
  const destination = johtoLocationAt(to.x, to.z);
  if (!Number.isFinite(badges) || badges < 0) return { allowed: false, location: destination, reason: '배지 정보가 올바르지 않습니다.' };
  if (badges < destination.requiredBadges) return { allowed: false, location: destination, reason: `${destination.name}은(는) 배지 ${destination.requiredBadges}개가 필요합니다.` };
  return sampleJohtoWorld(to.x, to.z).blocked
    ? { allowed: false, location: destination, reason: '성도 지도에 표시된 길과 탐험 지역을 벗어날 수 없습니다.' }
    : { allowed: true, location: destination };
}

export function safeJohtoArrival(locationId: string, badges = 0): { x: number; z: number } | undefined {
  const target = byId.get(locationId);
  if (!target || !Number.isFinite(badges) || badges < target.requiredBadges) return undefined;
  const candidates = [[target.x, target.z], [target.x, target.z + 2], [target.x + 2, target.z], [target.x - 2, target.z], [target.x, target.z - 2]] as const;
  const arrival = candidates.find(([x, z]) => isJohtoPlayable(x, z));
  return arrival ? { x: arrival[0], z: arrival[1] } : undefined;
}

export function nearestJohtoWalkable(x: number, z: number, badges = 0): { x: number; z: number } | undefined {
  if (![x, z, badges].every(Number.isFinite) || badges < 0) return undefined;
  if (isJohtoPlayable(x, z) && johtoLocationAt(x, z).requiredBadges <= badges) return { x, z };
  for (let radius = .5; radius <= 18; radius += .5) for (let step = 0; step < 32; step += 1) {
    const angle = step / 32 * Math.PI * 2, candidate = { x: x + Math.cos(angle) * radius, z: z + Math.sin(angle) * radius };
    if (isJohtoPlayable(candidate.x, candidate.z) && johtoLocationAt(candidate.x, candidate.z).requiredBadges <= badges) return candidate;
  }
  const fallback = [...JOHTO_LOCATIONS]
    .filter(location => location.requiredBadges <= badges)
    .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
  return fallback ? safeJohtoArrival(fallback.id, badges) : undefined;
}

export function johtoTravelPoint(townId: string): { x: number; z: number } | undefined {
  const town = byId.get(townId);
  return town?.kind === 'town' ? safeJohtoArrival(townId) : undefined;
}

export function johtoEncounters(locationId: string, badges: number): number[] {
  const found = byId.get(locationId);
  return found && Number.isFinite(badges) && badges >= found.requiredBadges ? [...found.encounters] : [];
}

export function johtoGateHalfWidth(_gate: JohtoGate): number { return 0; }

/** Ready-to-admit atlas contract; atlas.ts remains responsible for gameplay exposure. */
export const JOHTO_ATLAS = {
  id: 'johto' as const,
  name: '성도',
  englishName: 'Johto',
  defaultVersion: 'gold',
  mapVersion: JOHTO_MAP_VERSION,
  start: JOHTO_START,
  locations: JOHTO_LOCATIONS,
  connections: JOHTO_CONNECTIONS,
  surfaceConnections: JOHTO_SURFACE_CONNECTIONS,
  gates: JOHTO_GATES,
  gyms: JOHTO_GYMS,
  palette: { ground: '#83a66a', water: '#5b9fc0', town: '#d8aa65' },
  sample: sampleJohtoWorld,
  locationAt: johtoLocationAt,
  distanceToPath: distanceToJohtoPath,
  evaluateTraversal: evaluateJohtoTraversal,
  safeArrival: safeJohtoArrival,
  nearestWalkable: nearestJohtoWalkable,
  travelPoint: johtoTravelPoint,
  buildingOffsets: johtoBuildingOffsets,
  encounters: johtoEncounters,
  gateHalfWidth: johtoGateHalfWidth,
};
