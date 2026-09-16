import type { WorldSample } from './types';
import { WORLD_MIN, WORLD_MAX } from './world-space';

export const SHORELINE_RESOLUTION = 512;
type Sampler = (x: number, z: number) => WorldSample;
const cached = new WeakMap<Sampler, Promise<Uint8Array>>();
const weights = [1, 6, 15, 20, 15, 6, 1];

/** Smooth in world space, independent of terrain triangles and their LOD. */
export function* shorelinePixels(sample: Sampler, resolution = SHORELINE_RESOLUTION): Generator<void, Uint8Array> {
  const mask = new Float32Array(resolution * resolution), blurred = new Float32Array(mask.length);
  const span = WORLD_MAX - WORLD_MIN;
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      mask[z * resolution + x] = sample(WORLD_MIN + (x + .5) / resolution * span, WORLD_MIN + (z + .5) / resolution * span).biome === 'lake' ? 1 : 0;
    }
    if (z % 4 === 3) yield;
  }
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      let sum = 0;
      for (let d = -3; d <= 3; d++) sum += mask[z * resolution + Math.max(0, Math.min(resolution - 1, x + d))] * weights[d + 3];
      blurred[z * resolution + x] = sum / 64;
    }
    if (z % 16 === 15) yield;
  }
  const rgba = new Uint8Array(mask.length * 4);
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      let sum = 0;
      for (let d = -3; d <= 3; d++) sum += blurred[Math.max(0, Math.min(resolution - 1, z + d)) * resolution + x] * weights[d + 3];
      const offset = (z * resolution + x) * 4;
      rgba[offset] = Math.round(sum / 64 * 255); rgba[offset + 3] = 255;
    }
    if (z % 16 === 15) yield;
  }
  return rgba;
}

export function prepareShorelinePixels(sample: Sampler): Promise<Uint8Array> {
  let pending = cached.get(sample);
  if (!pending) {
    pending = (async () => {
      const iterator = shorelinePixels(sample);
      let step = iterator.next(), sliceStart = performance.now();
      while (!step.done) {
        if (performance.now() - sliceStart > 4) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          sliceStart = performance.now();
        }
        step = iterator.next();
      }
      return step.value;
    })();
    cached.set(sample, pending);
    void pending.catch(() => cached.delete(sample));
  }
  return pending;
}
