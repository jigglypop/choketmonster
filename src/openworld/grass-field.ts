import type { WorldAtlas } from './atlas';
import type { WorldSample } from './types';
import { terrainSurfaceHeight } from './grounding';
import { isTownPaved, trailHalfWidth } from './world-details';
import { WORLD_MAX, WORLD_MIN } from './world-space';

/**
 * Visual-only wind grass. Blades are seeded from their cell and follow the rendered
 * terrain; nothing here feeds collision, traversal, spawning or simulation RNG.
 */
export const GRASS_CELL = 16;
/** Blades per m² generated for a cell. Budgets draw a uniform prefix of that list. */
export const GRASS_DENSITY = 40;
const NODE = 1;
/** Blocked woodland floor keeps a fading lawn this far past walkable ground, so there is no hard edge. */
const FRINGE = 9;
const SHORE = 1.9;
const MARGIN = FRINGE + 1;
const GRID = GRASS_CELL / NODE + 1 + MARGIN * 2;
/** Encoded in the integer part of each blade's `w`: 0 lawn tint … FOREST_STEPS woodland tint. */
export const GRASS_FOREST_STEPS = 8;
const CACHE_LIMIT = 72;

export type GrassBudget = { radius: number; density: number; maxBlades: number; near: number; far: number; strength: number };
/** Distance LOD matches gaesup's SFE curve: full density to `near` (camera distance), fading to zero at `far`. */
export const GRASS_BUDGETS: Readonly<Record<'desktop' | 'mobile', GrassBudget>> = {
  desktop: { radius: 58, density: GRASS_DENSITY, maxBlades: 60_000, near: 22, far: 60, strength: 1.35 },
  mobile: { radius: 38, density: 20, maxBlades: 20_000, near: 14, far: 40, strength: 1.35 },
};

/** `offsets` holds x, y, z and w = forest tint step + seed in [0, 1) per blade, in a spatially uniform order. */
export type GrassCell = { key: number; ix: number; iz: number; x: number; z: number; count: number; minY: number; maxY: number; offsets: Float32Array };
type Segment = { x: number; z: number; dx: number; dz: number; lengthSquared: number; clear: number; fade: number; minX: number; maxX: number; minZ: number; maxZ: number };
export type GrassField = {
  sample: (x: number, z: number) => WorldSample;
  segments: readonly Segment[];
  towns: ReadonlyArray<{ x: number; z: number }>;
  cells: Map<number, GrassCell | null>;
};

const CELLS = (WORLD_MAX - WORLD_MIN) / GRASS_CELL;
export const grassCellKey = (ix: number, iz: number) => ix * 1024 + iz;
const hash = (a: number, b: number) => { const value = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return value - Math.floor(value); };
const smooth = (edge0: number, edge1: number, value: number) => { const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0))); return t * t * (3 - 2 * t); };

const fields = new WeakMap<(x: number, z: number) => WorldSample, Map<string, GrassField>>();
/** Trail ribbons and town paving use the same inputs as TrailAndWater, so blades stop at their visible edge. */
export function grassField(sample: (x: number, z: number) => WorldSample, atlas: WorldAtlas, skipTown: (id: string) => boolean = () => false): GrassField {
  let byAtlas = fields.get(sample);
  if (!byAtlas) fields.set(sample, byAtlas = new Map());
  let field = byAtlas.get(atlas.mapVersion);
  if (field) return field;
  const byId = new Map(atlas.locations.map(item => [item.id, item]));
  const segments: Segment[] = [];
  for (const [fromId, toId] of atlas.surfaceConnections) {
    const from = byId.get(fromId), to = byId.get(toId);
    if (!from || !to) continue;
    // The ribbon's outer columns wobble by up to 9%; blades start just past that and thicken over a metre.
    const clear = trailHalfWidth(fromId, toId) * 1.1 + .12, fade = clear + 1.05;
    const dx = to.x - from.x, dz = to.z - from.z;
    segments.push({ x: from.x, z: from.z, dx, dz, lengthSquared: dx * dx + dz * dz || 1, clear, fade,
      minX: Math.min(from.x, to.x) - fade, maxX: Math.max(from.x, to.x) + fade, minZ: Math.min(from.z, to.z) - fade, maxZ: Math.max(from.z, to.z) + fade });
  }
  const towns = atlas.locations.filter(item => item.kind === 'town' && !skipTown(item.id)).map(item => ({ x: item.x, z: item.z }));
  field = { sample, segments, towns, cells: new Map() };
  byAtlas.set(atlas.mapVersion, field);
  return field;
}

/** Cells whose centres lie within `radius`, nearest first. */
export function grassCellsNear(point: { x: number; z: number }, radius: number): Array<{ ix: number; iz: number; key: number; distance: number }> {
  const result: Array<{ ix: number; iz: number; key: number; distance: number }> = [];
  const min = (value: number) => Math.max(0, Math.floor((value - radius - WORLD_MIN) / GRASS_CELL));
  const max = (value: number) => Math.min(CELLS - 1, Math.floor((value + radius - WORLD_MIN) / GRASS_CELL));
  for (let ix = min(point.x); ix <= max(point.x); ix++) for (let iz = min(point.z); iz <= max(point.z); iz++) {
    const distance = Math.hypot(WORLD_MIN + (ix + .5) * GRASS_CELL - point.x, WORLD_MIN + (iz + .5) * GRASS_CELL - point.z);
    if (distance <= radius) result.push({ ix, iz, key: grassCellKey(ix, iz), distance });
  }
  return result.sort((a, b) => a.distance - b.distance || a.key - b.key);
}

/** Chamfer distance (in nodes) from every node to the nearest node with `source[index]`. */
function distanceField(source: Uint8Array): Float32Array {
  const distance = new Float32Array(GRID * GRID).fill(1e4), diagonal = Math.SQRT2;
  for (let index = 0; index < source.length; index++) if (source[index]) distance[index] = 0;
  for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    const index = z * GRID + x; let value = distance[index];
    if (x > 0) value = Math.min(value, distance[index - 1] + 1);
    if (z > 0) {
      value = Math.min(value, distance[index - GRID] + 1);
      if (x > 0) value = Math.min(value, distance[index - GRID - 1] + diagonal);
      if (x < GRID - 1) value = Math.min(value, distance[index - GRID + 1] + diagonal);
    }
    distance[index] = value;
  }
  for (let z = GRID - 1; z >= 0; z--) for (let x = GRID - 1; x >= 0; x--) {
    const index = z * GRID + x; let value = distance[index];
    if (x < GRID - 1) value = Math.min(value, distance[index + 1] + 1);
    if (z < GRID - 1) {
      value = Math.min(value, distance[index + GRID] + 1);
      if (x < GRID - 1) value = Math.min(value, distance[index + GRID + 1] + diagonal);
      if (x > 0) value = Math.min(value, distance[index + GRID - 1] + diagonal);
    }
    distance[index] = value;
  }
  return distance;
}

/** Grass weight, hard obstacles and woodland tint on a 1 m lattice with a margin for shore and fringe distances. */
function coverage(field: GrassField, x0: number, z0: number) {
  const walkable = new Uint8Array(GRID * GRID), water = new Uint8Array(GRID * GRID), floor = new Uint8Array(GRID * GRID);
  const forest = new Uint8Array(GRID * GRID), hard = new Uint8Array(GRID * GRID);
  let any = false;
  for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    const index = z * GRID + x, point = field.sample(x0 + (x - MARGIN) * NODE, z0 + (z - MARGIN) * NODE);
    if (point.biome === 'lake') { water[index] = hard[index] = 1; continue; }
    // Rock, snow, sand, mountain and building footprints keep their own surfaces.
    if (point.surface || point.biome === 'rock' || (point.blocked && point.biome !== 'forest')) { hard[index] = 1; continue; }
    forest[index] = point.biome === 'forest' ? 1 : 0;
    if (point.blocked) floor[index] = 1; else { walkable[index] = 1; any = true; }
  }
  const weight = new Float32Array(GRID * GRID);
  if (!any && !floor.some(value => value)) return { weight, forest, hard };
  const walk = distanceField(walkable), shore = distanceField(water);
  for (let index = 0; index < weight.length; index++) {
    const lawn = walkable[index] ? 1 : floor[index] ? 1 - smooth(1.5, FRINGE, walk[index] * NODE) : 0;
    weight[index] = lawn * smooth(SHORE * .55, SHORE + .9, shore[index] * NODE);
  }
  return { weight, forest, hard };
}

function onTrail(segments: readonly Segment[], x: number, z: number): number {
  let factor = 1;
  for (const segment of segments) {
    if (x < segment.minX || x > segment.maxX || z < segment.minZ || z > segment.maxZ) continue;
    const t = Math.max(0, Math.min(1, ((x - segment.x) * segment.dx + (z - segment.z) * segment.dz) / segment.lengthSquared));
    const distance = Math.hypot(x - segment.x - segment.dx * t, z - segment.z - segment.dz * t);
    if (distance <= segment.clear) return 0;
    factor = Math.min(factor, smooth(segment.clear, segment.fade, distance));
  }
  return factor;
}

/** Deterministic blade list for one cell, or null when nothing grows there. Cached per field. */
export function buildGrassCell(field: GrassField, ix: number, iz: number): GrassCell | null {
  const key = grassCellKey(ix, iz);
  if (field.cells.has(key)) {
    const cached = field.cells.get(key)!;
    field.cells.delete(key); field.cells.set(key, cached);
    return cached;
  }
  const x0 = WORLD_MIN + ix * GRASS_CELL, z0 = WORLD_MIN + iz * GRASS_CELL;
  const { weight, forest, hard } = coverage(field, x0, z0);
  const segments = field.segments.filter(item => item.maxX >= x0 && item.minX <= x0 + GRASS_CELL && item.maxZ >= z0 && item.minZ <= z0 + GRASS_CELL);
  const towns = field.towns.filter(town => Math.abs(town.x - x0 - GRASS_CELL / 2) < 18 + GRASS_CELL / 2 && Math.abs(town.z - z0 - GRASS_CELL / 2) < 18 + GRASS_CELL / 2);
  // Height corners repeat for every blade in the cell; memoize them for this build only.
  const corners = new Map<number, WorldSample>();
  const cornerSample = (x: number, z: number) => {
    const id = Math.round((x - WORLD_MIN) * 64) * 65536 + Math.round((z - WORLD_MIN) * 64);
    let value = corners.get(id);
    if (!value) corners.set(id, value = field.sample(x, z));
    return value;
  };
  const candidates = GRASS_DENSITY * GRASS_CELL * GRASS_CELL, values: number[] = [];
  // R2 low-discrepancy order: every prefix of the accepted list stays evenly spread for distance LOD.
  const startX = hash(ix, iz + 17.3), startZ = hash(iz + 3.1, ix);
  let minY = Infinity, maxY = -Infinity;
  for (let index = 0; index < candidates; index++) {
    const u = (startX + index * .7548776662466927) % 1, v = (startZ + index * .5698402909980532) % 1;
    const gx = u * GRASS_CELL / NODE + MARGIN, gz = v * GRASS_CELL / NODE + MARGIN;
    const cx = Math.floor(gx), cz = Math.floor(gz), tx = gx - cx, tz = gz - cz, base = cz * GRID + cx;
    const w = (weight[base] * (1 - tx) + weight[base + 1] * tx) * (1 - tz) + (weight[base + GRID] * (1 - tx) + weight[base + GRID + 1] * tx) * tz;
    // A hard lattice corner means the blade may be inside a footprint or cliff; the lattice is finer than any of them.
    if (w <= .001 || hard[base] | hard[base + 1] | hard[base + GRID] | hard[base + GRID + 1]) continue;
    const roll = hash(index * .013 + ix * 3.7, iz * 5.3 + index * .007);
    if (roll >= w) continue;
    const x = x0 + u * GRASS_CELL, z = z0 + v * GRASS_CELL;
    if (segments.length && roll >= w * onTrail(segments, x, z)) continue;
    if (towns.some(town => Math.abs(x - town.x) < 18 && Math.abs(z - town.z) < 18 && isTownPaved(x - town.x, z - town.z))) continue;
    const y = terrainSurfaceHeight(cornerSample, x, z) - .02;
    const tint = (forest[base] * (1 - tx) + forest[base + 1] * tx) * (1 - tz) + (forest[base + GRID] * (1 - tx) + forest[base + GRID + 1] * tx) * tz;
    values.push(x, y, z, Math.round(tint * GRASS_FOREST_STEPS) + Math.min(.999, hash(x, z)));
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const cell = values.length ? { key, ix, iz, x: x0 + GRASS_CELL / 2, z: z0 + GRASS_CELL / 2, count: values.length / 4, minY, maxY, offsets: new Float32Array(values) } : null;
  field.cells.set(key, cell);
  if (field.cells.size > CACHE_LIMIT) field.cells.delete(field.cells.keys().next().value!);
  return cell;
}

/** Blades one cell may draw under a budget: a prefix of its uniformly ordered list. */
export const grassCellCapacity = (cell: GrassCell, budget: GrassBudget) => Math.min(cell.count, Math.ceil(cell.count * budget.density / GRASS_DENSITY));

/** gaesup's SFE distance weight, reused for the analytic budget check. */
export function grassLodWeight(distance: number, budget: GrassBudget): number {
  return distance <= budget.near ? 1 : distance >= budget.far ? 0 : (1 - (distance - budget.near) / (budget.far - budget.near)) ** Math.max(1, budget.strength);
}

/** Uniform scale keeping every drawn cell's LOD share while the total fits the blade budget. */
export function grassBudgetScale(requested: number, budget: GrassBudget): number {
  return requested > budget.maxBlades ? budget.maxBlades / requested : 1;
}
