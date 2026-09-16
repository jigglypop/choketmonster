import { describe, expect, it } from 'vitest';
import { shorelinePixels } from '../src/openworld/shoreline-texture';
import type { WorldSample } from '../src/openworld/types';

function pixels(sample: (x: number, z: number) => WorldSample, resolution: number) {
  const iterator = shorelinePixels(sample, resolution);
  let step = iterator.next(); while (!step.done) step = iterator.next(); return step.value;
}

describe('shoreline raster', () => {
  it('creates a monotonic coast independent of triangle direction while preserving dry and deep water', () => {
    const size = 64;
    const data = pixels((x, _z) => ({ biome: x > 0 ? 'lake' : 'meadow', height: 0, blocked: false }), size);
    for (let z = 0; z < size; z++) {
      let previous = -1;
      for (let x = 0; x < size; x++) {
        const value = data[(z * size + x) * 4];
        expect(value).toBeGreaterThanOrEqual(previous); previous = value;
        expect(data[(z * size + x) * 4 + 3]).toBe(255);
        expect(value).toBe(data[x * 4]);
      }
      expect(data[z * size * 4]).toBe(0); expect(data[(z * size + size - 1) * 4]).toBe(255);
    }
    expect(data[(size / 2 - 1) * 4]).toBeGreaterThan(0);
    expect(data[size / 2 * 4]).toBeLessThan(255);
  });
  it('does not introduce water into a dry region', () => {
    const data = pixels(() => ({ biome: 'rock', height: 1, blocked: false }), 16);
    for (let i = 0; i < data.length; i += 4) expect(data[i]).toBe(0);
  });
});
