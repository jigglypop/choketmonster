import type { WorldAtlas } from './atlas';
import type { WorldSample } from './types';
import { buildExplorationSites, buildRouteEdgeMarkers } from './exploration-sites';
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
/** Route tall-grass candidates per m² inside a patch; the same prefix rule applies. */
export const TALL_GRASS_DENSITY = 88;
const NODE = 1;
/** Blocked woodland floor keeps a fading lawn this far past walkable ground, so there is no hard edge. */
const FRINGE = 9;
const SHORE = 1.9;
const MARGIN = FRINGE + 1;
const GRID = GRASS_CELL / NODE + 1 + MARGIN * 2;
/** Encoded in the integer part of each blade's `w`: 0 lawn tint … FOREST_STEPS woodland tint. */
export const GRASS_FOREST_STEPS = 8;
/** Tall grass starts this far from a town centre, past its plaza, lamps and gateway pillars. */
export const TALL_GRASS_TOWN_CLEAR = 24;
const CACHE_LIMIT = 72;
const TAU = Math.PI * 2;

export type GrassBudget = { radius: number; density: number; maxBlades: number; near: number; far: number; strength: number };
/** Distance LOD matches gaesup's SFE curve: full density to `near` (camera distance), fading to zero at `far`. */
export const GRASS_BUDGETS: Readonly<Record<'desktop' | 'mobile', GrassBudget>> = {
  desktop: { radius: 58, density: GRASS_DENSITY, maxBlades: 60_000, near: 22, far: 60, strength: 1.35 },
  mobile: { radius: 38, density: 20, maxBlades: 20_000, near: 14, far: 40, strength: 1.35 },
};
/** Route tall grass reads from further away than the lawn, so it thins later and keeps its own cap. */
export const TALL_GRASS_BUDGETS: Readonly<Record<'desktop' | 'mobile', GrassBudget>> = {
  desktop: { radius: 58, density: TALL_GRASS_DENSITY, maxBlades: 30_000, near: 26, far: 64, strength: 1.2 },
  mobile: { radius: 38, density: 36, maxBlades: 9_000, near: 16, far: 42, strength: 1.2 },
};

/**
 * `offsets` holds x, y, z and w = woodland tint step + draw rank in [0, 1) per blade, in a spatially uniform order.
 * `shapes` holds the clumped blade profile: lean x, lean z (radians toward the bend), height, facing yaw + 8 × tone step.
 */
export type GrassLayer = { count: number; minY: number; maxY: number; offsets: Float32Array; shapes: Float32Array };
export type GrassCell = GrassLayer & { key: number; ix: number; iz: number; x: number; z: number; tall: GrassLayer | null };
type Segment = { x: number; z: number; dx: number; dz: number; lengthSquared: number; clear: number; fade: number; minX: number; maxX: number; minZ: number; maxZ: number };
/** A land route centreline, with its box grown by the reach tall grass may spread from it. */
type Route = { x: number; z: number; dx: number; dz: number; lengthSquared: number; minX: number; maxX: number; minZ: number; maxZ: number };
type KeepOut = { x: number; z: number; radius: number };
export type GrassField = {
  sample: (x: number, z: number) => WorldSample;
  segments: readonly Segment[];
  towns: ReadonlyArray<{ x: number; z: number }>;
  routes: readonly Route[];
  keepOut: readonly KeepOut[];
  cells: Map<number, GrassCell | null>;
};

/** Tall grass is laid out on world-aligned square tiles this wide; patches are unions of tiles with a ragged border. */
export const TALL_GRASS_TILE = 2;
/** Tiles per block side. Each block may hold one rectangle of tiles, so patches spread as blocky squares. */
const TALL_GRASS_BLOCK = 4;
/** Share of blocks holding a patch. */
const TALL_GRASS_BLOCK_CHANCE = .55;
/** Patches spread this far either side of a land route's centreline, trail included. */
export const TALL_GRASS_REACH = 10;

const CELLS = (WORLD_MAX - WORLD_MIN) / GRASS_CELL;
export const grassCellKey = (ix: number, iz: number) => ix * 1024 + iz;
const hash = (a: number, b: number) => { const value = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return value - Math.floor(value); };
const smooth = (edge0: number, edge1: number, value: number) => { const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0))); return t * t * (3 - 2 * t); };
function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

/** Jittered clump centres (Voronoi) around one cell: blades of a clump share height and tone and fan out from its heart. */
const clump = { x: 0, z: 0, id: 0, distance: 0 };
function clumpField(x0: number, z0: number, size: number, salt: number) {
  const gx0 = Math.floor(x0 / size) - 2, gz0 = Math.floor(z0 / size) - 2, span = Math.ceil(GRASS_CELL / size) + 5, points = new Float32Array(span * span * 3);
  for (let j = 0; j < span; j++) for (let i = 0; i < span; i++) {
    const ix = gx0 + i, iz = gz0 + j, k = (j * span + i) * 3;
    points[k] = (ix + .15 + hash(ix + salt, iz) * .7) * size; points[k + 1] = (iz + .15 + hash(iz - salt, ix + 7.7) * .7) * size; points[k + 2] = hash(ix * 1.31 + salt, iz * .77 - salt);
  }
  return (x: number, z: number) => {
    const gx = Math.floor(x / size) - gx0, gz = Math.floor(z / size) - gz0;
    let best = Infinity;
    for (let j = gz - 1; j <= gz + 1; j++) for (let i = gx - 1; i <= gx + 1; i++) {
      const k = (j * span + i) * 3, distance = (points[k] - x) ** 2 + (points[k + 1] - z) ** 2;
      if (distance < best) { best = distance; clump.x = points[k]; clump.z = points[k + 1]; clump.id = points[k + 2]; }
    }
    clump.distance = Math.sqrt(best);
    return clump;
  };
}

/** Packs one blade profile; facing follows the bend so curled blades show their face to the camera above. */
function pushShape(shapes: number[], direction: number, lean: number, height: number, twist: number, tone: number) {
  const yaw = ((direction + twist) % TAU + TAU) % TAU;
  shapes.push(Math.cos(direction) * lean, Math.sin(direction) * lean, height, yaw + 8 * Math.round(Math.max(0, Math.min(1, tone)) * 15));
}

/**
 * Whether tile (tx, tz) grows tall grass: its block holds a rectangle of 2–4 × 2–4 tiles covering it,
 * its centre lies within reach of a land route, and it keeps clear of towns, caves, gates and landmarks.
 */
function tallTile(field: GrassField, tx: number, tz: number): boolean {
  const bx = Math.floor(tx / TALL_GRASS_BLOCK), bz = Math.floor(tz / TALL_GRASS_BLOCK);
  if (hash(bx * 1.37 + 11.1, bz * .73 - 4.9) >= TALL_GRASS_BLOCK_CHANCE) return false;
  const width = 2 + Math.floor(hash(bx + 3.3, bz * 1.9) * 3), depth = 2 + Math.floor(hash(bz - 7.1, bx * 2.3) * 3);
  const left = Math.floor(hash(bx * .61, bz + 5.5) * (TALL_GRASS_BLOCK - width + 1)), top = Math.floor(hash(bz * .83 + 2.2, bx - 1.4) * (TALL_GRASS_BLOCK - depth + 1));
  const lx = tx - bx * TALL_GRASS_BLOCK - left, lz = tz - bz * TALL_GRASS_BLOCK - top;
  if (lx < 0 || lx >= width || lz < 0 || lz >= depth) return false;
  const x = (tx + .5) * TALL_GRASS_TILE, z = (tz + .5) * TALL_GRASS_TILE;
  if (field.keepOut.some(item => Math.hypot(x - item.x, z - item.z) < item.radius + TALL_GRASS_TILE)) return false;
  return field.routes.some(route => {
    if (x < route.minX || x > route.maxX || z < route.minZ || z > route.maxZ) return false;
    const t = Math.max(0, Math.min(1, ((x - route.x) * route.dx + (z - route.z) * route.dz) / route.lengthSquared));
    return Math.hypot(x - route.x - route.dx * t, z - route.z - route.dz * t) <= TALL_GRASS_REACH;
  });
}

const fields = new WeakMap<(x: number, z: number) => WorldSample, Map<string, GrassField>>();
/** Trail ribbons and town paving use the same inputs as TrailAndWater, so blades stop at their visible edge. */
export function grassField(sample: (x: number, z: number) => WorldSample, atlas: WorldAtlas, skipTown: (id: string) => boolean = () => false): GrassField {
  let byAtlas = fields.get(sample);
  if (!byAtlas) fields.set(sample, byAtlas = new Map());
  let field = byAtlas.get(atlas.mapVersion);
  if (field) return field;
  const byId = new Map(atlas.locations.map(item => [item.id, item]));
  const segments: Segment[] = [], routes: Route[] = [];
  for (const [fromId, toId] of atlas.surfaceConnections) {
    const from = byId.get(fromId), to = byId.get(toId);
    if (!from || !to) continue;
    // The ribbon's outer columns wobble by up to 9%; blades start just past that and thicken over a metre.
    const clear = trailHalfWidth(fromId, toId) * 1.1 + .12, fade = clear + 1.05;
    const dx = to.x - from.x, dz = to.z - from.z, lengthSquared = dx * dx + dz * dz || 1;
    segments.push({ x: from.x, z: from.z, dx, dz, lengthSquared, clear, fade,
      minX: Math.min(from.x, to.x) - fade, maxX: Math.max(from.x, to.x) + fade, minZ: Math.min(from.z, to.z) - fade, maxZ: Math.max(from.z, to.z) + fade });
    if (from.kind !== 'sea' && to.kind !== 'sea') routes.push({ x: from.x, z: from.z, dx, dz, lengthSquared,
      minX: Math.min(from.x, to.x) - TALL_GRASS_REACH, maxX: Math.max(from.x, to.x) + TALL_GRASS_REACH, minZ: Math.min(from.z, to.z) - TALL_GRASS_REACH, maxZ: Math.max(from.z, to.z) + TALL_GRASS_REACH });
  }
  const towns = atlas.locations.filter(item => item.kind === 'town' && !skipTown(item.id)).map(item => ({ x: item.x, z: item.z }));
  // Tall grass leaves room around towns, cave mouths, landmarks, gatehouses, rest spots and road markers.
  const keepOut: KeepOut[] = [
    ...atlas.locations.filter(item => item.kind === 'town').map(item => ({ x: item.x, z: item.z, radius: TALL_GRASS_TOWN_CLEAR })),
    ...atlas.locations.filter(item => item.kind === 'cave' || item.kind === 'special').map(item => ({ x: item.x, z: item.z, radius: 12 })),
    ...atlas.gates.flatMap(gate => {
      const from = byId.get(gate.from), to = byId.get(gate.to), point = gate.position ?? (from && to ? { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 } : undefined);
      return point ? [{ x: point.x, z: point.z, radius: 7 }] : [];
    }),
    ...buildExplorationSites(atlas, sample, 99).map(site => ({ x: site.x, z: site.z, radius: 4.2 })),
    ...buildRouteEdgeMarkers(atlas, sample, 99).map(marker => ({ x: marker.x, z: marker.z, radius: 1.3 })),
  ];
  field = { sample, segments, towns, routes, keepOut, cells: new Map() };
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

/** Grass weight, walkable ground, hard obstacles and woodland tint on a 1 m lattice with a margin for shore and fringe distances. */
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
  if (!any && !floor.some(value => value)) return { weight, walkable, forest, hard };
  const walk = distanceField(walkable), shore = distanceField(water);
  for (let index = 0; index < weight.length; index++) {
    const lawn = walkable[index] ? 1 : floor[index] ? 1 - smooth(1.5, FRINGE, walk[index] * NODE) : 0;
    weight[index] = lawn * smooth(SHORE * .55, SHORE + .9, shore[index] * NODE);
  }
  return { weight, walkable, forest, hard };
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

type Lattice = ReturnType<typeof coverage>;
const lerpLattice = (values: ArrayLike<number>, base: number, tx: number, tz: number) =>
  (values[base] * (1 - tx) + values[base + 1] * tx) * (1 - tz) + (values[base + GRID] * (1 - tx) + values[base + GRID + 1] * tx) * tz;

function layer(values: number[], shapes: number[], minY: number, maxY: number): GrassLayer | null {
  const count = values.length / 4;
  if (!count) return null;
  // Draw rank in the fractional part of w: budgets and the shader's distance fade keep the same prefix.
  for (let index = 0; index < count; index++) values[index * 4 + 3] += Math.min(.999, index / count);
  return { count, minY, maxY, offsets: new Float32Array(values), shapes: new Float32Array(shapes) };
}

/** Clustered, taller blades in tile-laid patches near each route, trail included, with a ragged fringe: open lawn only, never on a plaza, shore or landmark. */
function buildTallLayer(field: GrassField, lattice: Lattice, ix: number, iz: number, x0: number, z0: number, height: (x: number, z: number) => number): GrassLayer | null {
  if (!field.routes.some(route => route.maxX >= x0 && route.minX <= x0 + GRASS_CELL && route.maxZ >= z0 && route.minZ <= z0 + GRASS_CELL)) return null;
  const { weight, walkable, forest, hard } = lattice, values: number[] = [], shapes: number[] = [];
  // Cells start on even metres, so each holds whole tiles; a ring of neighbour tiles (inside the lattice margin)
  // tells each patch where its border is. A tile grows only when every lattice node it covers is open lawn.
  const step = TALL_GRASS_TILE / NODE, tiles = GRASS_CELL / TALL_GRASS_TILE, span = tiles + 2;
  const tx0 = Math.round(x0 / TALL_GRASS_TILE) - 1, tz0 = Math.round(z0 / TALL_GRASS_TILE) - 1, open = new Uint8Array(span * span);
  let any = false;
  for (let j = 0; j < span; j++) for (let i = 0; i < span; i++) {
    if (!tallTile(field, tx0 + i, tz0 + j)) continue;
    let clear = true;
    for (let dz = 0; dz <= step && clear; dz++) for (let dx = 0; dx <= step && clear; dx++) {
      const node = (MARGIN + (j - 1) * step + dz) * GRID + MARGIN + (i - 1) * step + dx;
      clear = !hard[node] && walkable[node] === 1 && weight[node] >= .7;
    }
    if (!clear) continue;
    open[j * span + i] = 1;
    if (i > 0 && j > 0 && i <= tiles && j <= tiles) any = true;
  }
  if (!any) return null;
  const at = (i: number, j: number) => open[j * span + i];
  const startX = hash(ix + 41.7, iz - 3.3), startZ = hash(iz + 9.2, ix + 5.5), nearestClump = clumpField(x0, z0, .8, 23);
  let minY = Infinity, maxY = -Infinity;
  for (let index = 0, candidates = TALL_GRASS_DENSITY * GRASS_CELL * GRASS_CELL; index < candidates; index++) {
    const u = (startX + index * .7548776662466927) % 1, v = (startZ + index * .5698402909980532) % 1;
    const fx = u * tiles, fz = v * tiles, ci = Math.floor(fx), cj = Math.floor(fz), I = ci + 1, J = cj + 1;
    if (!at(I, J)) continue;
    // Metres to the patch border: sides and corners that meet an empty tile. Inner seams between tiles do not count.
    const ex = fx - ci, ez = fz - cj;
    let edge = 2;
    if (!at(I - 1, J)) edge = Math.min(edge, ex);
    if (!at(I + 1, J)) edge = Math.min(edge, 1 - ex);
    if (!at(I, J - 1)) edge = Math.min(edge, ez);
    if (!at(I, J + 1)) edge = Math.min(edge, 1 - ez);
    if (!at(I - 1, J - 1)) edge = Math.min(edge, Math.hypot(ex, ez));
    if (!at(I + 1, J - 1)) edge = Math.min(edge, Math.hypot(1 - ex, ez));
    if (!at(I - 1, J + 1)) edge = Math.min(edge, Math.hypot(ex, 1 - ez));
    if (!at(I + 1, J + 1)) edge = Math.min(edge, Math.hypot(1 - ex, 1 - ez));
    const x = x0 + u * GRASS_CELL, z = z0 + v * GRASS_CELL, inset = edge * TALL_GRASS_TILE;
    // The border wanders up to a metre into the patch and thins out across it, so the squares never show.
    const ragged = .1 + .9 * valueNoise(x * .85 + 3.1, z * .85 - 7.3), fringe = smooth(ragged, ragged + .9, inset);
    if (inset < ragged || hash(index * .013 + ix * 2.1, iz * 1.7 - index * .009) > fringe * 1.4) continue;
    const gx = u * GRASS_CELL / NODE + MARGIN, gz = v * GRASS_CELL / NODE + MARGIN;
    const cx = Math.floor(gx), cz = Math.floor(gz), tx = gx - cx, tz = gz - cz, base = cz * GRID + cx;
    const y = height(x, z), c = nearestClump(x, z), spread = Math.min(1, c.distance / .62);
    const r1 = hash(x * 1.3 - 2.1, z * 2.9), r2 = hash(z * 3.7, x * 1.1 + 4.3), r3 = hash(x - z * 4.3, z + x * .7);
    const direction = Math.atan2(z - c.z, x - c.x) + (r1 - .5) * 1.5;
    // Tufts dome over their hearts, the patch rises from its fringe, and height drifts slowly across the field.
    const drift = .84 + .32 * valueNoise(x * .21 + 11, z * .21 - 5);
    const tall = (.56 + r3 * .2) * (.84 + c.id * .3) * (1 - .36 * spread * spread) * (.6 + .4 * smooth(ragged, ragged + 1.4, inset)) * drift;
    values.push(x, y, z, Math.round(lerpLattice(forest, base, tx, tz) * GRASS_FOREST_STEPS));
    pushShape(shapes, direction, .1 + spread * .42 + r2 * .1, tall, (r2 - .5) * .7, c.id * .6 + valueNoise(x * .07 - 5, z * .07 + 3) * .4);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return layer(values, shapes, minY, maxY);
}

/** Deterministic blade lists for one cell, or null when nothing grows there. Cached per field. */
export function buildGrassCell(field: GrassField, ix: number, iz: number): GrassCell | null {
  const key = grassCellKey(ix, iz);
  if (field.cells.has(key)) {
    const cached = field.cells.get(key)!;
    field.cells.delete(key); field.cells.set(key, cached);
    return cached;
  }
  const x0 = WORLD_MIN + ix * GRASS_CELL, z0 = WORLD_MIN + iz * GRASS_CELL;
  const lattice = coverage(field, x0, z0), { weight, forest, hard } = lattice;
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
  const height = (x: number, z: number) => terrainSurfaceHeight(cornerSample, x, z) - .02;
  const candidates = GRASS_DENSITY * GRASS_CELL * GRASS_CELL, values: number[] = [], shapes: number[] = [];
  // R2 low-discrepancy order: every prefix of the accepted list stays evenly spread for distance LOD.
  const startX = hash(ix, iz + 17.3), startZ = hash(iz + 3.1, ix), nearestClump = clumpField(x0, z0, 1.35, 5);
  let minY = Infinity, maxY = -Infinity;
  for (let index = 0; index < candidates; index++) {
    const u = (startX + index * .7548776662466927) % 1, v = (startZ + index * .5698402909980532) % 1;
    const gx = u * GRASS_CELL / NODE + MARGIN, gz = v * GRASS_CELL / NODE + MARGIN;
    const cx = Math.floor(gx), cz = Math.floor(gz), tx = gx - cx, tz = gz - cz, base = cz * GRID + cx;
    const w = lerpLattice(weight, base, tx, tz);
    // A hard lattice corner means the blade may be inside a footprint or cliff; the lattice is finer than any of them.
    if (w <= .001 || hard[base] | hard[base + 1] | hard[base + GRID] | hard[base + GRID + 1]) continue;
    const roll = hash(index * .013 + ix * 3.7, iz * 5.3 + index * .007);
    if (roll >= w) continue;
    const x = x0 + u * GRASS_CELL, z = z0 + v * GRASS_CELL, trail = segments.length ? onTrail(segments, x, z) : 1;
    if (roll >= w * trail) continue;
    if (towns.some(town => Math.abs(x - town.x) < 18 && Math.abs(z - town.z) < 18 && isTownPaved(x - town.x, z - town.z))) continue;
    const y = height(x, z), c = nearestClump(x, z), spread = Math.min(1, c.distance / .95);
    const r1 = hash(x * 1.7 + 3.1, z * 2.3), r2 = hash(z * 3.1, x * .9 - 1.7), r3 = hash(x - z * 5.1, z + x * .3);
    const direction = Math.atan2(z - c.z, x - c.x) + (r1 - .5) * 1.2;
    // Lawn thins toward trails and woodland fringe; its blades shorten with it instead of ending in a hard line.
    const tall = (.19 + r3 * .13) * (.78 + c.id * .44) * (.8 + valueNoise(x * .09, z * .09) * .4) * (.62 + .38 * Math.min(w, trail));
    values.push(x, y, z, Math.round(lerpLattice(forest, base, tx, tz) * GRASS_FOREST_STEPS));
    pushShape(shapes, direction, .14 + spread * .4 + r2 * .16, tall, (r2 - .5) * .6, c.id * .55 + valueNoise(x * .05 + 17, z * .05 - 9) * .45);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const lawn = layer(values, shapes, minY, maxY), tall = buildTallLayer(field, lattice, ix, iz, x0, z0, height);
  const empty: GrassLayer = { count: 0, minY: tall?.minY ?? 0, maxY: tall?.maxY ?? 0, offsets: new Float32Array(), shapes: new Float32Array() };
  const cell = lawn || tall ? { ...(lawn ?? empty), key, ix, iz, x: x0 + GRASS_CELL / 2, z: z0 + GRASS_CELL / 2, tall } : null;
  field.cells.set(key, cell);
  if (field.cells.size > CACHE_LIMIT) field.cells.delete(field.cells.keys().next().value!);
  return cell;
}

/** Blades one layer may draw under a budget: a prefix of its uniformly ordered list. */
export const grassCellCapacity = (cell: GrassLayer, budget: GrassBudget, density = GRASS_DENSITY) => Math.min(cell.count, Math.ceil(cell.count * budget.density / density));

/** gaesup's SFE distance weight, reused for the analytic budget check. */
export function grassLodWeight(distance: number, budget: GrassBudget): number {
  return distance <= budget.near ? 1 : distance >= budget.far ? 0 : (1 - (distance - budget.near) / (budget.far - budget.near)) ** Math.max(1, budget.strength);
}

/** Uniform scale keeping every drawn cell's LOD share while the total fits the blade budget. */
export function grassBudgetScale(requested: number, budget: GrassBudget): number {
  return requested > budget.maxBlades ? budget.maxBlades / requested : 1;
}
