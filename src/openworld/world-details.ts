import type { WorldAtlas } from './atlas';
import type { KantoLocation } from './kanto';
import type { WorldSample } from './types';
import type { SceneryAssetId, SceneryPlacement } from './scenery';
import { terrainSurfaceHeight } from './grounding';
import { THEME_BY_REGION, buildExplorationSites, type ExplorationTheme } from './exploration-sites';
import { scenerySeed, townPavingCells } from './town-style';
import { WORLD_SCALE } from './world-space';

/**
 * Visual-only town and roadside dressing. Placement is derived once per atlas from
 * the same sampler used by movement, but nothing here feeds collision, traversal,
 * spawning or simulation random state.
 */
export type DetailKind = 'grass-clump' | 'flower-patch' | 'pebbles' | 'route-post';
export const DETAIL_KINDS: readonly DetailKind[] = ['grass-clump', 'flower-patch', 'pebbles', 'route-post'];

export type TownPropKind = 'curb' | 'lamp' | 'bench' | 'planter' | 'mailbox' | 'pillar' | 'fountain' | 'statue' | 'tree-bed' | 'flower-bed';
/** Town-local coordinates relative to the town group origin. */
export type TownProp = { kind: TownPropKind; x: number; z: number; rotationY: number };
export type TownLayout = { id: string; theme: ExplorationTheme; props: TownProp[] };

export type WorldDetails = {
  /** Imported GLB kinds that already exist in the nature set (one draw call per kind). */
  framing: Partial<Record<SceneryAssetId, SceneryPlacement[]>>;
  /** Procedural low-poly kinds rendered as one instanced draw call each. */
  ground: Record<DetailKind, SceneryPlacement[]>;
  towns: ReadonlyMap<string, TownLayout>;
};

export const PAVING_CELL = 1.12 * WORLD_SCALE;
const MAX_TRAIL_HALF_WIDTH = 2.05 * WORLD_SCALE;
/** Clearance used for solid-looking props: arrival core, road corridor and building footprints. */
export const TOWN_ARRIVAL_CORE = 7.5;
export const SOLID_PATH_CLEARANCE = 3.25 * WORLD_SCALE;
const BUILDING_HALF_X = 1.6 * WORLD_SCALE, BUILDING_HALF_Z = 1.3 * WORLD_SCALE;
const SIGNBOARD = { x: 0, z: -6 * WORLD_SCALE };
const TOWN_SLOTS = [[-5, -4], [5, -4], [-5, 4], [5, 4], [-6, 0], [6, 0], [0, -6], [0, 6]].map(([x, z]) => [x * WORLD_SCALE, z * WORLD_SCALE] as const);

/** Visible road half-width. TrailAndWater and the verge share it so grass never covers the road. */
export function trailHalfWidth(fromId: string, toId: string): number {
  return (1.45 + (scenerySeed(`${fromId}:${toId}`) % 5) * .15) * WORLD_SCALE;
}

/** Stable visual noise. Mirrors scenery.ts and never touches simulation RNG. */
export function detailNoise(x: number, z: number, salt: number): number {
  const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

const TREE_BY_THEME: Record<ExplorationTheme, readonly SceneryAssetId[]> = {
  classic: ['tree-round', 'tree-oak'], heritage: ['tree-oak', 'tree-round', 'tree-pine'], volcanic: ['tree-round', 'tree-fat'],
  alpine: ['tree-pine', 'tree-thin'], metro: ['tree-thin', 'tree-round'], garden: ['tree-round', 'tree-thin'],
  island: ['tree-fat', 'tree-round'], rail: ['tree-oak', 'tree-thin'], frontier: ['tree-pine', 'tree-oak'], mosaic: ['tree-round', 'tree-oak'],
};
const RING_BY_THEME: Record<ExplorationTheme, 'fence' | 'hedge' | 'mixed'> = {
  classic: 'mixed', heritage: 'fence', volcanic: 'hedge', alpine: 'fence', metro: 'hedge',
  garden: 'hedge', island: 'hedge', rail: 'mixed', frontier: 'fence', mosaic: 'mixed',
};
const FEATURE_BY_THEME: Record<ExplorationTheme, readonly TownPropKind[]> = {
  classic: ['statue', 'fountain', 'tree-bed'], heritage: ['tree-bed', 'statue', 'fountain'], volcanic: ['fountain', 'tree-bed', 'statue'],
  alpine: ['statue', 'tree-bed', 'fountain'], metro: ['fountain', 'statue', 'tree-bed'], garden: ['fountain', 'tree-bed', 'statue'],
  island: ['tree-bed', 'fountain', 'statue'], rail: ['statue', 'fountain', 'tree-bed'], frontier: ['tree-bed', 'statue', 'fountain'],
  mosaic: ['fountain', 'statue', 'tree-bed'],
};

type Road = { other: KantoLocation; dx: number; dz: number; halfWidth: number };
type Context = {
  atlas: WorldAtlas; sample: (x: number, z: number) => WorldSample; theme: ExplorationTheme;
  gates: ReadonlyArray<{ x: number; z: number }>; sites: ReadonlyArray<{ x: number; z: number }>;
  trees: ReadonlyMap<string, ReadonlyArray<{ x: number; z: number }>>;
  paved: ReadonlyArray<{ x: number; z: number }>;
};

/** Roads may pass other towns; their plazas stay free of roadside dressing. */
function onPaving(context: Context, x: number, z: number): boolean {
  for (const town of context.paved) if (Math.abs(town.x - x) < 18 && Math.abs(town.z - z) < 18 && isTownPaved(x - town.x, z - town.z)) return true;
  return false;
}

const emptyGround = (): Record<DetailKind, SceneryPlacement[]> => ({ 'grass-clump': [], 'flower-patch': [], pebbles: [], 'route-post': [] });

function push(target: Partial<Record<SceneryAssetId, SceneryPlacement[]>>, id: SceneryAssetId, placement: SceneryPlacement) {
  (target[id] ??= []).push(placement);
}

function placement(context: Context, x: number, z: number, salt: number, minScale: number, maxScale: number, rotationY?: number): SceneryPlacement {
  return { x, y: terrainSurfaceHeight(context.sample, x, z), z, rotationY: rotationY ?? detailNoise(x, z, salt) * Math.PI * 2,
    scale: minScale + detailNoise(x, z, salt + 1) * (maxScale - minScale) };
}

function nearTree(context: Context, x: number, z: number, radius: number): boolean {
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
  for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
    for (const tree of context.trees.get(`${ix}:${iz}`) ?? []) if (Math.hypot(tree.x - x, tree.z - z) < radius) return true;
  }
  return false;
}

function nearAny(points: ReadonlyArray<{ x: number; z: number }>, x: number, z: number, radius: number): boolean {
  for (const point of points) if (Math.abs(point.x - x) < radius && Math.abs(point.z - z) < radius && Math.hypot(point.x - x, point.z - z) < radius) return true;
  return false;
}

function townRoads(atlas: WorldAtlas, town: KantoLocation, byId: ReadonlyMap<string, KantoLocation>): Road[] {
  return atlas.surfaceConnections.flatMap(([fromId, toId]) => {
    const otherId = fromId === town.id ? toId : toId === town.id ? fromId : undefined;
    const other = otherId ? byId.get(otherId) : undefined;
    if (!other || other.kind === 'sea') return [];
    const length = Math.hypot(other.x - town.x, other.z - town.z) || 1;
    return [{ other, dx: (other.x - town.x) / length, dz: (other.z - town.z) / length, halfWidth: trailHalfWidth(fromId, toId) }];
  });
}

/** First blocked radius, measured along directions that do not follow a road. */
function walkableTownRadius(context: Context, town: KantoLocation): number {
  const found: number[] = [];
  for (let step = 0; step < 16; step++) {
    const angle = (step + .5) / 16 * Math.PI * 2, cos = Math.cos(angle), sin = Math.sin(angle);
    for (let radius = 14; radius <= 20; radius += .25) {
      if (context.sample(town.x + cos * radius, town.z + sin * radius).blocked) { found.push(radius); break; }
    }
  }
  found.sort((a, b) => a - b);
  return found.length ? found[Math.floor(found.length / 2)] : 8 * WORLD_SCALE;
}

/** True when a town-local point lies on one of the fixed paving cells. */
export function isTownPaved(x: number, z: number): boolean {
  return Math.hypot(Math.round(x / PAVING_CELL), Math.round(z / PAVING_CELL)) <= 7.1;
}

function layoutTown(context: Context, town: KantoLocation, roads: Road[], framing: WorldDetails['framing'], ground: WorldDetails['ground']): TownLayout {
  const { atlas, sample, theme } = context, seed = scenerySeed(town.id), props: TownProp[] = [];
  const buildings = atlas.buildingOffsets(town);
  const world = (x: number, z: number) => ({ x: town.x + x, z: town.z + z });
  const edge = walkableTownRadius(context, town), ring = edge + 1.1;
  const pathDistance = (x: number, z: number) => atlas.distanceToPath(town.x + x, town.z + z);
  const clearOfBuildings = (x: number, z: number, margin: number) => buildings.every(([bx, bz]) =>
    Math.abs(x - bx) > BUILDING_HALF_X + margin || Math.abs(z - bz) > BUILDING_HALF_Z + margin);
  const solid = (x: number, z: number, clearance = 0) => Math.hypot(x, z) >= TOWN_ARRIVAL_CORE + clearance
    && Math.hypot(x, z) <= edge - .7 && pathDistance(x, z) >= SOLID_PATH_CLEARANCE + .1 + clearance
    && clearOfBuildings(x, z, 1 + clearance) && Math.hypot(x - SIGNBOARD.x, z - SIGNBOARD.z) >= 2.6 + clearance
    && !nearAny(context.sites, town.x + x, town.z + z, 3 + clearance);
  const onRoad = (x: number, z: number, margin: number) => roads.some(road => {
    const along = x * road.dx + z * road.dz;
    return along > -road.halfWidth && Math.abs(-x * road.dz + z * road.dx) < road.halfWidth + margin;
  });
  const blockedGround = (x: number, z: number) => { const point = sample(town.x + x, town.z + z); return point.blocked && point.biome !== 'lake'; };
  // Unused building slots become a plaza feature and small gardens.
  const lots = TOWN_SLOTS.filter(([x, z]) => !buildings.some(([bx, bz]) => Math.abs(bx - x) < .01 && Math.abs(bz - z) < .01))
    .filter(([x, z]) => Math.hypot(x - SIGNBOARD.x, z - SIGNBOARD.z) > 5 && pathDistance(x, z) >= SOLID_PATH_CLEARANCE + .5
      && clearOfBuildings(x, z, 2.8) && !nearAny(context.sites, town.x + x, town.z + z, 5))
    .sort((a, b) => detailNoise(a[0], a[1], seed % 97) - detailNoise(b[0], b[1], seed % 97)).slice(0, 3);
  const lamps: TownProp[] = [];
  const addLamp = (x: number, z: number, towardX: number, towardZ: number) => {
    if (lamps.length >= 8 || !solid(x, z) || lamps.some(lamp => Math.hypot(lamp.x - x, lamp.z - z) < 5)
      || lots.some(([lx, lz]) => Math.hypot(lx - x, lz - z) < 3.4)) return;
    lamps.push({ kind: 'lamp', x, z, rotationY: Math.atan2(towardX, towardZ) });
  };

  // Stair-step curb along the exposed edge of the unchanged paving footprint.
  const cells = new Set(townPavingCells(town.id).map(([x, z]) => `${x}:${z}`));
  for (const key of cells) {
    const [cx, cz] = key.split(':').map(Number);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (cells.has(`${cx + dx}:${cz + dz}`)) continue;
      const x = (cx + dx * .5) * PAVING_CELL, z = (cz + dz * .5) * PAVING_CELL;
      if (onRoad(x, z, .7)) continue;
      props.push({ kind: 'curb', x, z, rotationY: dx ? Math.PI / 2 : 0 });
    }
  }

  // Road-lined lamps just outside the logical corridor, then plaza corners.
  for (const road of roads) for (const along of [9.6, 13.8]) for (const side of [-1, 1]) {
    const lateral = Math.max(SOLID_PATH_CLEARANCE + .8, road.halfWidth + 2.6);
    addLamp(road.dx * along - road.dz * side * lateral, road.dz * along + road.dx * side * lateral, road.dz * side, -road.dx * side);
  }
  for (let corner = 0; corner < 4; corner++) {
    const angle = Math.PI / 4 + corner * Math.PI / 2 + (seed % 7) * .04;
    addLamp(Math.cos(angle) * 10.4, Math.sin(angle) * 10.4, -Math.cos(angle), -Math.sin(angle));
  }
  props.push(...lamps);

  // Gateway pillars frame each road where it crosses the town boundary.
  for (const road of roads) for (const side of [-1, 1]) {
    const lateral = Math.max(SOLID_PATH_CLEARANCE + .6, road.halfWidth + 2.8);
    const x = road.dx * ring - road.dz * side * lateral, z = road.dz * ring + road.dx * side * lateral;
    if (blockedGround(x, z) && pathDistance(x, z) >= SOLID_PATH_CLEARANCE + .3) props.push({ kind: 'pillar', x, z, rotationY: Math.atan2(road.dx, road.dz) });
  }

  // Doorstep planters sit inside the blocked footprint in front of each door (+z).
  buildings.forEach(([bx, bz], index) => {
    const house = town.id === 'pallet' && index < 2;
    props.push({ kind: 'planter', x: bx + 2.25, z: bz + 3.05, rotationY: 0 });
    props.push(house ? { kind: 'mailbox', x: bx - 2.6, z: bz + 3.15, rotationY: 0 } : { kind: 'planter', x: bx - 2.25, z: bz + 3.05, rotationY: 0 });
  });

  const features = FEATURE_BY_THEME[theme], trees = TREE_BY_THEME[theme];
  lots.forEach(([x, z], index) => {
    // Tall features keep their whole footprint outside the road corridor.
    const roomy = pathDistance(x, z) >= SOLID_PATH_CLEARANCE + 2;
    const preferred = index === 0 ? features[seed % features.length] : index === 1 ? 'tree-bed' : 'flower-bed';
    const kind: TownPropKind = roomy || preferred === 'tree-bed' || preferred === 'flower-bed' ? preferred : 'flower-bed';
    props.push({ kind, x, z, rotationY: Math.atan2(-x, -z) });
    if (kind === 'tree-bed') {
      const point = world(x, z);
      push(framing, trees[(seed + index) % trees.length], placement(context, point.x, point.z, 61 + index, .66, .78));
    }
    // Benches look at the feature from the town-center side.
    const facing = Math.atan2(-x, -z);
    for (const turn of index === 0 ? [-.8, .8] : [(seed + index) % 2 ? .9 : -.9]) {
      const angle = facing + turn, bx = x + Math.sin(angle) * 3, bz = z + Math.cos(angle) * 3;
      if (solid(bx, bz, -.4)) props.push({ kind: 'bench', x: bx, z: bz, rotationY: angle + Math.PI });
    }
    for (let flower = 0; flower < (kind === 'flower-bed' || kind === 'tree-bed' ? 5 : 3); flower++) {
      const angle = flower / 5 * Math.PI * 2 + detailNoise(x, z, 70 + flower) * .6, radius = kind === 'fountain' ? 2.35 : kind === 'statue' ? 1.75 : .75;
      const point = world(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
      ground['flower-patch'].push(placement(context, point.x, point.z, 80 + flower, .7, .95));
    }
  });

  // Boundary ring: fence, hedge or both on blocked ground. Roads leave natural gateways.
  const style = seed % 4 === 3 ? (RING_BY_THEME[theme] === 'hedge' ? 'mixed' : 'hedge') : RING_BY_THEME[theme];
  const spacing = style === 'hedge' ? 1.55 : 3.3, count = Math.max(8, Math.round(Math.PI * 2 * ring / spacing));
  for (let index = 0; index < count; index++) {
    const angle = (index + .5) / count * Math.PI * 2, cos = Math.cos(angle), sin = Math.sin(angle);
    const x = cos * ring, z = sin * ring, point = world(x, z);
    if (!blockedGround(x, z) || pathDistance(x, z) < SOLID_PATH_CLEARANCE + .6 || nearAny(context.gates, point.x, point.z, 6)) continue;
    const tangent = -Math.atan2(cos, -sin);
    if (style === 'hedge' || (style === 'mixed' && index % 3 === 0)) {
      push(framing, 'bush', placement(context, point.x, point.z, 90, style === 'hedge' ? .78 : .7, style === 'hedge' ? .96 : .82));
    } else {
      const ends = [-1, 1].every(end => blockedGround(x - sin * end * 1.6, z + cos * end * 1.6));
      if (ends) push(framing, 'fence', { ...placement(context, point.x, point.z, 91, 1, 1, tangent), scale: 1 });
    }
  }

  // Grass and flowers soften the paving edge; they are flat and may sit on walkable ground.
  const inner = Math.min(edge, 16.2), outer = ring + .9, clumps = Math.round(Math.PI * 2 * ring / 1.35);
  for (let index = 0; index < clumps; index++) {
    const angle = (index + detailNoise(index, seed % 101, 3) * .8) / clumps * Math.PI * 2;
    const radius = inner + detailNoise(index, seed % 89, 4) * (outer - inner), x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
    if (isTownPaved(x, z) || onRoad(x, z, .5) || pathDistance(x, z) < 4.6) continue;
    const point = world(x, z), terrain = sample(point.x, point.z);
    if (terrain.biome === 'lake' || onPaving(context, point.x, point.z) || nearAny(context.gates, point.x, point.z, 4)) continue;
    ground[detailNoise(x, z, 5) < .7 ? 'grass-clump' : 'flower-patch'].push(placement(context, point.x, point.z, 6, .8, 1.25));
  }

  // A loose tree line behind the boundary where the surrounding land is forest.
  const treeCount = Math.round(Math.PI * 2 * (ring + 4) / 7.5);
  for (let index = 0; index < treeCount; index++) {
    const angle = (index + detailNoise(index, seed % 53, 7) * .7) / treeCount * Math.PI * 2;
    const radius = ring + 2.6 + detailNoise(index, seed % 59, 8) * 3.4, x = Math.cos(angle) * radius, z = Math.sin(angle) * radius, point = world(x, z);
    const terrain = sample(point.x, point.z);
    if (!terrain.blocked || terrain.biome === 'lake' || pathDistance(x, z) < 9 || nearTree(context, point.x, point.z, 4.6)
      || nearAny(context.gates, point.x, point.z, 7) || detailNoise(x, z, 9) < .25) continue;
    if (terrain.biome === 'forest') push(framing, trees[(index + seed) % trees.length], placement(context, point.x, point.z, 10, .7, .95));
    else if (terrain.biome === 'rock') push(framing, detailNoise(x, z, 11) < .5 ? 'moss-boulder' : 'rock-flat', placement(context, point.x, point.z, 12, .7, 1.05));
  }
  return { id: town.id, theme, props };
}

function dressRoute(context: Context, from: KantoLocation, to: KantoLocation, halfWidth: number, townRadius: (location: KantoLocation) => number, framing: WorldDetails['framing'], ground: WorldDetails['ground']) {
  const { atlas, sample } = context;
  const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
  if (length < 6) return;
  const ux = dx / length, uz = dz / length, px = -uz, pz = ux;
  const start = from.kind === 'town' ? townRadius(from) + 2.2 : 2, end = length - (to.kind === 'town' ? townRadius(to) + 2.2 : 2);
  const salt = scenerySeed(`${from.id}:${to.id}`) % 997;
  // Flat verge between the visible trail edge and the logical corridor edge.
  for (let along = start; along <= end; along += 2.3) for (const side of [-1, 1]) {
    const t = along + (detailNoise(along, side, salt) - .5) * 1.4;
    const lateral = Math.min(SOLID_PATH_CLEARANCE - .5, halfWidth + .45 + detailNoise(t, side, salt + 1) * 1.5);
    const x = from.x + ux * t + px * lateral * side, z = from.z + uz * t + pz * lateral * side;
    const terrain = sample(x, z);
    // Another road passing closer than this one would put the tuft on its surface.
    const nearest = atlas.distanceToPath(x, z);
    if (terrain.biome === 'lake' || onPaving(context, x, z) || (nearest < lateral - .05 && nearest < MAX_TRAIL_HALF_WIDTH + .2)
      || nearAny(context.sites, x, z, 2.6) || nearAny(context.gates, x, z, 4)) continue;
    const selector = detailNoise(x, z, salt + 2);
    if (selector < .52) ground['grass-clump'].push(placement(context, x, z, 20, .75, 1.3));
    else if (selector < .72) ground['flower-patch'].push(placement(context, x, z, 21, .7, 1.1));
    else if (selector < .86) ground.pebbles.push(placement(context, x, z, 22, .7, 1.2));
  }
  // Blocked shoulder just outside the corridor: shrubs in woodland, stones on rock.
  for (let along = start + 1.5; along <= end; along += 4.4) for (const side of [-1, 1]) {
    const t = along + (detailNoise(along, side, salt + 3) - .5) * 2;
    const lateral = SOLID_PATH_CLEARANCE + .9 + detailNoise(t, side, salt + 4) * .8;
    const x = from.x + ux * t + px * lateral * side, z = from.z + uz * t + pz * lateral * side;
    const terrain = sample(x, z);
    if (!terrain.blocked || terrain.biome === 'lake' || onPaving(context, x, z) || atlas.distanceToPath(x, z) < SOLID_PATH_CLEARANCE + .4
      || nearAny(context.sites, x, z, 4) || nearAny(context.gates, x, z, 6)) continue;
    const selector = detailNoise(x, z, salt + 5);
    if (terrain.biome === 'rock') {
      if (selector < .45) ground.pebbles.push(placement(context, x, z, 30, 1, 1.6));
      else if (selector < .62) push(framing, 'rock-flat', placement(context, x, z, 31, .6, .9));
    } else if (selector < .58) push(framing, 'bush', placement(context, x, z, 32, .7, 1));
    else if (selector < .8) ground['grass-clump'].push(placement(context, x, z, 33, 1, 1.45));
  }
  // One small marker post where a road leaves each town.
  for (const [town, sign] of [[from, 1], [to, -1]] as const) {
    if (town.kind !== 'town') continue;
    const t = sign > 0 ? townRadius(town) + 4.5 : length - townRadius(town) - 4.5;
    if (t < 0 || t > length) continue;
    const side = salt % 2 ? 1 : -1, lateral = SOLID_PATH_CLEARANCE + .9;
    const x = from.x + ux * t + px * lateral * side, z = from.z + uz * t + pz * lateral * side, terrain = sample(x, z);
    if (!terrain.blocked || terrain.biome === 'lake' || nearAny(context.sites, x, z, 3) || nearAny(context.gates, x, z, 6)) continue;
    ground['route-post'].push(placement(context, x, z, 40, 1, 1, Math.atan2(-px * side, -pz * side)));
  }
}

function build(sample: (x: number, z: number) => WorldSample, atlas: WorldAtlas, baseTrees: ReadonlyArray<{ x: number; z: number }>, skipTown: (id: string) => boolean): WorldDetails {
  const framing: WorldDetails['framing'] = {}, ground = emptyGround(), towns = new Map<string, TownLayout>();
  const byId = new Map(atlas.locations.map(item => [item.id, item]));
  const trees = new Map<string, Array<{ x: number; z: number }>>();
  for (const tree of baseTrees) {
    const key = `${Math.floor(tree.x / 16)}:${Math.floor(tree.z / 16)}`;
    let list = trees.get(key); if (!list) trees.set(key, list = []); list.push(tree);
  }
  const gates = atlas.gates.flatMap(gate => {
    if (gate.position) return [gate.position];
    const from = byId.get(gate.from), to = byId.get(gate.to);
    return from && to ? [{ x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 }] : [];
  });
  const sites = buildExplorationSites(atlas, sample, 99);
  const paved = atlas.locations.filter(item => item.kind === 'town' && !skipTown(item.id));
  const context: Context = { atlas, sample, theme: THEME_BY_REGION[atlas.id], gates, sites, trees, paved };
  const radii = new Map<string, number>();
  const townRadius = (town: KantoLocation) => {
    let radius = radii.get(town.id);
    if (radius === undefined) radii.set(town.id, radius = walkableTownRadius(context, town) + 1.1);
    return radius;
  };
  for (const town of atlas.locations) {
    if (town.kind !== 'town' || skipTown(town.id)) continue;
    towns.set(town.id, layoutTown(context, town, townRoads(atlas, town, byId), framing, ground));
  }
  for (const [fromId, toId] of atlas.surfaceConnections) {
    const from = byId.get(fromId), to = byId.get(toId);
    if (!from || !to || from.kind === 'sea' || to.kind === 'sea') continue;
    dressRoute(context, from, to, trailHalfWidth(fromId, toId), location => skipTown(location.id) ? 2 : townRadius(location), framing, ground);
  }
  return { framing, ground, towns };
}

const cache = new WeakMap<(x: number, z: number) => WorldSample, Map<string, WorldDetails>>();
/** Deterministic and cached per sampler/atlas; the view only filters the result by distance. */
export function createWorldDetails(sample: (x: number, z: number) => WorldSample, atlas: WorldAtlas,
  baseTrees: ReadonlyArray<{ x: number; z: number }> = [], skipTown: (id: string) => boolean = () => false): WorldDetails {
  let byAtlas = cache.get(sample);
  if (!byAtlas) cache.set(sample, byAtlas = new Map());
  let details = byAtlas.get(atlas.mapVersion);
  if (!details) byAtlas.set(atlas.mapVersion, details = build(sample, atlas, baseTrees, skipTown));
  return details;
}
