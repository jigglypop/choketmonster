import type { WorldAtlas } from './atlas';
import type { WorldSample } from './types';

export function atlasMapProjection(atlas: WorldAtlas) {
  const xs = atlas.locations.map(item => item.x), zs = atlas.locations.map(item => item.z);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerZ = (Math.min(...zs) + Math.max(...zs)) / 2;
  const scale = 196 / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), 1);
  return { centerX, centerZ, scale };
}

export function terrainMapColor(sample: WorldSample, slope: number): [number, number, number] {
  const base: [number, number, number] = sample.surface === 'snow' ? [221, 232, 226]
    : sample.surface === 'desert' ? [214, 190, 138]
      : sample.surface === 'mountain' ? [143, 150, 133]
        : sample.biome === 'lake' ? [100, 169, 190]
          : sample.biome === 'forest' ? [115, 151, 111]
            : sample.biome === 'rock' ? [159, 157, 136] : [174, 192, 137];
  const light = Math.max(.72, Math.min(1.15, 1 + slope * .065 - (sample.blocked && sample.biome !== 'lake' ? .035 : 0)));
  return base.map(value => Math.round(value * light)) as [number, number, number];
}

const terrainCache = new WeakMap<WorldAtlas, string>();

/** Cached north-up relief uses exactly the terrain sampler used by the world. */
export function atlasTerrainImage(atlas: WorldAtlas): string {
  const cached = terrainCache.get(atlas); if (cached) return cached;
  const { centerX, centerZ, scale } = atlasMapProjection(atlas);
  const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 240;
  const context = canvas.getContext('2d')!;
  const pixels = context.createImageData(240, 240), heights = new Float32Array(240 * 240);
  const samples: WorldSample[] = [];
  for (let row = 0; row < 240; row++) for (let col = 0; col < 240; col++) {
    const sample = atlas.sample((col + .5 - 120) / scale + centerX, (row + .5 - 120) / scale + centerZ);
    heights[row * 240 + col] = sample.height; samples.push(sample);
  }
  for (let row = 0; row < 240; row++) for (let col = 0; col < 240; col++) {
    const index = row * 240 + col;
    const slope = heights[Math.max(0, row - 1) * 240 + Math.max(0, col - 1)] - heights[Math.min(239, row + 1) * 240 + Math.min(239, col + 1)];
    const color = terrainMapColor(samples[index], slope);
    pixels.data.set([...color, 255], index * 4);
  }
  context.putImageData(pixels, 0, 0);
  const image = canvas.toDataURL('image/png'); terrainCache.set(atlas, image); return image;
}
