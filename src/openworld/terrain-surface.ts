import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import type { WorldAtlas } from './atlas';
import type { WorldSample } from './types';
import type { TerrainChunk } from './lod';
import { TERRAIN_CHUNK_SIZE } from './lod';
import { terrainSurfaceHeight } from './grounding';
import { worldSurfaceColor } from './materials';

/** Geometry and shore coverage share the collision sampler; never move its surface. */
export function createTerrainSurface(chunk: TerrainChunk, sampleWorld: (x: number, z: number) => WorldSample, atlas: WorldAtlas) {
  const samples = new Map<string, WorldSample>();
  const sample = (x: number, z: number) => {
    const key = `${x.toFixed(5)}:${z.toFixed(5)}`;
    let value = samples.get(key);
    if (!value) { value = sampleWorld(x, z); samples.set(key, value); }
    return value;
  };
  const height = (x: number, z: number) => terrainSurfaceHeight(sample, x, z);
  const half = TERRAIN_CHUNK_SIZE / 2;
  let wet = false, dry = false;
  for (let iz = 0; iz <= 8; iz++) for (let ix = 0; ix <= 8; ix++) {
    if (sample(chunk.x - half + ix * 5, chunk.z - half + iz * 5).biome === 'lake') wet = true;
    else dry = true;
  }
  // Refine only mixed shore chunks. Dry terrain keeps the original LOD budget.
  const n = wet && dry ? Math.max(chunk.segments, chunk.distance <= 44 ? 24 : 12) : chunk.segments;
  const stride = n + 1, positions: number[] = [], colors: number[] = [], normals: number[] = [], uv: number[] = [], water: number[] = [], indices: number[] = [];
  const normal = new Vector3();
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [.7071, .7071], [-.7071, .7071], [.7071, -.7071], [-.7071, -.7071]];
  const coverageAt = (x: number, z: number) => {
    const inside = sample(x, z).biome === 'lake';
    if (!wet || !dry) return inside ? 1 : 0;
    let distance = 4;
    for (const [dx, dz] of directions) {
      if ((sample(x + dx * 4, z + dz * 4).biome === 'lake') === inside) continue;
      let low = 0, high = 4;
      for (let step = 0; step < 4; step++) {
        const middle = (low + high) / 2;
        if ((sample(x + dx * middle, z + dz * middle).biome === 'lake') === inside) low = middle;
        else high = middle;
      }
      distance = Math.min(distance, (low + high) / 2);
    }
    return Math.max(0, Math.min(1, .5 + (inside ? distance : -distance) / 4));
  };
  for (let iz = 0; iz <= n; iz++) for (let ix = 0; ix <= n; ix++) {
    const x = chunk.x - half + ix * TERRAIN_CHUNK_SIZE / n, z = chunk.z - half + iz * TERRAIN_CHUNK_SIZE / n;
    const point = sample(x, z);
    const tint = worldSurfaceColor(atlas, point.biome === 'lake' ? { ...point, biome: 'meadow' } : point, x, z);
    tint.offsetHSL(0, .01, Math.sin(x * .12 + z * .07) * .035);
    positions.push(x, height(x, z), z); colors.push(tint.r, tint.g, tint.b); uv.push(x * .115, z * .115);
    // Sampling the same neighborhood on both sides of a chunk avoids LOD seams
    // and independently averaged edge normals that looked like polygon facets.
    const e = 2;
    normal.set(height(x - e, z) - height(x + e, z), 2 * e, height(x, z - e) - height(x, z + e)).normalize();
    normals.push(normal.x, normal.y, normal.z);
    water.push(coverageAt(x, z));
    if (ix < n && iz < n) { const a = iz * stride + ix, b = a + stride; indices.push(a, b, a + 1, b, b + 1, a + 1); }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geometry.setAttribute('waterCoverage', new Float32BufferAttribute(water, 1));
  geometry.setIndex(indices);
  geometry.userData = { shoreline: wet && dry, segments: n, waterVertices: water.filter(value => value > 0).length };
  const skirtPositions: number[] = [], skirtColors: number[] = [], skirtUv: number[] = [], skirtIndices: number[] = [];
  const edges = [Array.from({ length: stride }, (_, i) => i), Array.from({ length: stride }, (_, i) => i * stride + n),
    Array.from({ length: stride }, (_, i) => n * stride + n - i), Array.from({ length: stride }, (_, i) => (n - i) * stride)];
  for (const edge of edges) for (let i = 0; i < n; i++) {
    const start = skirtPositions.length / 3;
    for (const vertex of [edge[i], edge[i + 1]]) for (const depth of [0, 4]) {
      skirtPositions.push(positions[vertex * 3], positions[vertex * 3 + 1] - Math.max(.035, depth), positions[vertex * 3 + 2]);
      skirtColors.push(...colors.slice(vertex * 3, vertex * 3 + 3));
      skirtUv.push((positions[vertex * 3] + positions[vertex * 3 + 2]) * .115, depth * .115);
    }
    skirtIndices.push(start, start + 2, start + 1, start + 1, start + 2, start + 3);
  }
  const skirt = new BufferGeometry();
  skirt.setAttribute('position', new Float32BufferAttribute(skirtPositions, 3));
  skirt.setAttribute('color', new Float32BufferAttribute(skirtColors, 3));
  skirt.setAttribute('uv', new Float32BufferAttribute(skirtUv, 2));
  skirt.setIndex(skirtIndices); skirt.computeVertexNormals();
  return { geometry, skirt };
}
