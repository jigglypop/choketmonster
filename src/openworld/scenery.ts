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

  // Large silhouettes sit on the exact simulation obstacle samples so the
  // visible forest and highland barriers explain why a route is blocked.
  for (let x = WORLD_MIN + scaleWorldDistance(6); x <= WORLD_MAX - scaleWorldDistance(6); x += scaleWorldDistance(5.5)) {
    for (let z = WORLD_MIN + scaleWorldDistance(6); z <= WORLD_MAX - scaleWorldDistance(6); z += scaleWorldDistance(5.5)) {
      const px = x + (noise(x, z, 1) - .5) * scaleWorldDistance(2.4);
      const pz = z + (noise(x, z, 2) - .5) * scaleWorldDistance(2.4);
      const sample = surfaceSample(sampleWorld, px, pz);
      const landmarkDistance = Math.min(...atlas.locations.map(item => Math.hypot(px - item.x, pz - item.z)));
      if (atlas.distanceToPath(px, pz) < scaleWorldDistance(4.7) || landmarkDistance < scaleWorldDistance(9)) continue;
      if (sample.biome === 'forest' && sample.blocked) {
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
      const landmarkDistance = Math.min(...atlas.locations.map(item => Math.hypot(px - item.x, pz - item.z)));
      if (atlas.distanceToPath(px, pz) < scaleWorldDistance(4.7) || landmarkDistance < scaleWorldDistance(9)) continue;
      const selector = noise(px, pz, 12);
      if (sample.biome === 'meadow') {
        if (selector < .62) {
          place(result, selector < .31 ? 'grass-tuft' : 'grass-soft', px, pz, sample, .6, 1.12, 13);
          if (noise(px, pz, 14) < .38) {
            const gx = px + (noise(px, pz, 15) - .5) * 1.15, gz = pz + (noise(px, pz, 16) - .5) * 1.15;
            place(result, 'grass-soft', gx, gz, surfaceSample(sampleWorld, gx, gz), .5, .88, 17);
          }
        } else if (selector < .73) place(result, 'flower-yellow', px, pz, sample, .78, 1.18, 18);
        else if (selector < .82) place(result, 'flower-red', px, pz, sample, .82, 1.22, 19);
        else if (selector < .89) place(result, 'flower-purple', px, pz, sample, .78, 1.18, 20);
        else if (selector < .92) place(result, 'moss-stone', px, pz, sample, .5, .85, 21);
        else if (selector < .97) place(result, 'fern', px, pz, sample, .7, 1.12, 29);
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

  // Route-edge fences sit just outside the logical corridor. End sections stay
  // open so town squares and junctions remain readable gateways.
  const locations = new Map(atlas.locations.map(item => [item.id, item]));
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
