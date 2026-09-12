import { describe, expect, it } from 'vitest';
import { findWorldPath, headingForStep } from '../src/openworld/navigation';
import type { WorldSample } from '../src/openworld/types';

const sample = (x: number, z: number): WorldSample => ({ height: 0, biome: 'meadow', blocked: x > 1 && x < 3 && Math.abs(z) < 2 });

describe('click navigation', () => {
  it('routes around solid scenery instead of crossing it', () => {
    const path = findWorldPath({ x: 0, z: 0 }, { x: 4, z: 0 }, sample);
    expect(path.length).toBeGreaterThan(0);
    expect(path.every(point => !sample(point.x, point.z).blocked)).toBe(true);
    expect(path.some(point => Math.abs(point.z) >= 2)).toBe(true);
    expect(path.at(-1)).toMatchObject({ x: 3.75, z: 0 });
  });

  it('chooses a nearby floor point when the click lands on a blocked cell', () => {
    const path = findWorldPath({ x: 0, z: 0 }, { x: 2, z: 0 }, sample);
    expect(path.length).toBeGreaterThan(0);
    expect(sample(path.at(-1)!.x, path.at(-1)!.z).blocked).toBe(false);
  });

  it('maps travel direction to the simulation heading contract', () => {
    expect([headingForStep(0, -1), headingForStep(1, 0), headingForStep(0, 1), headingForStep(-1, 0)]).toEqual([0, 1, 2, 3]);
  });
});
