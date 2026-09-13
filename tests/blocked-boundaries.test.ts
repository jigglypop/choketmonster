import { describe, expect, it } from 'vitest';
import { blockedBoundarySegments } from '../src/openworld/blocked-boundaries';
import type { WorldSample } from '../src/openworld/types';

const sample = (x: number): WorldSample => ({ height: 0, biome: x < 0 ? 'meadow' : 'forest', blocked: x >= 0 });

describe('blocked terrain boundary rendering', () => {
  it('outlines collision transitions deterministically', () => {
    const calls: Array<[number, number]> = [];
    const sampled = (x: number, z: number) => { calls.push([x, z]); return sample(x); };
    const first = blockedBoundarySegments(sampled, 0, 0, 8, 2);
    expect(first).toEqual(blockedBoundarySegments(sample, 0, 0, 8, 2));
    expect(first).toHaveLength(4);
    expect(first.every(segment => segment.x1 === 0 && segment.x2 === 0)).toBe(true);
    expect(calls).toHaveLength(36);
  });

  it('retains a transition that falls exactly on the owned chunk seam', () => {
    const seamSample = (x: number): WorldSample => ({ height: 0, biome: 'meadow', blocked: x < -4 });
    const segments = blockedBoundarySegments(seamSample, 0, 0, 8, 2);
    expect(segments).toHaveLength(4);
    expect(segments.every(segment => segment.x1 === -4 && segment.x2 === -4)).toBe(true);
  });

  it('rejects invalid render grids safely', () => {
    expect(blockedBoundarySegments(sample, 0, 0, 0, 2)).toEqual([]);
    expect(blockedBoundarySegments(sample, 0, 0, 8, Number.NaN)).toEqual([]);
  });
});
