import type { ParkSide, ParkStyle } from './dungeons';
import type { SceneryAssetId } from './scenery';
import type { WorldSample } from './types';
import type { ScenePoint } from './world-space';

/**
 * Open-air park zones: a meadow inside a hedge and tree line, with ponds, paths between the gates, and
 * trees, bushes and boulders to walk around. Pure data: the simulation samples it and the view draws it.
 */
export type ParkGate = {
  side: ParkSide; angle: number;
  /** Doorway point just inside the rim, where stepping walks through the gate. */
  interior: ScenePoint;
  /** Where the arch stands, in the gap of the hedge line, so the doorway lies just inside it. */
  frame: ScenePoint;
  /** Where the path meets the walkable rim. */
  rim: ScenePoint;
  /** The path runs on into the woods to here. */
  exit: ScenePoint;
  /** Local +x runs along the rim, local +z faces into the meadow. */
  rotationY: number;
};
export type ParkNode = ScenePoint & { id: string; kind: 'gate' | 'exit' | 'hub' | 'bend' | 'spur' };
/** A wobbling ellipse of water; `level` is its surface, `depth` how far the basin drops below it. */
export type ParkPond = ScenePoint & { radiusX: number; radiusZ: number; angle: number; phase: number; level: number; depth: number };
export type ParkObstacle = ScenePoint & { radius: number; biome: 'forest' | 'rock' };
/** A shared nature model. Tier 1 fills the outer rim woods, which phones may draw only nearby. */
export type ParkPlant = ScenePoint & { asset: SceneryAssetId; scale: number; rotationY: number; tier: 0 | 1 };
export type ParkLayout = {
  id: string; style: ParkStyle; seed: number;
  /** Superellipse half-axes of the meadow before its rim wobbles. */
  halfX: number; halfZ: number;
  wobble: ReadonlyArray<readonly [amplitude: number, frequency: number, phase: number]>;
  /** Footprint holding the whole meadow and the hedge; beyond it everything is woods. */
  width: number; depth: number;
  /** In link order: the way back first. */
  gates: readonly ParkGate[];
  nodes: readonly ParkNode[];
  paths: ReadonlyArray<readonly [string, string]>;
  ponds: readonly ParkPond[];
  fountain?: ScenePoint & { radius: number };
  /** Everything that stops walking inside the meadow: trees, bushes, boulders, gate posts and the fountain. */
  obstacles: readonly ParkObstacle[];
  plants: readonly ParkPlant[];
  /** The walkable edge as a closed polyline. */
  rim: readonly ScenePoint[];
  /** Rim radius at RIM_STEPS + 1 even angles from +x, for sampling without the superellipse. */
  rimTable: Float32Array;
  buckets: ReadonlyMap<number, readonly ParkObstacle[]>;
};

const TAU = Math.PI * 2;
const RIM_EXPONENT = 3.2;
/** Doorways lie this far inside the rim and the arch just inside it, its posts this far to either side. */
export const PARK_GATE_INSET = 1.6, PARK_GATE_FRAME = .3, PARK_GATE_POST = 2.3;
/** The hedge runs this far outside the walkable rim; the rim woods stand in two rows beyond it. */
export const PARK_HEDGE_OFFSET = 1.6;
const WOOD_ROWS = [{ gap: 4.4, spacing: 5.2, tier: 0 }, { gap: 9.6, spacing: 6.6, tier: 1 }] as const;
/** Ground height the woods level off at, so the far ground meets a flat horizon. */
export const PARK_WOODS_HEIGHT = .7;
const POND_LEVEL = -.34, POND_DEPTH = .72;
const BUCKET = 6, RIM_STEPS = 1024, HEIGHT_MARGIN = 24;
const SIDE_ANGLE: Record<ParkSide, number> = { east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 };
const TREES: Record<ParkStyle, readonly SceneryAssetId[]> = { safari: ['tree-round', 'tree-fat', 'tree-thin', 'tree-round'], garden: ['tree-oak', 'tree-round', 'tree-pine', 'tree-oak'] };
const FLOWERS: readonly SceneryAssetId[] = ['flower-yellow', 'flower-red', 'flower-purple'];

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => { state = state + 0x6d2b79f5 >>> 0; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
const bucketKey = (ix: number, iz: number) => (ix + 1024) * 2048 + iz + 1024;

type Rim = Pick<ParkLayout, 'halfX' | 'halfZ' | 'wobble'>;
/** Distance from the centre to the walkable rim along `angle`. */
export function parkRimRadius(layout: Rim, angle: number): number {
  let wobble = 1;
  for (const [amplitude, frequency, phase] of layout.wobble) wobble += amplitude * Math.sin(angle * frequency + phase);
  const x = Math.abs(Math.cos(angle)) / layout.halfX, z = Math.abs(Math.sin(angle)) / layout.halfZ;
  return wobble / Math.pow(Math.pow(x, RIM_EXPONENT) + Math.pow(z, RIM_EXPONENT), 1 / RIM_EXPONENT);
}
/** Metres inside the rim along the ray from the centre; negative in the woods. */
export function parkRimGap(layout: Rim, x: number, z: number): number {
  const distance = Math.hypot(x, z);
  return parkRimRadius(layout, distance < 1e-6 ? 0 : Math.atan2(z, x)) - distance;
}

/** Below 1 inside the pond's water. */
export function parkPondRatio(pond: ParkPond, x: number, z: number): number {
  const dx = x - pond.x, dz = z - pond.z, cos = Math.cos(pond.angle), sin = Math.sin(pond.angle);
  const u = (dx * cos + dz * sin) / pond.radiusX, v = (dz * cos - dx * sin) / pond.radiusZ, ratio = Math.hypot(u, v);
  if (ratio > 2.2) return ratio;
  const angle = Math.atan2(v, u);
  return ratio / (1 + .09 * Math.sin(angle * 3 + pond.phase) + .05 * Math.sin(angle * 5 - pond.phase * 1.7));
}
/** The pond's shoreline, `grow` metres out, as a closed polyline. */
export function parkPondShore(pond: ParkPond, grow = 0, count = 48): ScenePoint[] {
  const cos = Math.cos(pond.angle), sin = Math.sin(pond.angle);
  return Array.from({ length: count }, (_, index) => {
    const angle = index / count * TAU, reach = 1 + .09 * Math.sin(angle * 3 + pond.phase) + .05 * Math.sin(angle * 5 - pond.phase * 1.7);
    const u = Math.cos(angle) * (reach * pond.radiusX + grow), v = Math.sin(angle) * (reach * pond.radiusZ + grow);
    return { x: pond.x + u * cos - v * sin, z: pond.z + u * sin + v * cos };
  });
}

/** Authored ground at a 1 m lattice vertex: a gentle roll, pond basins, and woods rising to a level floor. */
export function parkVertexHeight(layout: Pick<ParkLayout, 'halfX' | 'halfZ' | 'wobble' | 'seed' | 'ponds'>, x: number, z: number): number {
  const phase = layout.seed * .37;
  let height = .15 * Math.sin(x * .063 + phase) * Math.cos(z * .057 - phase * .6) + .08 * Math.sin((x - z) * .12 + phase * 1.4);
  const gap = parkRimGap(layout, x, z);
  if (gap < 0) height += (PARK_WOODS_HEIGHT - height) * smooth(-gap / 16);
  for (const pond of layout.ponds) {
    const ratio = parkPondRatio(pond, x, z), shore = pond.level + .03;
    if (ratio < 1) height = shore - (pond.depth + .03) * smooth((1 - ratio) / .45);
    else if (ratio < 1.7) height = shore + (height - shore) * smooth((ratio - 1) / .7);
  }
  return height;
}

type HeightLattice = { x0: number; z0: number; columns: number; rows: number; values: Float32Array };
const lattices = new WeakMap<ParkLayout, HeightLattice>();
/** Lattice height, filled lazily and kept at float32 like the mesh's vertex buffer. */
export function parkLatticeHeight(layout: ParkLayout, ix: number, iz: number): number {
  let lattice = lattices.get(layout);
  if (!lattice) {
    const x0 = -Math.ceil(layout.width / 2) - HEIGHT_MARGIN, z0 = -Math.ceil(layout.depth / 2) - HEIGHT_MARGIN, columns = 1 - x0 * 2, rows = 1 - z0 * 2;
    lattices.set(layout, lattice = { x0, z0, columns, rows, values: new Float32Array(columns * rows).fill(Number.NaN) });
  }
  const column = ix - lattice.x0, row = iz - lattice.z0;
  if (column < 0 || row < 0 || column >= lattice.columns || row >= lattice.rows) return Math.fround(parkVertexHeight(layout, ix, iz));
  const index = row * lattice.columns + column;
  if (Number.isNaN(lattice.values[index])) lattice.values[index] = parkVertexHeight(layout, ix, iz);
  return lattice.values[index];
}

/** Height on the ground mesh triangle, with the same diagonal as the cave floors, so feet and grass meet the rendered ground. */
export function parkFloorHeight(layout: ParkLayout, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), tx = x - ix, tz = z - iz;
  const a = parkLatticeHeight(layout, ix, iz), b = parkLatticeHeight(layout, ix, iz + 1), d = parkLatticeHeight(layout, ix + 1, iz);
  return tx + tz <= 1 ? a * (1 - tx - tz) + b * tz + d * tx
    : b * (1 - tx) + parkLatticeHeight(layout, ix + 1, iz + 1) * (tx + tz - 1) + d * (1 - tz);
}

/** `parkRimGap` read from the layout's rim table. */
function rimGap(layout: ParkLayout, x: number, z: number): number {
  const distance = Math.hypot(x, z);
  let t = (Math.atan2(z, x) / TAU + 1) % 1 * RIM_STEPS;
  const index = Math.min(RIM_STEPS - 1, Math.floor(t)); t -= index;
  return layout.rimTable[index] * (1 - t) + layout.rimTable[index + 1] * t - distance;
}

function obstacleAt(layout: ParkLayout, x: number, z: number): ParkObstacle | undefined {
  const list = layout.buckets.get(bucketKey(Math.floor(x / BUCKET), Math.floor(z / BUCKET)));
  if (list) for (const item of list) if ((x - item.x) ** 2 + (z - item.z) ** 2 < item.radius * item.radius) return item;
  return undefined;
}

/** Meadow walks the grass tables, ponds are open water (surf tables) and the woods past the rim stop the partner. */
export function parkSample(layout: ParkLayout, x: number, z: number): WorldSample {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return { height: 0, biome: 'rock', blocked: true };
  const height = parkFloorHeight(layout, x, z);
  if (Math.abs(x) > layout.width / 2 || Math.abs(z) > layout.depth / 2 || rimGap(layout, x, z) < 0) return { height, exactHeight: true, biome: 'forest', blocked: true };
  for (const pond of layout.ponds) if (parkPondRatio(pond, x, z) < 1) return { height: Math.max(height, pond.level), exactHeight: true, biome: 'lake', blocked: false };
  const obstacle = obstacleAt(layout, x, z);
  if (obstacle) return { height, exactHeight: true, biome: obstacle.biome, blocked: true };
  return { height, exactHeight: true, biome: 'meadow', blocked: false };
}

function segmentDistance(x: number, z: number, a: ScenePoint, b: ScenePoint): number {
  const dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
}
const pathSegments = new WeakMap<object, ReadonlyArray<readonly [ScenePoint, ScenePoint]>>();
/** Metres to the nearest path centreline. */
export function parkPathDistance(layout: Pick<ParkLayout, 'nodes' | 'paths'>, x: number, z: number): number {
  let segments = pathSegments.get(layout);
  if (!segments) {
    const byId = new Map(layout.nodes.map(node => [node.id, node]));
    pathSegments.set(layout, segments = layout.paths.map(([from, to]) => [byId.get(from)!, byId.get(to)!] as const));
  }
  let nearest = Infinity;
  for (const [a, b] of segments) nearest = Math.min(nearest, segmentDistance(x, z, a, b));
  return nearest;
}

/**
 * One zone. Gates sit on their rim sides, paths join them through a hub, ponds and clumps of trees keep clear of
 * the paths, and two rows of woods close the view beyond the hedge. The same inputs always give the same park.
 */
export function parkLayout(id: string, style: ParkStyle, seed: number, halfX: number, halfZ: number, sides: readonly ParkSide[]): ParkLayout {
  const next = random(seed * 7919 + 13), garden = style === 'garden';
  const rim: Rim = { halfX, halfZ, wobble: [[.045, 3, next() * TAU], [.03, 5, next() * TAU], [.016, 9, next() * TAU]] };
  const outline = Array.from({ length: 144 }, (_, index) => { const angle = index / 144 * TAU, radius = parkRimRadius(rim, angle); return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius }; });
  const width = Math.ceil(Math.max(...outline.map(point => Math.abs(point.x))) + PARK_HEDGE_OFFSET + 4) * 2;
  const depth = Math.ceil(Math.max(...outline.map(point => Math.abs(point.z))) + PARK_HEDGE_OFFSET + 4) * 2;

  // Two gates on one side spread apart along it.
  const gates = sides.map((side, index): ParkGate => {
    const shared = sides.filter(item => item === side).length, order = sides.slice(0, index).filter(item => item === side).length;
    const angle = SIDE_ANGLE[side] + (shared > 1 ? (order - (shared - 1) / 2) * .5 : (next() - .5) * .24);
    const radius = parkRimRadius(rim, angle), dx = Math.cos(angle), dz = Math.sin(angle);
    const at = (reach: number) => ({ x: dx * reach, z: dz * reach });
    return { side, angle, interior: at(radius - PARK_GATE_INSET), frame: at(radius - PARK_GATE_FRAME), rim: at(radius), exit: at(radius + 15), rotationY: Math.atan2(-dx, -dz) };
  });
  const hub: ParkNode = { id: `${id}:hub`, kind: 'hub', x: (next() - .5) * (garden ? 4 : halfX * .3), z: (next() - .5) * (garden ? 4 : halfZ * .3) };
  const nodes: ParkNode[] = [hub], paths: Array<readonly [string, string]> = [];
  gates.forEach((gate, index) => {
    const gateId = `${id}:gate:${index}`, exitId = `${id}:exit:${index}`;
    nodes.push({ id: gateId, kind: 'gate', ...gate.interior }, { id: exitId, kind: 'exit', ...gate.exit });
    paths.push([exitId, gateId]);
    if (garden) { paths.push([gateId, hub.id]); return; }
    // Safari trails bend once between the gate and the hub.
    const dx = hub.x - gate.interior.x, dz = hub.z - gate.interior.z, length = Math.hypot(dx, dz) || 1;
    const swing = Math.max(-9, Math.min(9, (next() - .5) * .5 * length));
    const bend = { x: gate.interior.x + dx * .5 - dz / length * swing, z: gate.interior.z + dz * .5 + dx / length * swing };
    const bendId = `${id}:bend:${index}`;
    nodes.push({ id: bendId, kind: 'bend', ...(parkRimGap(rim, bend.x, bend.z) > 10 ? bend : { x: gate.interior.x + dx * .5, z: gate.interior.z + dz * .5 }) });
    paths.push([gateId, bendId], [bendId, hub.id]);
  });
  // Spurs: a garden's walks cross at the fountain toward every side; safari trails fork into open meadow.
  const spurAngles = garden
    ? (['north', 'east', 'south', 'west'] as const).filter(side => !sides.includes(side)).map(side => SIDE_ANGLE[side])
    : Array.from({ length: 1 + Math.floor(next() * 2) }, () => next() * TAU);
  const apart = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  spurAngles.forEach((angle, index) => {
    if (!garden && (gates.some(gate => apart(angle, gate.angle) < .9) || spurAngles.slice(0, index).some(other => apart(angle, other) < 1.2))) return;
    const reach = parkRimRadius(rim, angle) - (garden ? 7 : 12 + next() * 6), end = { x: Math.cos(angle) * reach, z: Math.sin(angle) * reach };
    if (Math.hypot(end.x - hub.x, end.z - hub.z) < 12) return;
    const spurId = `${id}:spur:${index}`;
    nodes.push({ id: spurId, kind: 'spur', ...end }); paths.push([hub.id, spurId]);
  });
  const layoutPaths = { nodes, paths };
  const pathDistance = (x: number, z: number) => parkPathDistance(layoutPaths, x, z);
  const gap = (x: number, z: number) => parkRimGap(rim, x, z);

  const fountain = garden ? { x: hub.x, z: hub.z, radius: 2.6 } : undefined;
  const ponds: ParkPond[] = [];
  const pondTarget = garden ? 2 : 1 + Math.floor(next() * 2.6);
  for (let attempt = 0; attempt < 500 && ponds.length < pondTarget; attempt++) {
    const angle = next() * TAU, reach = .22 + next() * .5, radius = parkRimRadius(rim, angle) * reach;
    const radiusX = garden ? 5 + next() * 3 : 5.5 + next() * 4.5, pond: ParkPond = {
      x: Math.cos(angle) * radius, z: Math.sin(angle) * radius, radiusX, radiusZ: radiusX * (.62 + next() * .3),
      angle: next() * Math.PI, phase: next() * TAU, level: POND_LEVEL, depth: POND_DEPTH,
    };
    const extent = pond.radiusX * 1.15;
    if (gap(pond.x, pond.z) < extent + 8 || pathDistance(pond.x, pond.z) < extent + 5.5 || Math.hypot(pond.x - hub.x, pond.z - hub.z) < extent + 10
      || gates.some(gate => Math.hypot(pond.x - gate.interior.x, pond.z - gate.interior.z) < extent + 12)
      || ponds.some(other => Math.hypot(pond.x - other.x, pond.z - other.z) < extent + other.radiusX * 1.15 + 7)) continue;
    ponds.push(pond);
  }

  const obstacles: ParkObstacle[] = [], plants: ParkPlant[] = [];
  const open = (x: number, z: number, radius: number, pathClear: number) => gap(x, z) > radius + 2.5 && pathDistance(x, z) > pathClear
    && ponds.every(pond => parkPondRatio(pond, x, z) > 1.3 + radius / pond.radiusZ) && gates.every(gate => Math.hypot(x - gate.interior.x, z - gate.interior.z) > 12)
    && Math.hypot(x - hub.x, z - hub.z) > (fountain ? 7.5 : 5) && obstacles.every(item => Math.hypot(x - item.x, z - item.z) > item.radius + radius + .8);
  const plant = (asset: SceneryAssetId, x: number, z: number, scale: number, tier: 0 | 1 = 0) => plants.push({ asset, x, z, scale, rotationY: next() * TAU, tier });
  const trees = TREES[style];
  // Clumps of trees stand out in the meadow, away from the trails.
  for (let clump = 0, attempt = 0; clump < (garden ? 5 : 4) && attempt < 300; attempt++) {
    const angle = next() * TAU, reach = parkRimRadius(rim, angle) * (.2 + next() * .62), center = { x: Math.cos(angle) * reach, z: Math.sin(angle) * reach };
    if (!open(center.x, center.z, 3.5, 9)) continue;
    clump++;
    const count = 1 + Math.floor(next() * (garden ? 3 : 4));
    for (let index = 0; index < count; index++) {
      const spread = index ? 2.4 + next() * 1.6 : 0, turn = next() * TAU, x = center.x + Math.cos(turn) * spread, z = center.z + Math.sin(turn) * spread;
      const scale = .9 + next() * .35, radius = 1.1 * scale;
      if (!open(x, z, radius, 7)) continue;
      obstacles.push({ x, z, radius, biome: 'forest' });
      plant(trees[Math.floor(next() * trees.length)], x, z, scale);
    }
  }
  if (garden) {
    // Walks are lined with trees at even steps.
    for (const [from, to] of paths) {
      const a = nodes.find(node => node.id === from)!, b = nodes.find(node => node.id === to)!;
      if (a.kind === 'exit' || b.kind === 'exit') continue;
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      for (let along = 9; along < length - 6; along += 9) for (const side of [-1, 1]) {
        const x = a.x + dx / length * along - dz / length * 6.8 * side, z = a.z + dz / length * along + dx / length * 6.8 * side;
        if (!open(x, z, 1.1, 5.8)) continue;
        obstacles.push({ x, z, radius: 1.1, biome: 'forest' });
        plant('tree-oak', x, z, 1);
      }
    }
  }
  for (let count = 0, attempt = 0; count < (garden ? 3 : 5) && attempt < 200; attempt++) {
    const angle = next() * TAU, reach = parkRimRadius(rim, angle) * (.15 + next() * .75), x = Math.cos(angle) * reach, z = Math.sin(angle) * reach;
    const scale = .7 + next() * .5, radius = 1.15 * scale;
    if (!open(x, z, radius, 6)) continue;
    count++; obstacles.push({ x, z, radius, biome: 'rock' });
    plant(next() < .5 ? 'rock-large' : 'rock-moss', x, z, scale);
  }
  for (let count = 0, attempt = 0; count < (garden ? 16 : 13) && attempt < 400; attempt++) {
    const angle = next() * TAU, reach = parkRimRadius(rim, angle) * (.1 + next() * .85), x = Math.cos(angle) * reach, z = Math.sin(angle) * reach;
    const scale = .85 + next() * .45, radius = .8 * scale;
    if (!open(x, z, radius, 5)) continue;
    count++; obstacles.push({ x, z, radius, biome: 'forest' });
    plant('bush', x, z, scale);
  }
  // Flowers never block: beds by the walks and around the fountain, wild patches on the savanna.
  for (let patch = 0, attempt = 0; patch < (garden ? 12 : 7) && attempt < 300; attempt++) {
    const around = fountain && patch < 5, angle = next() * TAU;
    const reach = around ? 6.2 + next() * 1.2 : parkRimRadius(rim, angle) * (.1 + next() * .8);
    const x = (around ? hub.x : 0) + Math.cos(angle) * reach, z = (around ? hub.z : 0) + Math.sin(angle) * reach;
    if (!around && !open(x, z, 1.4, 4.4)) continue;
    patch++;
    const flower = FLOWERS[Math.floor(next() * FLOWERS.length)];
    for (let index = 0; index < 3 + Math.floor(next() * 4); index++) plant(flower, x + (next() - .5) * 2.4, z + (next() - .5) * 2.4, .9 + next() * .4);
  }
  // Lily pads float by the pond shores.
  for (const pond of ponds) for (let index = 0; index < 4 + Math.floor(next() * 4); index++) {
    const angle = next() * TAU, reach = .55 + next() * .3, cos = Math.cos(pond.angle), sin = Math.sin(pond.angle);
    const u = Math.cos(angle) * pond.radiusX * reach, v = Math.sin(angle) * pond.radiusZ * reach;
    plant('lily', pond.x + u * cos - v * sin, pond.z + u * sin + v * cos, 1.4 + next() * .8);
  }
  gates.forEach(gate => {
    const along = { x: Math.cos(gate.rotationY), z: -Math.sin(gate.rotationY) };
    for (const side of [-1, 1]) obstacles.push({ x: gate.frame.x + along.x * PARK_GATE_POST * side, z: gate.frame.z + along.z * PARK_GATE_POST * side, radius: .3, biome: 'rock' });
  });
  if (fountain) obstacles.push({ ...fountain, biome: 'rock' });

  // Rim woods: two rows walked along the rim by arc length, leaving a corridor where each path runs out.
  for (const row of WOOD_ROWS) {
    let travelled = next() * row.spacing;
    for (let index = 0; index < 720; index++) {
      const angle = index / 720 * TAU, radius = parkRimRadius(rim, angle) + row.gap, step = radius * TAU / 720;
      travelled += step;
      if (travelled < row.spacing) continue;
      travelled = (next() - .5) * row.spacing * .35;
      const out = radius + (next() - .5) * 1.6, x = Math.cos(angle) * out, z = Math.sin(angle) * out;
      if (gates.some(gate => segmentDistance(x, z, gate.rim, { x: gate.exit.x * 1.4, z: gate.exit.z * 1.4 }) < (row.tier ? 5.2 : 4.4))) continue;
      plant(trees[Math.floor(next() * trees.length)], x, z, (row.tier ? 1.05 : .95) + next() * .35, row.tier);
    }
  }

  const buckets = new Map<number, ParkObstacle[]>();
  for (const item of obstacles) {
    for (let ix = Math.floor((item.x - item.radius) / BUCKET); ix <= Math.floor((item.x + item.radius) / BUCKET); ix++)
      for (let iz = Math.floor((item.z - item.radius) / BUCKET); iz <= Math.floor((item.z + item.radius) / BUCKET); iz++) {
        const key = bucketKey(ix, iz); let list = buckets.get(key);
        if (!list) buckets.set(key, list = []);
        list.push(item);
      }
  }
  const rimTable = Float32Array.from({ length: RIM_STEPS + 1 }, (_, index) => parkRimRadius(rim, index / RIM_STEPS * TAU));
  return { id, style, seed, ...rim, width, depth, gates, nodes, paths, ponds, ...(fountain ? { fountain } : {}), obstacles, plants, rim: outline, rimTable, buckets };
}
