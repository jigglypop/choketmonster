import { describe, expect, it } from 'vitest';
import { distanceToWaterSurface, selectWaterLod } from '../src/openworld/water-lod';

describe('water surface LOD', () => {
  it('measures from a circular shoreline instead of its center', () => {
    const shape = { lake: true, center: [100, -20] as const, radius: 25 };
    expect(distanceToWaterSurface({ x: 100, z: -20 }, shape)).toBe(0);
    expect(distanceToWaterSurface({ x: 125, z: -20 }, shape)).toBe(0);
    expect(distanceToWaterSurface({ x: 137, z: -20 }, shape)).toBe(12);
  });

  it('measures the nearest point on a rectangular shoreline, including corners', () => {
    const shape = { center: [10, 20] as const, extent: [30, 10] as const };
    expect(distanceToWaterSurface({ x: 35, z: 20 }, shape)).toBe(0);
    expect(distanceToWaterSurface({ x: 44, z: 20 }, shape)).toBe(4);
    expect(distanceToWaterSurface({ x: 43, z: 34 }, shape)).toBe(5);
  });

  it('uses desktop hysteresis at 40 units entering and above 52 units leaving', () => {
    expect(selectWaterLod(undefined, 40)).toBe('detailed');
    expect(selectWaterLod(undefined, 40.01)).toBe('simple');
    expect(selectWaterLod('detailed', 52)).toBe('detailed');
    expect(selectWaterLod('detailed', 52.01)).toBe('simple');
    expect(selectWaterLod('simple', 46)).toBe('simple');
  });

  it('uses mobile hysteresis at 24 units entering and above 34 units leaving', () => {
    expect(selectWaterLod(undefined, 24, true)).toBe('detailed');
    expect(selectWaterLod(undefined, 24.01, true)).toBe('simple');
    expect(selectWaterLod('detailed', 34, true)).toBe('detailed');
    expect(selectWaterLod('detailed', 34.01, true)).toBe('simple');
    expect(selectWaterLod('simple', 29, true)).toBe('simple');
  });
});
