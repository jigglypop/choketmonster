import type { WorldSample } from './types';

export type SceneryAssetId =
  | 'tree-round' | 'tree-oak' | 'tree-pine'
  | 'rock-large' | 'rock-small' | 'grass-tuft'
  | 'flower-red' | 'flower-yellow' | 'bush'
  | 'stump' | 'fence' | 'fallen-log';

export type SceneryPlacement = {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  scale: number;
};

export const SCENERY_ASSETS: ReadonlyArray<{ id: SceneryAssetId; url: string }> = [
  { id: 'tree-round', url: '/models/openworld/props/tree-round.glb' },
  { id: 'tree-oak', url: '/models/openworld/props/tree-oak.glb' },
  { id: 'tree-pine', url: '/models/openworld/props/tree-pine.glb' },
  { id: 'rock-large', url: '/models/openworld/props/rock-large.glb' },
  { id: 'rock-small', url: '/models/openworld/props/rock-small.glb' },
  { id: 'grass-tuft', url: '/models/openworld/props/grass-tuft.glb' },
  { id: 'flower-red', url: '/models/openworld/props/flower-red.glb' },
  { id: 'flower-yellow', url: '/models/openworld/props/flower-yellow.glb' },
  { id: 'bush', url: '/models/openworld/props/bush.glb' },
  { id: 'stump', url: '/models/openworld/props/stump.glb' },
  { id: 'fence', url: '/models/openworld/props/fence.glb' },
  { id: 'fallen-log', url: '/models/openworld/props/fallen-log.glb' },
];

const emptyPlacements = (): Record<SceneryAssetId, SceneryPlacement[]> => ({
  'tree-round': [], 'tree-oak': [], 'tree-pine': [],
  'rock-large': [], 'rock-small': [], 'grass-tuft': [],
  'flower-red': [], 'flower-yellow': [], bush: [],
  stump: [], fence: [], 'fallen-log': [],
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

export function createSceneryPlacements(sampleWorld: (x: number, z: number) => WorldSample): Record<SceneryAssetId, SceneryPlacement[]> {
  const result = emptyPlacements();

  // Large silhouettes sit on the exact simulation obstacle samples so the
  // visible forest and highland barriers explain why a route is blocked.
  for (let x = -114; x <= 114; x += 5.5) {
    for (let z = -114; z <= 114; z += 5.5) {
      const px = x + (noise(x, z, 1) - .5) * 2.4;
      const pz = z + (noise(x, z, 2) - .5) * 2.4;
      const sample = sampleWorld(px, pz);
      if (sample.biome === 'forest' && sample.blocked) {
        const selector = noise(px, pz, 3);
        place(result, selector < .34 ? 'tree-round' : selector < .74 ? 'tree-oak' : 'tree-pine', px, pz, sample, .82, 1.16, 4);
        if (noise(px, pz, 5) > .7) place(result, 'bush', px + 1.3, pz - .8, sampleWorld(px + 1.3, pz - .8), .75, 1.15, 6);
      } else if (sample.biome === 'rock' && sample.blocked) {
        place(result, 'rock-large', px, pz, sample, .72, 1.18, 7);
      }
    }
  }

  // Small passable dressing uses a wider grid and conservative caps. It is
  // dense enough to read as ground cover while remaining a few draw calls.
  for (let x = -112; x <= 112; x += 4.25) {
    for (let z = -112; z <= 112; z += 4.25) {
      const px = x + (noise(x, z, 10) - .5) * 3;
      const pz = z + (noise(x, z, 11) - .5) * 3;
      const sample = sampleWorld(px, pz);
      if (sample.blocked || sample.biome === 'lake') continue;
      const selector = noise(px, pz, 12);
      if (sample.biome === 'meadow') {
        if (selector < .48) place(result, 'grass-tuft', px, pz, sample, .6, 1.08, 13);
        else if (selector < .58) place(result, 'flower-yellow', px, pz, sample, .78, 1.18, 14);
        else if (selector < .66) place(result, 'flower-red', px, pz, sample, .82, 1.22, 15);
      } else if (sample.biome === 'forest') {
        if (selector < .35) place(result, 'bush', px, pz, sample, .72, 1.15, 17);
        else if (selector < .56) place(result, 'grass-tuft', px, pz, sample, .65, 1.12, 18);
        else if (selector > .94) place(result, selector > .975 ? 'fallen-log' : 'stump', px, pz, sample, .85, 1.15, 19);
      } else if (sample.biome === 'rock') {
        if (selector < .4) place(result, 'rock-small', px, pz, sample, .68, 1.25, 20);
      }
    }
  }

  // A short fence line gives the starting meadow a trainer-scale landmark.
  for (let x = -15; x <= 15; x += 3.33) {
    const z = 119.6;
    const sample = sampleWorld(x, z);
    if (!sample.blocked) place(result, 'fence', x, z, sample, 1, 1, 30);
  }
  // A small passable grove silhouettes the forest direction from the spawn.
  // These are visual landmarks, deliberately without physics colliders.
  for (const [x, z] of [[-13, -12], [-18, -17], [-24, -11], [-28, -20]] as const) {
    const sample = sampleWorld(x, z);
    if (!sample.blocked && sample.biome !== 'lake') place(result, 'tree-round', x, z, sample, .68, .82, 35);
  }
  return result;
}

export const TRAIL_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-108, 18], [-76, 14], [-44, 9], [-12, 3], [20, 6], [51, 18], [80, 37], [108, 54],
];
