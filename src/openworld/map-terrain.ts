import type { WorldAtlas } from './atlas';
import type { WorldSample } from './types';

export function atlasMapProjection(atlas: WorldAtlas) {
  const xs = atlas.locations.map(item => item.x), zs = atlas.locations.map(item => item.z);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerZ = (Math.min(...zs) + Math.max(...zs)) / 2;
  const scale = 196 / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), 1);
  return { centerX, centerZ, scale };
}

function terrainBaseColor(sample: WorldSample): [number, number, number] {
  return sample.surface === 'snow' ? [221, 232, 226]
    : sample.surface === 'desert' ? [214, 190, 138]
      : sample.surface === 'mountain' ? [143, 150, 133]
        : sample.biome === 'lake' ? [100, 169, 190]
          : sample.biome === 'forest' ? [115, 151, 111]
            : sample.biome === 'rock' ? [159, 157, 136] : [174, 192, 137];
}

function terrainLight(sample: WorldSample, slope: number): number {
  return Math.max(.72, Math.min(1.15, 1 + slope * .065 - (sample.blocked && sample.biome !== 'lake' ? .035 : 0)));
}

export function terrainMapColor(sample: WorldSample, slope: number): [number, number, number] {
  const light = terrainLight(sample, slope);
  return terrainBaseColor(sample).map(value => Math.round(value * light)) as [number, number, number];
}

/** Pixels across the north-up relief. It covers the 240-unit map square. */
export const TERRAIN_MAP_PIXELS = 384;
export type AtlasTerrain = { canvas: HTMLCanvasElement; url: string; pixels: number };
const ready = new WeakMap<WorldAtlas, AtlasTerrain>();
const pending = new WeakMap<WorldAtlas, Promise<AtlasTerrain>>();

export function cachedAtlasTerrain(atlas: WorldAtlas): AtlasTerrain | undefined { return ready.get(atlas); }

const yieldToBrowser = () => new Promise<void>(resolve => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 120 });
  else setTimeout(resolve, 0);
});

/** Uncompressed 24-bit BMP. PNG encoding the relief held the main thread for ~0.4s on entry. */
function bitmapUrl(image: ImageData): string {
  const { width, height, data } = image, stride = Math.ceil(width * 3 / 4) * 4;
  const bytes = new Uint8Array(54 + stride * height), view = new DataView(bytes.buffer);
  view.setUint16(0, 0x4d42, true); view.setUint32(2, bytes.length, true); view.setUint32(10, 54, true);
  view.setUint32(14, 40, true); view.setInt32(18, width, true); view.setInt32(22, height, true);
  view.setUint16(26, 1, true); view.setUint16(28, 24, true); view.setUint32(34, stride * height, true);
  for (let row = 0; row < height; row++) {
    const out = 54 + (height - 1 - row) * stride;
    for (let col = 0; col < width; col++) {
      const from = (row * width + col) * 4, to = out + col * 3;
      bytes[to] = data[from + 2]; bytes[to + 1] = data[from + 1]; bytes[to + 2] = data[from];
    }
  }
  return URL.createObjectURL(new Blob([bytes], { type: 'image/bmp' }));
}

/**
 * Samples exactly the terrain function the world uses, in short slices so the
 * first map open never blocks a frame. The result is cached per atlas.
 */
export function prepareAtlasTerrain(atlas: WorldAtlas): Promise<AtlasTerrain> {
  const done = ready.get(atlas); if (done) return Promise.resolve(done);
  const running = pending.get(atlas); if (running) return running;
  const task = (async () => {
    const pixels = TERRAIN_MAP_PIXELS, { centerX, centerZ, scale } = atlasMapProjection(atlas), unit = pixels / 240;
    const heights = new Float32Array(pixels * pixels), base = new Uint8ClampedArray(pixels * pixels * 3), blocked = new Uint8Array(pixels * pixels);
    let row = 0;
    while (row < pixels) {
      const sliceStart = performance.now();
      for (; row < pixels && performance.now() - sliceStart < 8; row++) for (let col = 0; col < pixels; col++) {
        const index = row * pixels + col;
        const sample = atlas.sample((col + .5) / unit / scale - 120 / scale + centerX, (row + .5) / unit / scale - 120 / scale + centerZ);
        heights[index] = sample.height; base.set(terrainBaseColor(sample), index * 3);
        blocked[index] = sample.blocked && sample.biome !== 'lake' ? 1 : 0;
      }
      if (row < pixels) await yieldToBrowser();
    }
    const canvas = document.createElement('canvas'); canvas.width = pixels; canvas.height = pixels;
    const context = canvas.getContext('2d')!, image = context.createImageData(pixels, pixels);
    for (let r = 0; r < pixels; r++) for (let c = 0; c < pixels; c++) {
      const index = r * pixels + c;
      const slope = heights[Math.max(0, r - 1) * pixels + Math.max(0, c - 1)] - heights[Math.min(pixels - 1, r + 1) * pixels + Math.min(pixels - 1, c + 1)];
      const light = Math.max(.72, Math.min(1.15, 1 + slope * .065 - blocked[index] * .035));
      image.data[index * 4] = base[index * 3] * light; image.data[index * 4 + 1] = base[index * 3 + 1] * light;
      image.data[index * 4 + 2] = base[index * 3 + 2] * light; image.data[index * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const result = { canvas, pixels, url: bitmapUrl(image) };
    ready.set(atlas, result); pending.delete(atlas);
    return result;
  })();
  pending.set(atlas, task);
  return task;
}

/** Greedy label placement: higher-priority labels win, overlapping ones stay hover-only. */
export function placeMapLabels<T extends { id: string; name: string; x: number; y: number; priority: number }>(items: readonly T[], fontSize: number): Set<string> {
  const placed: Array<[number, number, number, number]> = [], visible = new Set<string>();
  const width = (text: string) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) < 128 ? .58 : 1.02) * fontSize, 0) + fontSize * .4;
  for (const item of [...items].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
    const box: [number, number, number, number] = [item.x + 4, item.y - 4 - fontSize, item.x + 4 + width(item.name), item.y - 4 + fontSize * .3];
    if (placed.some(other => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) continue;
    placed.push(box); visible.add(item.id);
  }
  return visible;
}
