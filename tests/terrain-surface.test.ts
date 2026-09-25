import { describe, expect, it } from 'vitest';
import { getWorldAtlas } from '../src/openworld/atlas';
import { terrainSurfaceHeight } from '../src/openworld/grounding';
import { createTerrainSurface } from '../src/openworld/terrain-surface';
import type { WorldSample } from '../src/openworld/types';

const atlas = getWorldAtlas('johto');
const sample = (x: number, z: number): WorldSample => ({ height: .03 * x + .2 * Math.sin(z * .07), biome: z > 0 ? 'lake' : 'meadow', blocked: z > 8 });

describe('continuous shoreline terrain', () => {
  it('keeps the walking height while creating a bounded transition across the actual coast', () => {
    const { geometry, skirt } = createTerrainSurface({ key: 'test', x: 0, z: 0, segments: 12, distance: 0 }, sample, atlas);
    const positions = geometry.getAttribute('position'), coverage = geometry.getAttribute('waterCoverage');
    let mixed = 0;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), z = positions.getZ(i), value = coverage.getX(i);
      expect(positions.getY(i)).toBeCloseTo(terrainSurfaceHeight(sample, x, z), 5);
      expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1);
      if (z > 2) expect(value).toBe(1);
      if (z < -2) expect(value).toBe(0);
      if (value > 0 && value < 1) mixed++;
    }
    expect(mixed).toBeGreaterThan(0);
    const skirtNormals = skirt.getAttribute('normal');
    for (let i = 0; i < skirtNormals.count; i++) {
      expect(Math.hypot(skirtNormals.getX(i), skirtNormals.getY(i), skirtNormals.getZ(i))).toBeCloseTo(1, 5);
    }
    geometry.dispose(); skirt.dispose();
  });

  it('builds a chunk once and hands each mount its own geometry over the cached arrays', () => {
    let samples = 0;
    const counted = (x: number, z: number) => { samples++; return sample(x, z); };
    const chunk = { key: 'cached', x: 40, z: 0, segments: 12, distance: 10 };
    const first = createTerrainSurface(chunk, counted, atlas), built = samples;
    const second = createTerrainSurface(chunk, counted, atlas);
    expect(samples).toBe(built);
    expect(second.geometry).not.toBe(first.geometry);
    for (const name of ['position', 'normal', 'color', 'uv', 'waterCoverage']) {
      expect(second.geometry.getAttribute(name).array).toBe(first.geometry.getAttribute(name).array);
    }
    expect(second.skirt.getAttribute('normal').array).toBe(first.skirt.getAttribute('normal').array);
    expect(second.geometry.userData).toEqual(first.geometry.userData);
    first.geometry.dispose(); first.skirt.dispose();
    expect(createTerrainSurface({ ...chunk, segments: 4, distance: 60 }, counted, atlas).geometry.getAttribute('position').count).toBeLessThan(first.geometry.getAttribute('position').count);
    expect(samples).toBeGreaterThan(built);
    for (const surface of [second]) { surface.geometry.dispose(); surface.skirt.dispose(); }
  });

  it('matches normals across neighboring chunks with different LODs', () => {
    const left = createTerrainSurface({ key: 'left', x: -20, z: 0, segments: 12, distance: 20 }, sample, atlas);
    const right = createTerrainSurface({ key: 'right', x: 20, z: 0, segments: 4, distance: 70 }, sample, atlas);
    const edge = new Map<string, number[]>();
    const p = left.geometry.getAttribute('position'), n = left.geometry.getAttribute('normal');
    for (let i = 0; i < p.count; i++) if (p.getX(i) === 0) edge.set(p.getZ(i).toFixed(4), [n.getX(i), n.getY(i), n.getZ(i)]);
    const otherP = right.geometry.getAttribute('position'), otherN = right.geometry.getAttribute('normal');
    for (let i = 0; i < otherP.count; i++) if (otherP.getX(i) === 0) {
      const match = edge.get(otherP.getZ(i).toFixed(4))!;
      expect(match).toBeDefined();
      [otherN.getX(i), otherN.getY(i), otherN.getZ(i)].forEach((value, axis) => expect(value).toBeCloseTo(match[axis], 6));
    }
    for (const surface of [left, right]) { surface.geometry.dispose(); surface.skirt.dispose(); }
  });
});
