import type { WorldSample } from './types';
import { KANTO_LOCATIONS, type KantoLocation } from './kanto';
import { JOHTO_LOCATIONS } from './johto';
import { scaleWorldDistance, surfaceSceneId, type ScenePoint } from './world-space';

export type CaveRegionId = 'kanto' | 'johto';
export type CaveWallSegment = ScenePoint & { width: number; depth: number; height: number };
export type CavePortal = {
  id: string;
  surfaceLocationId: string;
  surfaceSceneId: string;
  surface: ScenePoint;
  surfaceArrival: ScenePoint;
  interior: ScenePoint;
  interiorArrival: ScenePoint;
};
export type CaveScene = {
  id: string;
  sceneId: string;
  regionId: CaveRegionId;
  name: string;
  /** Stable ASCII text for portal labels even when localized fonts are unavailable. */
  label: string;
  encounterLocationId: string;
  minLevel: number;
  maxLevel: number;
  encounters: readonly number[];
  width: number;
  depth: number;
  tileSize: number;
  portals: readonly CavePortal[];
  wallSegments: readonly CaveWallSegment[];
  sample: (x: number, z: number) => WorldSample;
};

type CavePlan = { regionId: CaveRegionId; id: string; name: string; label: string; seed: number; width: number; depth: number; surfaceLocations: readonly string[] };
const TILE_SIZE = 2;
const plans: readonly CavePlan[] = [
  { regionId: 'kanto', id: 'mt-moon', name: '달맞이산 동굴', label: 'Mt. Moon', seed: 11, width: 23, depth: 17, surfaceLocations: ['route-3', 'route-4'] },
  { regionId: 'kanto', id: 'diglett-cave', name: '디그다의 굴', label: "Diglett's Cave", seed: 23, width: 29, depth: 11, surfaceLocations: ['diglett-cave-east', 'diglett-cave-west'] },
  { regionId: 'kanto', id: 'rock-tunnel', name: '돌산터널', label: 'Rock Tunnel', seed: 37, width: 21, depth: 21, surfaceLocations: ['route-10-south', 'route-10-north'] },
  { regionId: 'kanto', id: 'seafoam-islands', name: '쌍둥이섬 동굴', label: 'Seafoam Islands', seed: 41, width: 25, depth: 19, surfaceLocations: ['route-20-east', 'route-20-west'] },
  { regionId: 'kanto', id: 'victory-road', name: '챔피언로드', label: 'Victory Road', seed: 53, width: 27, depth: 21, surfaceLocations: ['route-23', 'indigo-plateau'] },
  { regionId: 'kanto', id: 'cerulean-cave', name: '블루시티 동굴', label: 'Cerulean Cave', seed: 67, width: 21, depth: 19, surfaceLocations: ['cerulean-cave'] },
  { regionId: 'kanto', id: 'power-plant', name: '무인발전소 내부', label: 'Power Plant', seed: 71, width: 25, depth: 15, surfaceLocations: ['power-plant'] },
  { regionId: 'johto', id: 'tohjo-falls', name: '동성폭포 동굴', label: 'Tohjo Falls', seed: 83, width: 23, depth: 17, surfaceLocations: ['route-27', 'mt-silver'] },
  { regionId: 'johto', id: 'union-cave', name: '연결동굴', label: 'Union Cave', seed: 97, width: 25, depth: 19, surfaceLocations: ['route-32', 'route-33'] },
  { regionId: 'johto', id: 'slowpoke-well', name: '야돈의 우물', label: 'Slowpoke Well', seed: 101, width: 17, depth: 17, surfaceLocations: ['slowpoke-well'] },
  { regionId: 'johto', id: 'whirl-islands', name: '소용돌이섬 동굴', label: 'Whirl Islands', seed: 113, width: 27, depth: 23, surfaceLocations: ['route-40', 'route-41'] },
  { regionId: 'johto', id: 'mt-mortar', name: '절구산', label: 'Mt. Mortar', seed: 127, width: 29, depth: 17, surfaceLocations: ['route-42-west', 'route-42-east'] },
  { regionId: 'johto', id: 'ice-path', name: '얼음샛길', label: 'Ice Path', seed: 139, width: 23, depth: 23, surfaceLocations: ['route-44', 'blackthorn'] },
  { regionId: 'johto', id: 'dragons-den', name: '용의 굴', label: "Dragon's Den", seed: 149, width: 19, depth: 21, surfaceLocations: ['dragons-den'] },
  { regionId: 'johto', id: 'dark-cave', name: '어둠의 동굴', label: 'Dark Cave', seed: 163, width: 31, depth: 15, surfaceLocations: ['dark-cave-east', 'dark-cave-west'] },
  { regionId: 'johto', id: 'mt-silver', name: '은빛산 동굴', label: 'Mt. Silver', seed: 179, width: 27, depth: 25, surfaceLocations: ['mt-silver'] },
];

const hash = (seed: number, x: number, z: number) => {
  let value = (seed ^ Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(z + 1, 0x85ebca6b)) >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d); value ^= value >>> 15; return value >>> 0;
};

function carveMaze(width: number, depth: number, seed: number): boolean[][] {
  const floor = Array.from({ length: depth }, () => Array<boolean>(width).fill(false));
  const stack: Array<readonly [number, number]> = [[1, 1]]; floor[1][1] = true;
  while (stack.length) {
    const [x, z] = stack[stack.length - 1];
    const choices = [[2, 0], [-2, 0], [0, 2], [0, -2]]
      .map(([dx, dz]) => ({ x: x + dx, z: z + dz, dx, dz }))
      .filter(next => next.x > 0 && next.z > 0 && next.x < width - 1 && next.z < depth - 1 && !floor[next.z][next.x])
      .sort((a, b) => hash(seed, a.x, a.z) - hash(seed, b.x, b.z));
    const next = choices[0];
    if (!next) { stack.pop(); continue; }
    floor[z + next.dz / 2][x + next.dx / 2] = true; floor[next.z][next.x] = true; stack.push([next.x, next.z]);
  }
  // Every layout gets a seed-specific chamber while retaining the perfect-maze route.
  const chamberX = 3 + (hash(seed, width, depth) % Math.max(1, width - 7));
  const chamberZ = 3 + (hash(seed + 1, depth, width) % Math.max(1, depth - 7));
  for (let z = chamberZ - 1; z <= chamberZ + 1; z++) for (let x = chamberX - 1; x <= chamberX + 1; x++) floor[z][x] = true;
  return floor;
}

const pointForTile = (width: number, depth: number, x: number, z: number): ScenePoint => ({ x: (x - (width - 1) / 2) * TILE_SIZE, z: (z - (depth - 1) / 2) * TILE_SIZE });

function buildScene(plan: CavePlan): CaveScene {
  const locations = plan.regionId === 'kanto' ? KANTO_LOCATIONS : JOHTO_LOCATIONS;
  const exactLocation = locations.find(item => item.id === plan.id);
  const encounter = exactLocation
    ?? locations.find(item => item.id === plan.surfaceLocations[0]);
  if (!encounter) throw new Error(`Unknown cave encounter location: ${plan.regionId}:${plan.id}`);
  const floor = carveMaze(plan.width, plan.depth, plan.seed);
  const portalTiles = plan.surfaceLocations.map((_, index) => index === 0 ? { x: 1, z: 1 } : { x: plan.width - 2, z: plan.depth - 2 });
  for (const tile of portalTiles) floor[tile.z][tile.x] = true;
  const wallSegments: CaveWallSegment[] = [];
  for (let z = 0; z < plan.depth; z++) for (let x = 0; x < plan.width;) {
    if (floor[z][x]) { x++; continue; }
    const start = x;
    while (x < plan.width && !floor[z][x]) x++;
    const center = pointForTile(plan.width, plan.depth, (start + x - 1) / 2, z);
    wallSegments.push({ ...center, width: (x - start) * TILE_SIZE, depth: TILE_SIZE, height: 3.4 });
  }
  const portals = plan.surfaceLocations.map((locationId, index): CavePortal => {
    const surfaceLocation = locations.find(item => item.id === locationId);
    if (!surfaceLocation) throw new Error(`Unknown cave portal location: ${plan.regionId}:${locationId}`);
    const tile = portalTiles[index];
    const inward = (index === 0
      ? [{ x: 1, z: 0 }, { x: 0, z: 1 }]
      : [{ x: -1, z: 0 }, { x: 0, z: -1 }])
      .find(direction => floor[tile.z + direction.z]?.[tile.x + direction.x]) ?? { x: 0, z: index === 0 ? 1 : -1 };
    const interior = pointForTile(plan.width, plan.depth, tile.x, tile.z);
    const direction = index === 0 ? -1 : 1;
    const surface = exactLocation && plan.surfaceLocations.length > 1
      ? { x: exactLocation.x + direction * scaleWorldDistance(2.2), z: exactLocation.z }
      : { x: surfaceLocation.x, z: surfaceLocation.z };
    return {
      id: `${plan.id}:${index}`, surfaceLocationId: locationId, surfaceSceneId: surfaceSceneId(plan.regionId), surface,
      surfaceArrival: { x: surface.x + direction * scaleWorldDistance(3), z: surface.z }, interior,
      interiorArrival: { x: interior.x + inward.x * TILE_SIZE * 1.4, z: interior.z + inward.z * TILE_SIZE * 1.4 },
    };
  });
  const sample = (x: number, z: number): WorldSample => {
    if (![x, z].every(Number.isFinite)) return { height: 0, biome: 'rock', blocked: true };
    const tileX = Math.round(x / TILE_SIZE + (plan.width - 1) / 2), tileZ = Math.round(z / TILE_SIZE + (plan.depth - 1) / 2);
    const blocked = tileX < 0 || tileZ < 0 || tileX >= plan.width || tileZ >= plan.depth || !floor[tileZ][tileX];
    return { height: 0, biome: 'rock', blocked };
  };
  return { id: plan.id, sceneId: `cave:${plan.regionId}:${plan.id}`, regionId: plan.regionId, name: plan.name, label: plan.label,
    encounterLocationId: encounter.id, minLevel: encounter.minLevel, maxLevel: encounter.maxLevel, encounters: encounter.encounters,
    width: plan.width * TILE_SIZE, depth: plan.depth * TILE_SIZE, tileSize: TILE_SIZE, portals, wallSegments, sample };
}

export const CAVE_SCENES: readonly CaveScene[] = plans.map(buildScene);
const byScene = new Map(CAVE_SCENES.map(scene => [scene.sceneId, scene]));

export const getCaveScene = (sceneId: string): CaveScene | undefined => byScene.get(sceneId);
export const caveSceneForRegionLocation = (regionId: string, locationId: string): CaveScene | undefined =>
  CAVE_SCENES.find(scene => scene.regionId === regionId && (scene.id === locationId || scene.portals.some(portal => portal.surfaceLocationId === locationId)));
export const cavePortalAtSurface = (regionId: string, x: number, z: number, radius = scaleWorldDistance(1.8)): { scene: CaveScene; portal: CavePortal } | undefined => {
  for (const scene of CAVE_SCENES) if (scene.regionId === regionId) for (const portal of scene.portals) if (Math.hypot(x - portal.surface.x, z - portal.surface.z) <= radius) return { scene, portal };
  return undefined;
};
export const cavePortalAtInterior = (sceneId: string, x: number, z: number, radius = 1.35): CavePortal | undefined =>
  getCaveScene(sceneId)?.portals.find(portal => Math.hypot(x - portal.interior.x, z - portal.interior.z) <= radius);
export function nearestCaveWalkable(sceneId: string, x: number, z: number): ScenePoint | undefined {
  const scene = getCaveScene(sceneId); if (!scene || ![x, z].every(Number.isFinite)) return undefined;
  if (!scene.sample(x, z).blocked) return { x, z };
  for (let radius = .5; radius <= Math.max(scene.width, scene.depth); radius += .5) for (let step = 0; step < 32; step++) {
    const angle = step / 32 * Math.PI * 2, point = { x: x + Math.cos(angle) * radius, z: z + Math.sin(angle) * radius };
    if (!scene.sample(point.x, point.z).blocked) return point;
  }
  return scene.portals[0]?.interiorArrival;
}

export const caveLocation = (sceneId: string): KantoLocation | undefined => {
  const scene = getCaveScene(sceneId); if (!scene) return undefined;
  return { id: scene.encounterLocationId, name: scene.name, x: 0, z: 0, kind: 'cave', minLevel: scene.minLevel, maxLevel: scene.maxLevel, encounters: scene.encounters, requiredBadges: 0 };
};
