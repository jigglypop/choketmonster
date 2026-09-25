import type { WorldSample } from './types';
import { terrainSurfaceHeight } from './grounding';
import { getWorldAtlas, type WorldAtlas } from './atlas';
import { WORLD_MAX, WORLD_MIN, scaleWorldDistance } from './world-space';

export type SceneryAssetId =
  | 'tree-round' | 'tree-oak' | 'tree-pine' | 'tree-fat' | 'tree-thin'
  | 'rock-large' | 'rock-moss' | 'rock-small' | 'rock-flat'
  | 'rock-tall' | 'rock-ridge' | 'cliff'
  | 'moss-boulder' | 'moss-stone' | 'fern'
  | 'grass-tuft' | 'grass-soft'
  | 'flower-red' | 'flower-yellow' | 'flower-purple' | 'bush'
  | 'mushroom-cluster' | 'lily' | 'stump' | 'fence' | 'fallen-log';

export type SceneryPlacement = {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  scale: number;
};

const ASSET_VERSION = '20260911-woodland';
const cozyModels: Partial<Record<SceneryAssetId, { model: string; scale: number }>> = {
  'tree-round': { model: 'tree-round', scale: 1 }, 'tree-oak': { model: 'tree-oak', scale: 1 },
  'tree-fat': { model: 'tree-fat', scale: 1 }, 'tree-thin': { model: 'tree-thin', scale: 1 },
  'tree-pine': { model: 'tree-pine', scale: 1 },
  'rock-large': { model: 'rock-round', scale: 1 }, 'rock-moss': { model: 'rock-wide', scale: .85 },
  'rock-small': { model: 'rock-round', scale: .3 }, 'rock-flat': { model: 'rock-wide', scale: .48 },
  'rock-tall': { model: 'rock-tall', scale: 1 }, 'rock-ridge': { model: 'rock-wide', scale: 1.5 },
  cliff: { model: 'rock-tall', scale: 1.2 },
  'moss-boulder': { model: 'rock-round', scale: .65 }, 'moss-stone': { model: 'rock-wide', scale: .36 },
  fern: { model: 'fern', scale: 1 },
};
const cozyUrl = (model: string) => `/models/openworld/cute-nature/${model}.glb?v=20260912-lowpoly`;
const assetUrl = (id: SceneryAssetId) => cozyModels[id] ? cozyUrl(cozyModels[id]!.model) : ['moss-boulder', 'moss-stone', 'fern'].includes(id)
  ? `/models/openworld/nature-detail/${id}.glb?v=20260911` : ['rock-tall', 'rock-ridge', 'cliff'].includes(id)
  ? `/models/openworld/rocks/${id}.glb?v=20260911` : `/models/openworld/props/${id}.glb?v=${ASSET_VERSION}`;

export const SCENERY_ASSETS: ReadonlyArray<{ id: SceneryAssetId; url: string; authoredMaterials: boolean; scale: number }> = [
  'tree-round', 'tree-oak', 'tree-pine', 'tree-fat', 'tree-thin',
  'rock-large', 'rock-moss', 'rock-small', 'rock-flat',
  'rock-tall', 'rock-ridge', 'cliff',
  'moss-boulder', 'moss-stone', 'fern',
  'grass-tuft', 'grass-soft', 'flower-red', 'flower-yellow', 'flower-purple',
  'bush', 'mushroom-cluster', 'lily', 'stump', 'fence', 'fallen-log',
].map(name => {
  const id = name as SceneryAssetId, replacement = cozyModels[id];
  return { id, url: assetUrl(id), scale: replacement?.scale ?? 1, authoredMaterials: !!replacement };
});

const emptyPlacements = (): Record<SceneryAssetId, SceneryPlacement[]> => ({
  'tree-round': [], 'tree-oak': [], 'tree-pine': [], 'tree-fat': [], 'tree-thin': [],
  'rock-large': [], 'rock-moss': [], 'rock-small': [], 'rock-flat': [],
  'rock-tall': [], 'rock-ridge': [], cliff: [],
  'moss-boulder': [], 'moss-stone': [], fern: [],
  'grass-tuft': [], 'grass-soft': [],
  'flower-red': [], 'flower-yellow': [], 'flower-purple': [], bush: [],
  'mushroom-cluster': [], lily: [], stump: [], fence: [], 'fallen-log': [],
});

/** Stable visual noise. This deliberately does not touch simulation random state. */
function noise(x: number, z: number, salt: number): number {
  const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

function place(
  target: Record<SceneryAssetId, SceneryPlacement[]>,
  id: SceneryAssetId,
  x: number,
  z: number,
  sample: WorldSample,
  minScale: number,
  maxScale: number,
  salt: number,
): void {
  target[id].push({
    x,
    y: sample.height,
    z,
    rotationY: noise(x, z, salt + 1) * Math.PI * 2,
    scale: minScale + noise(x, z, salt + 2) * (maxScale - minScale),
  });
}

function surfaceSample(sampleWorld: (x: number, z: number) => WorldSample, x: number, z: number): WorldSample {
  return { ...sampleWorld(x, z), height: terrainSurfaceHeight(sampleWorld, x, z) };
}

export function createSceneryPlacements(sampleWorld: (x: number, z: number) => WorldSample, atlas: WorldAtlas = getWorldAtlas('kanto')): Record<SceneryAssetId, SceneryPlacement[]> {
  const result = emptyPlacements();
  // Towns, cave mouths and special sites keep their squares clear; routes and forests are dressed right up to the trail.
  const clearings = atlas.locations.filter(item => item.kind === 'town' || item.kind === 'cave' || item.kind === 'special');
  const clearingDistance = (x: number, z: number) => clearings.reduce((nearest, item) => Math.min(nearest, Math.hypot(x - item.x, z - item.z)), Infinity);
  /** A few flowers of one colour, the way wildflowers grow. */
  const flowerCluster = (id: SceneryAssetId, x: number, z: number, salt: number) => {
    const count = 2 + Math.floor(noise(x, z, salt) * 3);
    for (let index = 0; index < count; index++) {
      const angle = noise(x, z, salt + index * 3 + 1) * Math.PI * 2, radius = .35 + noise(x, z, salt + index * 3 + 2) * .9;
      const fx = x + Math.cos(angle) * radius, fz = z + Math.sin(angle) * radius, sample = surfaceSample(sampleWorld, fx, fz);
      if (!sample.blocked && sample.biome !== 'lake') place(result, id, fx, fz, sample, .7, 1.15, salt + index * 5);
    }
  };

  // Large silhouettes sit on the exact simulation obstacle samples so the
  // visible forest and highland barriers explain why a route is blocked.
  for (let x = WORLD_MIN + scaleWorldDistance(6); x <= WORLD_MAX - scaleWorldDistance(6); x += scaleWorldDistance(5.5)) {
    for (let z = WORLD_MIN + scaleWorldDistance(6); z <= WORLD_MAX - scaleWorldDistance(6); z += scaleWorldDistance(5.5)) {
      const px = x + (noise(x, z, 1) - .5) * scaleWorldDistance(2.4);
      const pz = z + (noise(x, z, 2) - .5) * scaleWorldDistance(2.4);
      const sample = surfaceSample(sampleWorld, px, pz);
      if (atlas.distanceToPath(px, pz) < scaleWorldDistance(4.2) || clearingDistance(px, pz) < scaleWorldDistance(9)) continue;
      if (sample.biome === 'meadow' && sample.blocked) {
        // Open ground off the route: scattered tree stands and bushes frame the walkable corridor.
        const stand = noise(px, pz, 40);
        if (stand < .34) place(result, stand < .12 ? 'tree-round' : stand < .22 ? 'tree-oak' : 'tree-fat', px, pz, sample, .78, 1.1, 41);
        else if (stand < .5) place(result, 'bush', px, pz, sample, .9, 1.35, 42);
        else if (stand < .56) place(result, 'rock-moss', px, pz, sample, .7, 1.05, 43);
      } else if (sample.biome === 'forest' && sample.blocked) {
        const selector = noise(px, pz, 3);
        place(result, selector < .24 ? 'tree-round' : selector < .5 ? 'tree-oak' : selector < .7 ? 'tree-fat' : selector < .88 ? 'tree-thin' : 'tree-pine', px, pz, sample, .82, 1.16, 4);
        if (noise(px, pz, 5) > .5) place(result, 'fern', px + .75, pz - .55, surfaceSample(sampleWorld, px + .75, pz - .55), .85, 1.35, 6);
      } else if (sample.biome === 'rock' && sample.blocked) {
        const rock = noise(px, pz, 7);
        place(result, rock < .25 ? 'rock-tall' : rock < .45 ? 'rock-ridge' : rock < .62 ? 'cliff' : 'moss-boulder', px, pz, sample, .72, 1.18, 8);
        place(result, 'rock-flat', px + .9, pz + .65, surfaceSample(sampleWorld, px + .9, pz + .65), .72, 1.1, 9);
      }
    }
  }

  // Small passable dressing uses a wider grid and conservative caps. It is
  // dense enough to read as ground cover while remaining a few draw calls.
  for (let x = WORLD_MIN + scaleWorldDistance(8); x <= WORLD_MAX - scaleWorldDistance(8); x += scaleWorldDistance(3.15)) {
    for (let z = WORLD_MIN + scaleWorldDistance(8); z <= WORLD_MAX - scaleWorldDistance(8); z += scaleWorldDistance(3.15)) {
      const px = x + (noise(x, z, 10) - .5) * scaleWorldDistance(2.2);
      const pz = z + (noise(x, z, 11) - .5) * scaleWorldDistance(2.2);
      const sample = surfaceSample(sampleWorld, px, pz);
      if (sample.blocked || sample.biome === 'lake') continue;
      // The trail itself stays clear; its verges get flowers and stones.
      if (atlas.distanceToPath(px, pz) < scaleWorldDistance(1.6) || clearingDistance(px, pz) < scaleWorldDistance(9)) continue;
      const selector = noise(px, pz, 12);
      if (sample.biome === 'meadow') {
        if (selector < .4) {
          place(result, selector < .2 ? 'grass-tuft' : 'grass-soft', px, pz, sample, .6, 1.12, 13);
          if (noise(px, pz, 14) < .38) {
            const gx = px + (noise(px, pz, 15) - .5) * 1.15, gz = pz + (noise(px, pz, 16) - .5) * 1.15;
            place(result, 'grass-soft', gx, gz, surfaceSample(sampleWorld, gx, gz), .5, .88, 17);
          }
        } else if (selector < .56) flowerCluster('flower-yellow', px, pz, 18);
        else if (selector < .68) flowerCluster('flower-red', px, pz, 19);
        else if (selector < .78) flowerCluster('flower-purple', px, pz, 20);
        else if (selector < .83) place(result, 'moss-stone', px, pz, sample, .5, .85, 21);
        else if (selector < .87) place(result, 'rock-small', px, pz, sample, .55, .95, 31);
        else if (selector < .92) place(result, 'fern', px, pz, sample, .7, 1.12, 29);
        else if (selector < .95) place(result, 'bush', px, pz, sample, .55, .8, 32);
        else if (selector < .965) place(result, 'stump', px, pz, sample, .75, 1, 33);
      } else if (sample.biome === 'forest') {
        if (selector < .12) place(result, 'moss-stone', px, pz, sample, .65, .95, 30);
        else if (selector < .32) place(result, 'fern', px, pz, sample, .72, 1.15, 22);
        else if (selector < .64) place(result, selector < .48 ? 'grass-tuft' : 'grass-soft', px, pz, sample, .65, 1.12, 23);
        else if (selector < .75) place(result, 'mushroom-cluster', px, pz, sample, .72, 1.15, 24);
        else if (selector > .94) place(result, selector > .975 ? 'fallen-log' : 'stump', px, pz, sample, .85, 1.15, 25);
      } else if (sample.biome === 'rock') {
        if (selector < .36) place(result, 'rock-small', px, pz, sample, .68, 1.25, 26);
        else if (selector < .64) place(result, 'rock-flat', px, pz, sample, .68, 1.28, 27);
        else if (selector < .72) place(result, 'grass-soft', px, pz, sample, .55, .9, 28);
      }
    }
  }

  const locations = new Map(atlas.locations.map(item => [item.id, item]));
  // Route verges, where the player walks most: wildflowers, tufts and stones beside every land route, ferns and
  // mushrooms along woodland trails. The trail itself stays clear.
  for (const [fromId, toId] of atlas.surfaceConnections) {
    const from = locations.get(fromId)!, to = locations.get(toId)!;
    if (from.kind === 'sea' || to.kind === 'sea') continue;
    const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
    if (length < scaleWorldDistance(6)) continue;
    const nx = -dz / length, nz = dx / length;
    for (let along = scaleWorldDistance(3); along <= length - scaleWorldDistance(3); along += scaleWorldDistance(1.2)) {
      const t = along / length, cx = from.x + dx * t, cz = from.z + dz * t;
      // Two lanes per side: one hugging the trail, one toward the verge's outer edge.
      for (const [side, lane] of [[-1, 0], [-1, 1], [1, 0], [1, 1]]) {
        const offset = scaleWorldDistance(1.7 + lane * 1.1 + noise(cx, cz, 50 + side + lane * 7) * 1.1);
        const px = cx + nx * offset * side, pz = cz + nz * offset * side, sample = surfaceSample(sampleWorld, px, pz);
        // Only the paved town disc stays clear on the verges.
        if (sample.blocked || sample.biome === 'lake' || clearingDistance(px, pz) < scaleWorldDistance(8.75) || atlas.distanceToPath(px, pz) < scaleWorldDistance(1.6)) continue;
        const pick = noise(px, pz, 52 + lane);
        if (sample.biome === 'meadow') {
          if (pick < .3) flowerCluster(pick < .13 ? 'flower-yellow' : pick < .23 ? 'flower-red' : 'flower-purple', px, pz, 53);
          else if (pick < .52) place(result, pick < .41 ? 'grass-tuft' : 'grass-soft', px, pz, sample, .6, 1.05, 54);
          else if (pick < .58) place(result, 'rock-small', px, pz, sample, .5, .9, 55);
          else if (pick < .62) place(result, 'moss-stone', px, pz, sample, .45, .8, 56);
          else if (pick < .64) place(result, 'bush', px, pz, sample, .5, .72, 60);
        } else if (sample.biome === 'forest') {
          if (pick < .25) place(result, 'fern', px, pz, sample, .7, 1.1, 57);
          else if (pick < .35) place(result, 'mushroom-cluster', px, pz, sample, .7, 1.05, 58);
          else if (pick < .45) place(result, 'grass-tuft', px, pz, sample, .6, 1, 59);
        }
      }
    }
  }

  // Route-edge fences sit just outside the logical corridor. End sections stay
  // open so town squares and junctions remain readable gateways.
  for (const [fromId, toId] of atlas.surfaceConnections) {
    const from = locations.get(fromId)!, to = locations.get(toId)!;
    if (from.kind === 'sea' || to.kind === 'sea') continue;
    const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
    if (length < scaleWorldDistance(13)) continue;
    const sideX = -dz / length * scaleWorldDistance(4.15), sideZ = dx / length * scaleWorldDistance(4.15);
    const rotationY = -Math.atan2(dz, dx);
    for (let along = scaleWorldDistance(6); along <= length - scaleWorldDistance(6); along += scaleWorldDistance(4.2)) {
      const t = along / length, centerX = from.x + dx * t, centerZ = from.z + dz * t;
      for (const side of [-1, 1]) {
        const x = centerX + sideX * side, z = centerZ + sideZ * side, sample = surfaceSample(sampleWorld, x, z);
        if (!sample.blocked) continue;
        result.fence.push({ x, y: sample.height, z, rotationY, scale: 1 });
      }
    }
  }
  return result;
}

const placementCache = new WeakMap<(x: number, z: number) => WorldSample, Map<string, Record<SceneryAssetId, SceneryPlacement[]>>>();
/** The world grid scan is deterministic, so re-entering a region reuses it instead of rescanning. */
export function cachedSceneryPlacements(sampleWorld: (x: number, z: number) => WorldSample, atlas: WorldAtlas): Record<SceneryAssetId, SceneryPlacement[]> {
  let byAtlas = placementCache.get(sampleWorld);
  if (!byAtlas) placementCache.set(sampleWorld, byAtlas = new Map());
  let placements = byAtlas.get(atlas.mapVersion);
  if (!placements) byAtlas.set(atlas.mapVersion, placements = createSceneryPlacements(sampleWorld, atlas));
  return placements;
}
