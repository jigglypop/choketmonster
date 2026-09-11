import type { WorldSample } from './types';
import { POKEMON } from '../data/pokemon';

export type KantoLocationKind = 'town' | 'route' | 'forest' | 'cave' | 'sea' | 'special';

export type KantoLocation = {
  id: string;
  name: string;
  x: number;
  z: number;
  kind: KantoLocationKind;
  minLevel: number;
  maxLevel: number;
  encounters: readonly number[];
  requiredBadges: number;
};

export type KantoGym = { locationId: string; badge: number; badgeName: string; name: string; speciesId: number; level: number };
export type KantoGate = { id: string; from: string; to: string; requiredBadges: number; reason: string; visible?: boolean };
export type KantoTraversal = { allowed: boolean; location: KantoLocation; gate?: KantoGate; reason?: string };

export const KANTO_MAP_VERSION = 'kanto-v2' as const;
export const KANTO_START = { x: -68, z: 82 } as const;

const location = (id: string, name: string, x: number, z: number, kind: KantoLocationKind, minLevel: number, maxLevel: number, encounters: readonly number[], requiredBadges = 0): KantoLocation =>
  ({ id, name, x, z, kind, minLevel, maxLevel, encounters, requiredBadges });

// Species are explicit per area. Levels are part of the location, never derived
// from the partner. Fully evolved and legendary species are kept out of early areas.
export const KANTO_LOCATIONS: readonly KantoLocation[] = [
  location('pallet', '태초마을', -68, 82, 'town', 2, 4, [16, 19]),
  location('route-1', '1번 도로', -68, 66, 'route', 2, 4, [16, 19]),
  location('viridian', '상록시티', -68, 50, 'town', 3, 5, [16, 19]),
  location('route-2-south', '2번 도로 남쪽', -68, 37, 'route', 3, 5, [16, 19, 10, 13]),
  location('viridian-forest', '상록숲', -68, 22, 'forest', 3, 6, [10, 13, 25]),
  location('route-2-north', '2번 도로 북쪽', -68, 8, 'route', 4, 7, [16, 19, 10, 13]),
  location('pewter', '회색시티', -68, -7, 'town', 6, 9, [16, 19, 21]),
  location('route-3', '3번 도로', -49, -12, 'route', 6, 10, [16, 21, 39, 56]),
  location('mt-moon', '달맞이산', -31, -14, 'cave', 8, 12, [35, 41, 74, 46]),
  location('route-4', '4번 도로', -12, -15, 'route', 8, 12, [19, 21, 23, 27]),
  location('cerulean', '블루시티', 8, -15, 'town', 10, 14, [19, 21, 43]),
  location('route-24', '24번 도로', 8, -32, 'route', 11, 16, [10, 13, 43, 63]),
  location('route-25', '25번 도로', 29, -39, 'route', 12, 17, [16, 43, 48, 69]),
  location('cerulean-cave', '블루동굴', -5, -35, 'special', 70, 70, [150], 8),
  location('route-5', '5번 도로', 8, -1, 'route', 12, 16, [16, 43, 52]),
  location('saffron', '노랑시티', 8, 15, 'town', 20, 30, [43, 52, 63, 106, 107, 122, 131]),
  location('route-6', '6번 도로', 8, 29, 'route', 13, 18, [16, 19, 52]),
  location('vermilion', '갈색시티', 8, 44, 'town', 15, 21, [19, 21, 96]),
  location('diglett-cave-east', '디그다의 굴 동쪽', 29, 43, 'cave', 15, 22, [50, 51]),
  location('diglett-cave-west', '디그다의 굴 서쪽', -56, 34, 'cave', 15, 22, [50, 51]),
  location('route-11', '11번 도로', 29, 44, 'route', 15, 22, [21, 23, 96]),
  location('route-12', '12번 도로', 48, 35, 'route', 20, 28, [16, 43, 44, 143]),
  location('lavender', '보라타운', 48, 15, 'town', 18, 25, [92, 93, 104]),
  location('pokemon-tower', '포켓몬타워', 55, 10, 'special', 20, 30, [92, 93, 104]),
  location('route-10-south', '10번 도로 남쪽', 48, -1, 'route', 16, 23, [21, 23, 100]),
  location('rock-tunnel', '돌산터널', 48, -16, 'cave', 16, 24, [41, 66, 74, 95]),
  location('route-10-north', '10번 도로 북쪽', 48, -29, 'route', 15, 22, [21, 23, 100]),
  location('power-plant', '무인발전소', 65, -28, 'cave', 32, 44, [81, 82, 100, 125]),
  location('zapdos-roost', '썬더 발전실', 72, -32, 'special', 50, 50, [145], 8),
  location('route-9', '9번 도로', 29, -22, 'route', 13, 20, [19, 21, 23]),
  location('route-8', '8번 도로', 34, 15, 'route', 18, 24, [16, 37, 52, 58]),
  location('route-7', '7번 도로', -7, 15, 'route', 18, 24, [16, 37, 52, 58]),
  location('celadon', '무지개시티', -25, 15, 'town', 20, 28, [43, 52, 58, 133, 137]),
  location('route-16', '16번 도로', -42, 25, 'route', 22, 30, [19, 20, 84, 143]),
  location('route-17', '17번 도로·사이클링로드', -43, 49, 'route', 24, 32, [19, 20, 21, 22]),
  location('route-18', '18번 도로', -31, 70, 'route', 25, 34, [19, 20, 21, 22, 108]),
  location('fuchsia', '연분홍시티', 3, 70, 'town', 25, 35, [48, 84, 102]),
  location('safari-zone', '사파리존', 3, 58, 'special', 22, 35, [29, 30, 46, 102, 111, 113, 114, 115, 123, 127, 128, 147]),
  location('route-15', '15번 도로', 24, 67, 'route', 24, 34, [16, 43, 48]),
  location('route-14', '14번 도로', 41, 59, 'route', 24, 34, [16, 43, 48]),
  location('route-13', '13번 도로', 48, 48, 'route', 22, 32, [16, 43, 48, 83]),
  location('route-19', '19번 수로', 3, 86, 'sea', 25, 38, [54, 60, 72, 73, 98, 116, 118, 120, 129]),
  location('route-20-east', '20번 수로 동쪽', -17, 96, 'sea', 28, 42, [54, 60, 72, 73, 90, 98, 116, 118, 120, 129]),
  location('seafoam-islands', '쌍둥이섬', -34, 96, 'cave', 30, 44, [41, 79, 86, 87, 124]),
  location('articuno-roost', '프리져 얼음방', -34, 104, 'special', 50, 50, [144], 8),
  location('route-20-west', '20번 수로 서쪽', -50, 96, 'sea', 28, 42, [54, 60, 72, 73, 90, 98, 116, 118, 120, 129]),
  location('cinnabar', '홍련섬', -68, 96, 'town', 32, 45, [58, 77, 88]),
  location('pokemon-mansion', '포켓몬저택', -75, 101, 'special', 32, 46, [20, 58, 88, 109, 110, 126, 132]),
  location('cinnabar-lab', '홍련 연구소', -60, 102, 'special', 30, 35, [1, 4, 7, 138, 140, 142]),
  location('route-21', '21번 수로', -68, 90, 'sea', 28, 42, [54, 60, 72, 73, 90, 98, 116, 118, 120, 129]),
  location('route-22', '22번 도로', -85, 49, 'route', 3, 9, [19, 21, 29, 32]),
  location('route-23', '23번 도로', -99, 24, 'route', 35, 50, [21, 22, 23, 24]),
  location('victory-road', '챔피언로드', -99, 0, 'cave', 40, 55, [42, 66, 67, 74, 95]),
  location('moltres-roost', '파이어 바위방', -106, 0, 'special', 50, 50, [146], 8),
  location('indigo-plateau', '석영고원', -99, -18, 'special', 50, 65, [42, 67, 75, 95, 112]),
  location('mew-sanctum', '환상의 정원', -109, -18, 'special', 70, 70, [151], 8),
];

export const KANTO_GYMS: readonly KantoGym[] = [
  { locationId: 'pewter', badge: 1, badgeName: '회색배지', name: '웅', speciesId: 95, level: 14 },
  { locationId: 'cerulean', badge: 2, badgeName: '블루배지', name: '이슬', speciesId: 121, level: 21 },
  { locationId: 'vermilion', badge: 3, badgeName: '오렌지배지', name: '마티스', speciesId: 26, level: 24 },
  { locationId: 'celadon', badge: 4, badgeName: '무지개배지', name: '민화', speciesId: 45, level: 29 },
  { locationId: 'fuchsia', badge: 5, badgeName: '핑크배지', name: '독수', speciesId: 110, level: 43 },
  { locationId: 'saffron', badge: 6, badgeName: '골드배지', name: '초련', speciesId: 65, level: 43 },
  { locationId: 'cinnabar', badge: 7, badgeName: '크림슨배지', name: '강연', speciesId: 59, level: 47 },
  { locationId: 'viridian', badge: 8, badgeName: '그린배지', name: '비주기', speciesId: 112, level: 50 },
];

export const KANTO_CONNECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['pallet', 'route-1'], ['route-1', 'viridian'], ['viridian', 'route-2-south'],
  ['route-2-south', 'viridian-forest'], ['viridian-forest', 'route-2-north'], ['route-2-north', 'pewter'],
  ['pewter', 'route-3'], ['route-3', 'mt-moon'], ['mt-moon', 'route-4'], ['route-4', 'cerulean'],
  ['cerulean', 'route-24'], ['route-24', 'route-25'], ['route-24', 'cerulean-cave'],
  ['cerulean', 'route-5'], ['route-5', 'saffron'], ['saffron', 'route-6'], ['route-6', 'vermilion'],
  ['vermilion', 'route-11'], ['route-11', 'route-12'], ['route-12', 'lavender'],
  ['route-11', 'diglett-cave-east'], ['diglett-cave-east', 'diglett-cave-west'], ['diglett-cave-west', 'route-2-south'],
  ['lavender', 'pokemon-tower'], ['lavender', 'route-10-south'], ['route-10-south', 'rock-tunnel'],
  ['rock-tunnel', 'route-10-north'], ['route-10-north', 'route-9'], ['route-9', 'cerulean'], ['route-10-north', 'power-plant'],
  ['power-plant', 'zapdos-roost'],
  ['lavender', 'route-8'], ['route-8', 'saffron'], ['saffron', 'route-7'], ['route-7', 'celadon'],
  ['celadon', 'route-16'], ['route-16', 'route-17'], ['route-17', 'route-18'], ['route-18', 'fuchsia'],
  ['fuchsia', 'safari-zone'], ['fuchsia', 'route-15'], ['route-15', 'route-14'], ['route-14', 'route-13'], ['route-13', 'route-12'],
  ['fuchsia', 'route-19'], ['route-19', 'route-20-east'], ['route-20-east', 'seafoam-islands'],
  ['seafoam-islands', 'articuno-roost'], ['seafoam-islands', 'route-20-west'], ['route-20-west', 'cinnabar'], ['cinnabar', 'pokemon-mansion'], ['cinnabar', 'cinnabar-lab'],
  ['cinnabar', 'route-21'], ['route-21', 'pallet'], ['viridian', 'route-22'], ['route-22', 'route-23'],
  ['route-23', 'victory-road'], ['victory-road', 'moltres-roost'], ['victory-road', 'indigo-plateau'], ['indigo-plateau', 'mew-sanctum'],
];

export const KANTO_SURFACE_CONNECTIONS = KANTO_CONNECTIONS.filter(([from, to]) =>
  !(from === 'diglett-cave-east' && to === 'diglett-cave-west'),
);

export const KANTO_GATES: readonly KantoGate[] = [
  { id: 'pallet-surf', from: 'pallet', to: 'route-21', requiredBadges: 5, reason: '핑크배지를 얻으면 태초마을 남쪽 수로를 건널 수 있습니다.' },
  { id: 'pewter-east', from: 'pewter', to: 'route-3', requiredBadges: 1, reason: '회색배지를 얻으면 회색시티 동쪽 산길이 열립니다.' },
  { id: 'cerulean-south', from: 'cerulean', to: 'route-5', requiredBadges: 2, reason: '블루배지를 얻으면 블루시티 남쪽 관문이 열립니다.' },
  { id: 'cerulean-east', from: 'cerulean', to: 'route-9', requiredBadges: 2, reason: '블루배지를 얻으면 블루시티 동쪽 9번 도로가 열립니다.' },
  { id: 'diglett-tunnel', from: 'diglett-cave-east', to: 'diglett-cave-west', requiredBadges: 2, reason: '블루배지를 얻으면 디그다의 굴 지하 통로를 이용할 수 있습니다.', visible: false },
  { id: 'vermilion-east', from: 'vermilion', to: 'route-11', requiredBadges: 3, reason: '오렌지배지를 얻으면 11번 도로 검문소를 지날 수 있습니다.' },
  { id: 'celadon-west', from: 'celadon', to: 'route-16', requiredBadges: 4, reason: '무지개배지를 얻으면 사이클링로드 관문이 열립니다.' },
  { id: 'fuchsia-surf', from: 'fuchsia', to: 'route-19', requiredBadges: 5, reason: '핑크배지를 얻으면 남쪽 수로를 건널 수 있습니다.' },
  { id: 'cinnabar-west', from: 'route-20-west', to: 'cinnabar', requiredBadges: 6, reason: '골드배지를 얻으면 홍련섬 해역 출입이 허가됩니다.' },
  { id: 'cinnabar-north', from: 'cinnabar', to: 'route-21', requiredBadges: 6, reason: '골드배지를 얻으면 21번 수로를 이용할 수 있습니다.' },
  { id: 'league-gate', from: 'viridian', to: 'route-22', requiredBadges: 8, reason: '8개 배지를 모두 모으면 석영고원 관문이 열립니다.' },
];

const byId = new Map(KANTO_LOCATIONS.map(item => [item.id, item]));
const surfaceSegments = KANTO_SURFACE_CONNECTIONS.map(([from, to]) => {
  const a = byId.get(from)!, b = byId.get(to)!, dx = b.x - a.x, dz = b.z - a.z;
  return { x: a.x, z: a.z, dx, dz, lengthSquared: dx * dx + dz * dz || 1 };
});
const gateSegments = KANTO_GATES.filter(gate => gate.visible !== false).map(gate => {
  const from = byId.get(gate.from)!, to = byId.get(gate.to)!, dx = to.x - from.x, dz = to.z - from.z;
  const length = Math.hypot(dx, dz) || 1;
  return { gate, x: (from.x + to.x) / 2, z: (from.z + to.z) / 2, alongX: dx / length, alongZ: dz / length };
});
const gateWidthCache = new Map<string, number>();
const towns = KANTO_LOCATIONS.filter(item => item.kind === 'town');

const TOWN_BUILDING_CANDIDATES = [[-5, -4], [5, -4], [-5, 4], [5, 4], [-6, 0], [6, 0], [0, -6], [0, 6]] as const;
const townBuildingOffsetCache = new Map<string, ReadonlyArray<readonly [number, number]>>();

export function townBuildingOffsets(town: KantoLocation): ReadonlyArray<readonly [number, number]> {
  const cached = townBuildingOffsetCache.get(town.id);
  if (cached) return cached;
  const offsets = TOWN_BUILDING_CANDIDATES
    .filter(([offsetX, offsetZ]) => distanceToKantoPath(town.x + offsetX, town.z + offsetZ) > 3.5)
    .slice(0, 3);
  townBuildingOffsetCache.set(town.id, offsets);
  return offsets;
}

function townBuildingAt(x: number, z: number, town: KantoLocation): boolean {
  return townBuildingOffsets(town).some(([offsetX, offsetZ]) =>
    Math.abs(x - town.x - offsetX) < 1.9 && Math.abs(z - town.z - offsetZ) < 1.7,
  );
}

export function distanceToKantoPath(x: number, z: number): number {
  let nearestSquared = Infinity;
  for (const segment of surfaceSegments) {
    const t = Math.max(0, Math.min(1, ((x - segment.x) * segment.dx + (z - segment.z) * segment.dz) / segment.lengthSquared));
    const offsetX = x - (segment.x + segment.dx * t), offsetZ = z - (segment.z + segment.dz * t);
    nearestSquared = Math.min(nearestSquared, offsetX * offsetX + offsetZ * offsetZ);
  }
  return Math.sqrt(nearestSquared);
}

export function locationAt(x: number, z: number): KantoLocation {
  let nearest = KANTO_LOCATIONS[0], distanceSquared = Infinity;
  for (const item of KANTO_LOCATIONS) {
    const dx = x - item.x, dz = z - item.z, nextSquared = dx * dx + dz * dz;
    if (nextSquared < distanceSquared) { nearest = item; distanceSquared = nextSquared; }
  }
  return nearest;
}

export function sampleKantoWorld(x: number, z: number): WorldSample {
  const finite = Number.isFinite(x) && Number.isFinite(z);
  const height = .22 * Math.sin(x * .09) + .18 * Math.cos(z * .08);
  if (!finite || Math.abs(x) > 120 || Math.abs(z) > 120) return { height, biome: 'rock', blocked: true };
  const nearest = locationAt(x, z);
  const distance = Math.hypot(x - nearest.x, z - nearest.z);
  const pathDistance = distanceToKantoPath(x, z);
  const town = towns.find(item => Math.hypot(x - item.x, z - item.z) < 8.5);
  if (town) return { height: 0, biome: 'meadow', blocked: townBuildingAt(x, z, town) };
  const southernSea = z > 82 && x > -78 && x < 12;
  const powerWater = Math.hypot(x - 61, z + 25) < 13;
  const locationRadius = nearest.kind === 'town' ? 8.5 : nearest.kind === 'forest' ? 7.5 : nearest.kind === 'sea' ? 6.5 : nearest.kind === 'route' ? 4.8 : 5.5;
  const playable = pathDistance < 3.2 || distance < locationRadius;
  if ((southernSea || powerWater) && !playable) return { height: -.72, biome: 'lake', blocked: true };
  if (nearest.kind === 'sea' && playable) return { height: -.68, biome: 'lake', blocked: false };
  if (playable) {
    const rocky = (nearest.kind === 'cave' || nearest.id === 'route-23') && distance > 3;
    return { height: rocky ? height + .7 : height, biome: rocky ? 'rock' : nearest.kind === 'forest' ? 'forest' : 'meadow', blocked: false };
  }
  const northernRock = z < -5 || x < -88;
  if (northernRock) {
    return { height: height + .65 + Math.max(0, -z - 5) * .018, biome: 'rock', blocked: true };
  }
  const forestBelt = x < -48 || (x > 20 && z < 22) || (z > 50 && x > 15);
  if (forestBelt) {
    return { height, biome: 'forest', blocked: true };
  }
  return { height: height + .2, biome: 'forest', blocked: true };
}

export function isKantoPlayable(x: number, z: number): boolean {
  return !sampleKantoWorld(x, z).blocked;
}

/** Half-width shared by logical gate crossing and the visible barrier. */
export function kantoGateHalfWidth(gate: KantoGate): number {
  const cached = gateWidthCache.get(gate.id);
  if (cached !== undefined) return cached;
  const from = byId.get(gate.from), to = byId.get(gate.to);
  if (!from || !to || gate.visible === false) return 0;
  const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz) || 1;
  const centerX = (from.x + to.x) / 2, centerZ = (from.z + to.z) / 2;
  const sideX = -dz / length, sideZ = dx / length;
  let furthest = 3.2;
  for (const side of [-1, 1]) {
    for (let distance = .1; distance <= 18; distance += .1) {
      if (!isKantoPlayable(centerX + sideX * distance * side, centerZ + sideZ * distance * side)) break;
      furthest = Math.max(furthest, distance);
    }
  }
  const width = furthest + .4;
  gateWidthCache.set(gate.id, width);
  return width;
}

export function evaluateKantoTraversal(from: { x: number; z: number }, to: { x: number; z: number }, badges: number): KantoTraversal {
  const location = locationAt(to.x, to.z);
  if (!Number.isFinite(badges) || badges < 0) return { allowed: false, location, reason: '배지 정보가 올바르지 않습니다.' };
  if (!isKantoPlayable(to.x, to.z)) return { allowed: false, location, reason: '길과 마을 경계를 벗어날 수 없습니다.' };
  for (const segment of gateSegments) {
    if (badges >= segment.gate.requiredBadges) continue;
    const before = (from.x - segment.x) * segment.alongX + (from.z - segment.z) * segment.alongZ;
    const after = (to.x - segment.x) * segment.alongX + (to.z - segment.z) * segment.alongZ;
    // A migrated save exactly on the barrier line may step away instead of
    // becoming trapped; movement onto or across the line is still rejected.
    if (Math.abs(before) < 1e-7) continue;
    if (before === after || before * after > 0) continue;
    const t = -before / (after - before);
    if (t < 0 || t > 1) continue;
    const crossingX = from.x + (to.x - from.x) * t - segment.x;
    const crossingZ = from.z + (to.z - from.z) * t - segment.z;
    const lateral = Math.abs(crossingX * -segment.alongZ + crossingZ * segment.alongX);
    if (lateral <= kantoGateHalfWidth(segment.gate)) return { allowed: false, location, gate: segment.gate, reason: segment.gate.reason };
  }
  return { allowed: true, location };
}

export function safeKantoArrival(locationId: string, badges = 0): { x: number; z: number } | undefined {
  const target = byId.get(locationId);
  if (!target || !Number.isFinite(badges) || badges < target.requiredBadges) return undefined;
  const candidates = [[target.x, target.z], [target.x, target.z + 2], [target.x + 2, target.z], [target.x - 2, target.z], [target.x, target.z - 2]] as const;
  const arrival = candidates.find(([x, z]) => isKantoPlayable(x, z));
  return arrival ? { x: arrival[0], z: arrival[1] } : undefined;
}

export function nearestKantoWalkable(x: number, z: number, badges = 0): { x: number; z: number } | undefined {
  if (![x, z, badges].every(Number.isFinite) || badges < 0) return undefined;
  const allowed = (candidateX: number, candidateZ: number) => {
    const location = locationAt(candidateX, candidateZ);
    const onLockedGate = gateSegments.some(segment => {
      if (badges >= segment.gate.requiredBadges) return false;
      const along = (candidateX - segment.x) * segment.alongX + (candidateZ - segment.z) * segment.alongZ;
      const lateral = Math.abs((candidateX - segment.x) * -segment.alongZ + (candidateZ - segment.z) * segment.alongX);
      return Math.abs(along) < .35 && lateral <= kantoGateHalfWidth(segment.gate);
    });
    return !onLockedGate && location.requiredBadges <= badges && isKantoPlayable(candidateX, candidateZ);
  };
  if (allowed(x, z)) return { x, z };
  for (let radius = .5; radius <= 18; radius += .5) {
    for (let index = 0; index < 32; index += 1) {
      const angle = index / 32 * Math.PI * 2;
      const candidateX = x + Math.cos(angle) * radius, candidateZ = z + Math.sin(angle) * radius;
      if (allowed(candidateX, candidateZ)) return { x: candidateX, z: candidateZ };
    }
  }
  const fallback = [...KANTO_LOCATIONS]
    .filter(location => location.requiredBadges <= badges && isKantoPlayable(location.x, location.z))
    .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
  return fallback ? { x: fallback.x, z: fallback.z } : undefined;
}

export function kantoTravelPoint(townId: string, badges = 0): { x: number; z: number } | undefined {
  const town = byId.get(townId);
  if (!town || town.kind !== 'town') return undefined;
  return safeKantoArrival(townId, badges);
}

export function encountersForLocation(locationId: string, badges: number): number[] {
  const found = byId.get(locationId);
  if (!found || !Number.isFinite(badges) || badges < found.requiredBadges) return [];
  return [...found.encounters];
}

/** Human-readable acquisition provenance for the Kanto Pokédex. */
export function kantoSpeciesSources(speciesId: number): string[] {
  if (!Number.isInteger(speciesId) || speciesId < 1 || speciesId > 151) return [];
  const sources = KANTO_LOCATIONS
    .filter(item => item.encounters.includes(speciesId))
    .map(item => item.name);
  if ([1, 4, 7].includes(speciesId)) sources.unshift('태초마을 스타터 선택');
  for (const species of POKEMON) {
    if (species.evolutions.some(evolution => evolution.target === speciesId)) sources.push(`${species.name}에서 진화`);
  }
  return [...new Set(sources)];
}
