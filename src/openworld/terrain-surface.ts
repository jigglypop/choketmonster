import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import type { WorldAtlas } from './atlas';
import type { WorldSample } from './types';
import type { TerrainChunk } from './lod';
import { TERRAIN_CHUNK_SIZE } from './lod';
import { terrainSurfaceHeight } from './grounding';
import { worldSurfaceColor } from './materials';

type SurfaceArrays = {
  positions: Float32Array; normals: Float32Array; colors: Float32Array; uv: Float32Array; water: Float32Array; indices: Uint16Array | Uint32Array;
  skirt: { positions: Float32Array; normals: Float32Array; colors: Float32Array; uv: Float32Array; indices: Uint16Array | Uint32Array };
  userData: { shoreline: boolean; segments: number; waterVertices: number };
};

// Shore chunks sample the coast many times per vertex. Chunks come back as the player turns and walks,
// so their arrays are kept (a few dozen, least recently used first out) and only the GPU copies are per mount.
const SURFACE_CACHE_LIMIT = 96;
const surfaceCache = new WeakMap<(x: number, z: number) => WorldSample, WeakMap<WorldAtlas, Map<string, SurfaceArrays>>>();

function cachedSurfaces(sampleWorld: (x: number, z: number) => WorldSample, atlas: WorldAtlas): Map<string, SurfaceArrays> {
  let byAtlas = surfaceCache.get(sampleWorld);
  if (!byAtlas) surfaceCache.set(sampleWorld, byAtlas = new WeakMap());
  let surfaces = byAtlas.get(atlas);
  if (!surfaces) byAtlas.set(atlas, surfaces = new Map());
  return surfaces;
}

const indexArray = (indices: number[], vertices: number) => vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);

function buildSurface(chunk: TerrainChunk, sampleWorld: (x: number, z: number) => WorldSample, atlas: WorldAtlas): SurfaceArrays {
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
  // The skirt's normals come from three's own averaging, computed once for the cached copy.
  const skirt = new BufferGeometry();
  skirt.setAttribute('position', new Float32BufferAttribute(skirtPositions, 3));
  skirt.setIndex(skirtIndices); skirt.computeVertexNormals();
  const skirtNormals = skirt.getAttribute('normal').array as Float32Array;
  skirt.dispose();
  return {
    positions: new Float32Array(positions), normals: new Float32Array(normals), colors: new Float32Array(colors), uv: new Float32Array(uv), water: new Float32Array(water),
    indices: indexArray(indices, positions.length / 3),
    skirt: { positions: new Float32Array(skirtPositions), normals: skirtNormals, colors: new Float32Array(skirtColors), uv: new Float32Array(skirtUv), indices: indexArray(skirtIndices, skirtPositions.length / 3) },
    userData: { shoreline: wet && dry, segments: n, waterVertices: water.filter(value => value > 0).length },
  };
}

/**
 * Geometry and shore coverage share the collision sampler; never move its surface. Each call returns new
 * geometries (the caller disposes them) over arrays cached per chunk and detail level.
 */
export function createTerrainSurface(chunk: TerrainChunk, sampleWorld: (x: number, z: number) => WorldSample, atlas: WorldAtlas) {
  const surfaces = cachedSurfaces(sampleWorld, atlas);
  const key = `${chunk.x}:${chunk.z}:${chunk.segments}:${chunk.distance <= 44}`;
  let surface = surfaces.get(key);
  if (surface) surfaces.delete(key);
  else surface = buildSurface(chunk, sampleWorld, atlas);
  surfaces.set(key, surface);
  if (surfaces.size > SURFACE_CACHE_LIMIT) surfaces.delete(surfaces.keys().next().value!);
  // Attributes wrap the cached arrays without copying; nothing writes to them.
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(surface.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(surface.normals, 3));
  geometry.setAttribute('color', new BufferAttribute(surface.colors, 3));
  geometry.setAttribute('uv', new BufferAttribute(surface.uv, 2));
  geometry.setAttribute('waterCoverage', new BufferAttribute(surface.water, 1));
  geometry.setIndex(new BufferAttribute(surface.indices, 1));
  geometry.userData = { ...surface.userData };
  const skirt = new BufferGeometry();
  skirt.setAttribute('position', new BufferAttribute(surface.skirt.positions, 3));
  skirt.setAttribute('color', new BufferAttribute(surface.skirt.colors, 3));
  skirt.setAttribute('uv', new BufferAttribute(surface.skirt.uv, 2));
  skirt.setAttribute('normal', new BufferAttribute(surface.skirt.normals, 3));
  skirt.setIndex(new BufferAttribute(surface.skirt.indices, 1));
  return { geometry, skirt };
}
