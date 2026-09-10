import type { WorldSample } from './types';
import { terrainSurfaceHeight } from './grounding';

export type SceneryAssetId =
  | 'tree-round' | 'tree-oak' | 'tree-pine' | 'tree-fat' | 'tree-thin'
  | 'rock-large' | 'rock-moss' | 'rock-small' | 'rock-flat'
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
const assetUrl = (id: SceneryAssetId) => `/models/openworld/props/${id}.glb?v=${ASSET_VERSION}`;

export const SCENERY_ASSETS: ReadonlyArray<{ id: SceneryAssetId; url: string }> = [
  'tree-round', 'tree-oak', 'tree-pine', 'tree-fat', 'tree-thin',
  'rock-large', 'rock-moss', 'rock-small', 'rock-flat',
  'grass-tuft', 'grass-soft', 'flower-red', 'flower-yellow', 'flower-purple',
  'bush', 'mushroom-cluster', 'lily', 'stump', 'fence', 'fallen-log',
].map(id => ({ id: id as SceneryAssetId, url: assetUrl(id as SceneryAssetId) }));

const emptyPlacements = (): Record<SceneryAssetId, SceneryPlacement[]> => ({
  'tree-round': [], 'tree-oak': [], 'tree-pine': [], 'tree-fat': [], 'tree-thin': [],
  'rock-large': [], 'rock-moss': [], 'rock-small': [], 'rock-flat': [],
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

export function createSceneryPlacements(sampleWorld: (x: number, z: number) => WorldSample): Record<SceneryAssetId, SceneryPlacement[]> {
  const result = emptyPlacements();

  // Large silhouettes sit on the exact simulation obstacle samples so the
  // visible forest and highland barriers explain why a route is blocked.
  for (let x = -114; x <= 114; x += 5.5) {
    for (let z = -114; z <= 114; z += 5.5) {
      const px = x + (noise(x, z, 1) - .5) * 2.4;
      const pz = z + (noise(x, z, 2) - .5) * 2.4;
      const sample = surfaceSample(sampleWorld, px, pz);
      if (sample.biome === 'forest' && sample.blocked) {
        const selector = noise(px, pz, 3);
        place(result, selector < .24 ? 'tree-round' : selector < .5 ? 'tree-oak' : selector < .7 ? 'tree-fat' : selector < .88 ? 'tree-thin' : 'tree-pine', px, pz, sample, .82, 1.16, 4);
        if (noise(px, pz, 5) > .5) place(result, 'bush', px + .75, pz - .55, surfaceSample(sampleWorld, px + .75, pz - .55), .75, 1.15, 6);
      } else if (sample.biome === 'rock' && sample.blocked) {
        place(result, noise(px, pz, 7) < .48 ? 'rock-large' : 'rock-moss', px, pz, sample, .72, 1.18, 8);
        place(result, 'rock-flat', px + .9, pz + .65, surfaceSample(sampleWorld, px + .9, pz + .65), .72, 1.1, 9);
      }
    }
  }

  // Small passable dressing uses a wider grid and conservative caps. It is
  // dense enough to read as ground cover while remaining a few draw calls.
  for (let x = -112; x <= 112; x += 3.15) {
    for (let z = -112; z <= 112; z += 3.15) {
      const px = x + (noise(x, z, 10) - .5) * 2.2;
      const pz = z + (noise(x, z, 11) - .5) * 2.2;
      const sample = surfaceSample(sampleWorld, px, pz);
      if (sample.blocked || sample.biome === 'lake') continue;
      if (Math.hypot(px, pz) < 9.5) continue;
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
        else if (selector < .94) place(result, 'rock-flat', px, pz, sample, .7, 1.12, 21);
      } else if (sample.biome === 'forest') {
        if (selector < .32) place(result, 'bush', px, pz, sample, .72, 1.15, 22);
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

  // Floating vegetation stays on the rendered water plane and away from its edge.
  for (let x = 26; x <= 58; x += 4.1) {
    for (let z = -44; z <= -12; z += 4.1) {
      if (Math.hypot(x - 42, z + 28) >= 16 || noise(x, z, 29) > .62) continue;
      result.lily.push({ x, y: -.49, z, rotationY: noise(x, z, 30) * Math.PI * 2, scale: .72 + noise(x, z, 31) * .42 });
    }
  }

  // A short fence line gives the starting meadow a trainer-scale landmark.
  for (let x = -15; x <= 15; x += 3.33) {
    const z = 119.6;
    const sample = surfaceSample(sampleWorld, x, z);
    if (!sample.blocked) place(result, 'fence', x, z, sample, 1, 1, 30);
  }
  // A small passable grove silhouettes the forest direction from the spawn.
  // These are visual landmarks, deliberately without physics colliders.
  for (const [x, z] of [[-13, -12], [-18, -17], [-24, -11], [-28, -20]] as const) {
    const sample = surfaceSample(sampleWorld, x, z);
    if (!sample.blocked && sample.biome !== 'lake') place(result, 'tree-round', x, z, sample, .68, .82, 35);
  }
  return result;
}

export const TRAIL_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-108, 18], [-76, 14], [-44, 9], [-12, 3], [20, 6], [51, 18], [80, 37], [108, 54],
];
