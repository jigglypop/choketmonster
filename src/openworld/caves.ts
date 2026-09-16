import type { WorldSample } from './types';
import { KANTO_LOCATIONS, type KantoLocation } from './kanto';
import { JOHTO_LOCATIONS } from './johto';
import { scaleWorldDistance, surfaceSceneId, type ScenePoint } from './world-space';
import { caveRelief, caveFloorHeight, type CaveRelief } from './cave-relief';

export type CaveRegionId = 'kanto' | 'johto';
export type CaveSilhouette = 'rounded' | 'oval' | 'long' | 'hall' | 'bend';
export type CaveWallSegment = ScenePoint & { width: number; depth: number; height: number; rotationY: number };
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
  legacyWidth: number;
  legacyDepth: number;
  tileSize: number;
  silhouette: CaveSilhouette;
  outline: readonly ScenePoint[];
  portals: readonly CavePortal[];
  wallSegments: readonly CaveWallSegment[];
  relief: CaveRelief;
  sample: (x: number, z: number) => WorldSample;
};

type CavePlan = { regionId: CaveRegionId; id: string; name: string; label: string; seed: number; width: number; depth: number; silhouette: CaveSilhouette; surfaceLocations: readonly string[] };
const TILE_SIZE = 2;
const plans: readonly CavePlan[] = [
  { regionId: 'kanto', id: 'mt-moon', name: '달맞이산 동굴', label: 'Mt. Moon', seed: 11, width: 23, depth: 17, silhouette: 'rounded', surfaceLocations: ['route-3', 'route-4'] },
  { regionId: 'kanto', id: 'diglett-cave', name: '디그다의 굴', label: "Diglett's Cave", seed: 23, width: 29, depth: 11, silhouette: 'long', surfaceLocations: ['diglett-cave-east', 'diglett-cave-west'] },
  { regionId: 'kanto', id: 'rock-tunnel', name: '돌산터널', label: 'Rock Tunnel', seed: 37, width: 21, depth: 21, silhouette: 'bend', surfaceLocations: ['route-10-south', 'route-10-north'] },
  { regionId: 'kanto', id: 'seafoam-islands', name: '쌍둥이섬 동굴', label: 'Seafoam Islands', seed: 41, width: 25, depth: 19, silhouette: 'oval', surfaceLocations: ['route-20-east', 'route-20-west'] },
  { regionId: 'kanto', id: 'victory-road', name: '챔피언로드', label: 'Victory Road', seed: 53, width: 27, depth: 21, silhouette: 'hall', surfaceLocations: ['route-23', 'indigo-plateau'] },
  { regionId: 'kanto', id: 'cerulean-cave', name: '블루시티 동굴', label: 'Cerulean Cave', seed: 67, width: 21, depth: 19, silhouette: 'rounded', surfaceLocations: ['cerulean-cave'] },
  { regionId: 'kanto', id: 'power-plant', name: '무인발전소 내부', label: 'Power Plant', seed: 71, width: 25, depth: 15, silhouette: 'hall', surfaceLocations: ['power-plant'] },
  { regionId: 'johto', id: 'tohjo-falls', name: '동성폭포 동굴', label: 'Tohjo Falls', seed: 83, width: 23, depth: 17, silhouette: 'oval', surfaceLocations: ['route-27', 'mt-silver'] },
  { regionId: 'johto', id: 'union-cave', name: '연결동굴', label: 'Union Cave', seed: 97, width: 25, depth: 19, silhouette: 'bend', surfaceLocations: ['route-32', 'route-33'] },
  { regionId: 'johto', id: 'slowpoke-well', name: '야돈의 우물', label: 'Slowpoke Well', seed: 101, width: 17, depth: 17, silhouette: 'rounded', surfaceLocations: ['slowpoke-well'] },
  { regionId: 'johto', id: 'whirl-islands', name: '소용돌이섬 동굴', label: 'Whirl Islands', seed: 113, width: 27, depth: 23, silhouette: 'hall', surfaceLocations: ['route-40', 'route-41'] },
  { regionId: 'johto', id: 'mt-mortar', name: '절구산', label: 'Mt. Mortar', seed: 127, width: 29, depth: 17, silhouette: 'long', surfaceLocations: ['route-42-west', 'route-42-east'] },
  { regionId: 'johto', id: 'ice-path', name: '얼음샛길', label: 'Ice Path', seed: 139, width: 23, depth: 23, silhouette: 'oval', surfaceLocations: ['route-44', 'blackthorn'] },
  { regionId: 'johto', id: 'dragons-den', name: '용의 굴', label: "Dragon's Den", seed: 149, width: 19, depth: 21, silhouette: 'rounded', surfaceLocations: ['dragons-den'] },
  { regionId: 'johto', id: 'dark-cave', name: '어둠의 동굴', label: 'Dark Cave', seed: 163, width: 31, depth: 15, silhouette: 'bend', surfaceLocations: ['dark-cave-east', 'dark-cave-west'] },
  { regionId: 'johto', id: 'mt-silver', name: '은빛산 동굴', label: 'Mt. Silver', seed: 179, width: 27, depth: 25, silhouette: 'hall', surfaceLocations: ['mt-silver'] },
];

const pointForTile = (width: number, depth: number, x: number, z: number): ScenePoint => ({ x: (x - (width - 1) / 2) * TILE_SIZE, z: (z - (depth - 1) / 2) * TILE_SIZE });

function silhouetteBonus(kind: CaveSilhouette, angle: number, phase: number): number {
  if (kind === 'rounded') return 3.6 + .6 * Math.sin(angle * 3 + phase);
  if (kind === 'oval') return 4 + .9 * Math.cos(angle * 2 + phase);
  if (kind === 'long') return 3.2 + 1.2 * Math.abs(Math.cos(angle + phase * .15));
  if (kind === 'hall') return 4.5 + .9 * Math.cos(angle * 4 + phase);
  return 4.3 + 1.1 * Math.sin(angle + phase) + .2 * Math.sin(angle * 3 - phase);
}

function caveOutline(kind: CaveSilhouette, seed: number, width: number, depth: number): ScenePoint[] {
  const points: ScenePoint[] = [], phase = seed * .071, halfWidth = width / 2, halfDepth = depth / 2;
  for (let index = 0; index < 48; index++) {
    const angle = index / 48 * Math.PI * 2, cosine = Math.cos(angle), sine = Math.sin(angle);
    const rectangleRadius = Math.min(halfWidth / Math.max(Math.abs(cosine), 1e-6), halfDepth / Math.max(Math.abs(sine), 1e-6));
    const radius = rectangleRadius + silhouetteBonus(kind, angle, phase);
    points.push({ x: cosine * radius, z: sine * radius });
  }
  return points;
}

function distanceToSegment(x: number, z: number, a: ScenePoint, b: ScenePoint): number {
  const dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
}

export function caveContains(outline: readonly ScenePoint[], x: number, z: number, clearance = 0): boolean {
  let inside = false, edgeDistance = Infinity;
  for (let index = 0, previous = outline.length - 1; index < outline.length; previous = index++) {
    const a = outline[previous], b = outline[index];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
    edgeDistance = Math.min(edgeDistance, distanceToSegment(x, z, a, b));
  }
  return inside && edgeDistance >= clearance;
}

function buildScene(plan: CavePlan): CaveScene {
  const locations = plan.regionId === 'kanto' ? KANTO_LOCATIONS : JOHTO_LOCATIONS;
  const exactLocation = locations.find(item => item.id === plan.id);
  const encounter = exactLocation
    ?? locations.find(item => item.id === plan.surfaceLocations[0]);
  if (!encounter) throw new Error(`Unknown cave encounter location: ${plan.regionId}:${plan.id}`);
  // The outer tile ring is the chamber boundary. Every tile inside it is open,
  // including coordinates that older saves may have recorded inside maze walls.
  const floor = Array.from({ length: plan.depth }, (_, z) =>
    Array.from({ length: plan.width }, (_, x) => x > 0 && z > 0 && x < plan.width - 1 && z < plan.depth - 1));
  const portalTiles = plan.surfaceLocations.map((_, index) => index === 0 ? { x: 1, z: 1 } : { x: plan.width - 2, z: plan.depth - 2 });
  const legacyWidth = plan.width * TILE_SIZE, legacyDepth = plan.depth * TILE_SIZE;
  const outline = caveOutline(plan.silhouette, plan.seed, legacyWidth, legacyDepth);
  const width = Math.ceil(Math.max(...outline.map(point => Math.abs(point.x))) * 2);
  const depth = Math.ceil(Math.max(...outline.map(point => Math.abs(point.z))) * 2);
  const relief = caveRelief(plan.id, plan.seed, legacyWidth, legacyDepth);
  const wallSegments: CaveWallSegment[] = outline.map((point, index) => {
    const next = outline[(index + 1) % outline.length], dx = next.x - point.x, dz = next.z - point.z;
    return { x: (point.x + next.x) / 2, z: (point.z + next.z) / 2, width: Math.hypot(dx, dz), depth: TILE_SIZE,
      height: 3.4, rotationY: Math.atan2(-dz, dx) };
  });
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
    const blocked = !caveContains(outline, x, z, 2.8);
    return { height: caveFloorHeight(relief, x, z), exactHeight: true, biome: 'rock', blocked };
  };
  return { id: plan.id, sceneId: `cave:${plan.regionId}:${plan.id}`, regionId: plan.regionId, name: plan.name, label: plan.label,
    encounterLocationId: encounter.id, minLevel: encounter.minLevel, maxLevel: encounter.maxLevel, encounters: encounter.encounters,
    width, depth, legacyWidth, legacyDepth, tileSize: TILE_SIZE, silhouette: plan.silhouette, outline, portals, wallSegments, relief, sample };
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
