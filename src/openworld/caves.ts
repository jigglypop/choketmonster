import type { WorldSample } from './types';
import { KANTO_LOCATIONS, sampleKantoWorld, type KantoLocation } from './kanto';
import { JOHTO_LOCATIONS, sampleJohtoWorld } from './johto';
import { scaleWorldDistance, surfaceSceneId, type ScenePoint } from './world-space';
import { caveRelief, caveFloorHeight, type CaveRelief } from './cave-relief';
import { DUNGEON_PLANS, dungeonEntryFloor, dungeonFloorAsciiLabel, dungeonFloorSceneLocalId, type DungeonKind, type DungeonPlan, type DungeonSilhouette, type DungeonStyle } from './dungeons';
import { roomBlocked, roomLayout, type DungeonRoom } from './dungeon-rooms';
import { regionalRuntimePools } from '../data/regional-encounters';
import { expansionEncounterPools, type ExpansionRegion } from '../data/expansion-encounters';
import { HOENN_LOCATIONS, sampleHoennWorld } from './hoenn';
import { SINNOH_LOCATIONS, sampleSinnohWorld } from './sinnoh';
import { UNOVA_LOCATIONS, sampleUnovaWorld } from './unova';
import { KALOS_LOCATIONS, sampleKalosWorld } from './kalos';
import { ALOLA_LOCATIONS, sampleAlolaWorld } from './alola';
import { GALAR_LOCATIONS, sampleGalarWorld } from './galar';
import { HISUI_LOCATIONS, sampleHisuiWorld } from './hisui';
import { PALDEA_LOCATIONS, samplePaldeaWorld } from './paldea';

export type CaveRegionId = string;
export type CaveSilhouette = DungeonSilhouette | 'room';
export type CaveWallSegment = ScenePoint & { width: number; depth: number; height: number; rotationY: number };
/** A way out to the surface. */
export type CavePortal = {
  id: string;
  surfaceLocationId: string;
  surfaceSceneId: string;
  surface: ScenePoint;
  surfaceArrival: ScenePoint;
  interior: ScenePoint;
  interiorArrival: ScenePoint;
  /** Building drawn beside a tower, building or plant door on the surface; its front faces the door. */
  landmark?: ScenePoint & { rotationY: number };
};
/** Stairs or a ladder to a neighbouring floor. */
export type CaveStairs = {
  id: string;
  direction: 'up' | 'down';
  targetSceneId: string;
  targetStairsId: string;
  targetLabel: string;
  interior: ScenePoint;
  interiorArrival: ScenePoint;
};
export type CaveScene = {
  /** Scene id suffix; the floor behind the first entrance keeps the dungeon id. */
  id: string;
  sceneId: string;
  regionId: CaveRegionId;
  kind: DungeonKind;
  style: DungeonStyle;
  dungeonId: string;
  dungeonName: string;
  dungeonLabel: string;
  /** Dungeon name with the floor label when the dungeon has several floors. */
  name: string;
  /** Stable ASCII text for portal labels even when localized fonts are unavailable. */
  label: string;
  floorIndex: number;
  floorCount: number;
  floorLabel: string;
  /** Height order: 1F = 0, B1F = -1. */
  level: number;
  encounterLocationId: string;
  minLevel: number;
  maxLevel: number;
  /** Deeper floors raise wild levels by this much. */
  levelShift: number;
  encounters: readonly number[];
  /** Source encounter areas for this floor; undefined means the whole location table. */
  encounterAreas?: readonly string[];
  /** Wild Pokémon live on this floor. */
  wild: boolean;
  /** This floor holds the location's rare supplemental and legendary spawns. */
  supplemental: boolean;
  /** Legendary Pokémon waiting on this floor, one at a time, until each is caught. */
  legendary?: readonly number[];
  width: number;
  depth: number;
  legacyWidth: number;
  legacyDepth: number;
  tileSize: number;
  silhouette: CaveSilhouette;
  outline: readonly ScenePoint[];
  portals: readonly CavePortal[];
  stairs: readonly CaveStairs[];
  wallSegments: readonly CaveWallSegment[];
  relief: CaveRelief;
  /** Rectangular rooms of towers, buildings and plants. */
  room?: DungeonRoom;
  sample: (x: number, z: number) => WorldSample;
};

type RegionData = { locations: readonly KantoLocation[]; sample: (x: number, z: number) => WorldSample };
const REGIONS: Record<string, RegionData> = {
  kanto: { locations: KANTO_LOCATIONS, sample: sampleKantoWorld },
  johto: { locations: JOHTO_LOCATIONS, sample: sampleJohtoWorld },
  hoenn: { locations: HOENN_LOCATIONS, sample: sampleHoennWorld },
  sinnoh: { locations: SINNOH_LOCATIONS, sample: sampleSinnohWorld },
  unova: { locations: UNOVA_LOCATIONS, sample: sampleUnovaWorld },
  kalos: { locations: KALOS_LOCATIONS, sample: sampleKalosWorld },
  alola: { locations: ALOLA_LOCATIONS, sample: sampleAlolaWorld },
  galar: { locations: GALAR_LOCATIONS, sample: sampleGalarWorld },
  hisui: { locations: HISUI_LOCATIONS, sample: sampleHisuiWorld },
  paldea: { locations: PALDEA_LOCATIONS, sample: samplePaldeaWorld },
};

const TILE_SIZE = 2, ARRIVAL_STEP = TILE_SIZE * 1.4, ROOM_LINK_INSET = 3.2;
const SILHOUETTES: readonly DungeonSilhouette[] = ['rounded', 'oval', 'long', 'hall', 'bend'];
const pointForTile = (width: number, depth: number, x: number, z: number): ScenePoint => ({ x: (x - (width - 1) / 2) * TILE_SIZE, z: (z - (depth - 1) / 2) * TILE_SIZE });
const variation = (seed: number, salt: number) => { const n = Math.sin(seed * 127.1 + salt * 311.7) * 43758.5453; return n - Math.floor(n); };

function silhouetteBonus(kind: DungeonSilhouette, angle: number, phase: number): number {
  if (kind === 'rounded') return 3.6 + .6 * Math.sin(angle * 3 + phase);
  if (kind === 'oval') return 4 + .9 * Math.cos(angle * 2 + phase);
  if (kind === 'long') return 3.2 + 1.2 * Math.abs(Math.cos(angle + phase * .15));
  if (kind === 'hall') return 4.5 + .9 * Math.cos(angle * 4 + phase);
  return 4.3 + 1.1 * Math.sin(angle + phase) + .2 * Math.sin(angle * 3 - phase);
}

function caveOutline(kind: DungeonSilhouette, seed: number, width: number, depth: number): ScenePoint[] {
  const points: ScenePoint[] = [], phase = seed * .071, halfWidth = width / 2, halfDepth = depth / 2;
  for (let index = 0; index < 48; index++) {
    const angle = index / 48 * Math.PI * 2, cosine = Math.cos(angle), sine = Math.sin(angle);
    // A rounded superellipse preserves the legacy walkable footprint while
    // avoiding the straight, box-like runs produced by a rectangle ray cast.
    const exponent = kind === 'hall' ? 2.75 : kind === 'long' ? 2.55 : 2.35;
    const roundedRadius = 1 / Math.pow(
      Math.pow(Math.abs(cosine) / halfWidth, exponent) + Math.pow(Math.abs(sine) / halfDepth, exponent),
      1 / exponent,
    );
    const legacyEnvelope = Math.min(halfWidth / Math.max(Math.abs(cosine), 1e-6), halfDepth / Math.max(Math.abs(sine), 1e-6));
    const erosion = .55 * Math.sin(angle * 5 + phase * 1.9) + .28 * Math.sin(angle * 9 - phase);
    // Retain every coordinate accepted by older rectangular caves. Blending
    // the envelope, rather than tracing it directly, rounds their long sides.
    const radius = roundedRadius * .28 + legacyEnvelope * .72 + silhouetteBonus(kind, angle, phase) + erosion;
    points.push({ x: cosine * radius, z: sine * radius });
  }
  return points;
}

function distanceToSegment(x: number, z: number, a: ScenePoint, b: ScenePoint): number {
  const dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
}

export function caveContains(outline: readonly ScenePoint[], x: number, z: number, clearance = 0): boolean {
  let inside = false, edgeDistance = Infinity;
  for (let index = 0, previous = outline.length - 1; index < outline.length; previous = index++) {
    const a = outline[previous], b = outline[index];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
    edgeDistance = Math.min(edgeDistance, distanceToSegment(x, z, a, b));
  }
  return inside && edgeDistance >= clearance;
}

/** Wild tables exist for this floor's areas. */
function floorHasWild(regionId: string, locationId: string, areas: readonly string[] | undefined): boolean {
  if (areas && !areas.length) return false;
  if (regionId === 'kanto' || regionId === 'johto') return regionalRuntimePools(regionId, locationId, 'day', 'rock', areas).length > 0;
  return expansionEncounterPools(regionId as ExpansionRegion, locationId, 'walk').some(pool => !areas || areas.includes(pool.areaName));
}

/**
 * A tower or building stands just outside its location's clearing, its door on the clearing's edge.
 * Searching the real surface sampler keeps the whole footprint on ground the partner cannot walk.
 */
function doorway(region: RegionData, center: ScenePoint, seed: number): { door: ScenePoint; arrival: ScenePoint; landmark: ScenePoint & { rotationY: number } } | undefined {
  const towns = region.locations.filter(item => item.kind === 'town'), start = seed % 16;
  for (let radius = 5; radius <= 26; radius++) for (let step = 0; step < 16; step++) {
    const angle = (start + step) / 16 * Math.PI * 2, dx = Math.cos(angle), dz = Math.sin(angle);
    const door = { x: center.x + dx * radius, z: center.z + dz * radius };
    if (region.sample(door.x, door.z).blocked || !region.sample(door.x + dx * 1.4, door.z + dz * 1.4).blocked) continue;
    let open = true;
    for (let t = 0; t < radius && open; t += .75) open = !region.sample(center.x + dx * t, center.z + dz * t).blocked;
    const body = { x: door.x + dx * 4.4, z: door.z + dz * 4.4 };
    if (!open || towns.some(town => Math.hypot(town.x - body.x, town.z - body.z) < scaleWorldDistance(11))) continue;
    let solid = region.sample(body.x, body.z).blocked;
    for (let k = 0; k < 12 && solid; k++) { const a = k / 12 * Math.PI * 2; solid = region.sample(body.x + Math.cos(a) * 3.3, body.z + Math.sin(a) * 3.3).blocked; }
    if (!solid) continue;
    return { door, arrival: { x: door.x - dx * 3, z: door.z - dz * 3 }, landmark: { ...body, rotationY: Math.atan2(-dx, -dz) } };
  }
  return undefined;
}

type SurfaceEnd = Omit<CavePortal, 'interior' | 'interiorArrival'>;
function surfaceEnd(plan: DungeonPlan, region: RegionData, exactLocation: KantoLocation | undefined, locationId: string, index: number, reach = scaleWorldDistance(2.2)): SurfaceEnd {
  const surfaceLocation = region.locations.find(item => item.id === locationId);
  if (!surfaceLocation) throw new Error(`Unknown dungeon portal location: ${plan.regionId}:${locationId}`);
  const common = { id: `${plan.id}:${index}`, surfaceLocationId: locationId, surfaceSceneId: surfaceSceneId(plan.regionId) };
  if (plan.kind === 'cave' && !plan.legacy && exactLocation) {
    // Entrances sit on the roads out toward each neighbour; a dead-end cave opens at its clearing.
    const dx = surfaceLocation.x - exactLocation.x, dz = surfaceLocation.z - exactLocation.z, length = Math.hypot(dx, dz);
    if (length > 12) {
      const at = (distance: number) => ({ x: exactLocation.x + dx / length * distance, z: exactLocation.z + dz / length * distance });
      return { ...common, surface: at(reach), surfaceArrival: at(reach + scaleWorldDistance(3)) };
    }
    for (let step = 0; step < 16; step++) {
      const angle = step / 16 * Math.PI * 2, arrival = { x: exactLocation.x + Math.cos(angle) * 6, z: exactLocation.z + Math.sin(angle) * 6 };
      if ([.25, .5, .75, 1].every(t => !region.sample(exactLocation.x + (arrival.x - exactLocation.x) * t, exactLocation.z + (arrival.z - exactLocation.z) * t).blocked))
        return { ...common, surface: { x: exactLocation.x, z: exactLocation.z }, surfaceArrival: arrival };
    }
  }
  if (plan.kind === 'cave') {
    const direction = index === 0 ? -1 : 1;
    const surface = exactLocation && plan.surfaceLocations.length > 1
      ? { x: exactLocation.x + direction * scaleWorldDistance(2.2), z: exactLocation.z }
      : { x: surfaceLocation.x, z: surfaceLocation.z };
    return { ...common, surface, surfaceArrival: { x: surface.x + direction * scaleWorldDistance(3), z: surface.z } };
  }
  const door = doorway(region, surfaceLocation, plan.seed);
  if (door) return { ...common, surface: door.door, surfaceArrival: door.arrival, landmark: door.landmark };
  return { ...common, surface: { x: surfaceLocation.x, z: surfaceLocation.z }, surfaceArrival: { x: surfaceLocation.x + scaleWorldDistance(3), z: surfaceLocation.z } };
}

type Link = { surface: number } | { stairs: number };

/** Floor each surface entrance opens onto: a through dungeon runs from its first floor to its last. */
const surfaceFloors = (plan: DungeonPlan): readonly number[] => plan.surfaceFloors
  ?? (plan.surfaceLocations.length > 1 ? [0, plan.floors.length - 1] : [dungeonEntryFloor(plan)]);

/** Doorways on one floor: the one leading back toward the entrance first, then the far exit, then onward stairs. */
function floorLinks(plan: DungeonPlan, index: number): Link[] {
  const count = plan.floors.length, entry = dungeonEntryFloor(plan), links: Link[] = [];
  if (index === entry) links.push({ surface: 0 });
  else links.push({ stairs: index < entry ? index + 1 : index - 1 });
  surfaceFloors(plan).forEach((floor, surface) => { if (surface > 0 && floor === index) links.push({ surface }); });
  if (index <= entry && index > 0) links.push({ stairs: index - 1 });
  if (index >= entry && index < count - 1) links.push({ stairs: index + 1 });
  return links;
}

function buildDungeon(plan: DungeonPlan): CaveScene[] {
  const region = REGIONS[plan.regionId];
  if (!region) throw new Error(`Unknown dungeon region: ${plan.regionId}`);
  const exactLocation = region.locations.find(item => item.id === plan.id);
  const baseEncounter = exactLocation ?? region.locations.find(item => item.id === plan.surfaceLocations[0]);
  if (!baseEncounter) throw new Error(`Unknown cave encounter location: ${plan.regionId}:${plan.id}`);
  const count = plan.floors.length, entry = dungeonEntryFloor(plan);
  if (surfaceFloors(plan).length !== plan.surfaceLocations.length) throw new Error(`${plan.id}: every entrance needs a floor`);
  const localIds = plan.floors.map((_, index) => dungeonFloorSceneLocalId(plan, index));
  const sceneIds = localIds.map(id => `cave:${plan.regionId}:${id}`);
  const encounterFor = (index: number) => {
    const id = plan.floors[index].locationId; if (!id) return baseEncounter;
    const found = region.locations.find(item => item.id === id); if (!found) throw new Error(`Unknown floor encounter location: ${plan.regionId}:${id}`);
    return found;
  };
  const wild = plan.floors.map((floor, index) => floorHasWild(plan.regionId, encounterFor(index).id, floor.areas));
  const anchor = plan.anchor ?? wild.lastIndexOf(true);
  if (plan.legendary?.length && !wild[anchor]) throw new Error(`${plan.regionId}:${plan.id}: the legendary floor needs a wild table`);
  // Roads that leave a cave at a narrow angle move both entrances farther out so they never overlap.
  let ends = plan.surfaceLocations.map((locationId, index) => surfaceEnd(plan, region, exactLocation, locationId, index));
  for (let reach = scaleWorldDistance(2.2); ends.length === 2 && Math.hypot(ends[0].surface.x - ends[1].surface.x, ends[0].surface.z - ends[1].surface.z) < 8 && reach < 24; reach += .5)
    ends = plan.surfaceLocations.map((locationId, index) => surfaceEnd(plan, region, exactLocation, locationId, index, reach));
  const farthest = Math.max(entry, count - 1 - entry);
  return plan.floors.map((floor, index): CaveScene => {
    const legacy = plan.kind === 'cave' && plan.legacy && index === entry;
    const seed = legacy ? plan.seed : plan.seed + index * 101;
    const mirrored = !legacy && variation(seed, 3) < .5;
    const links = floorLinks(plan, index);
    const encounter = encounterFor(index);
    let width: number, depth: number, legacyWidth: number, legacyDepth: number, silhouette: CaveSilhouette, outline: ScenePoint[];
    let points: ScenePoint[], relief: CaveRelief, wallSegments: CaveWallSegment[], room: DungeonRoom | undefined, sample: (x: number, z: number) => WorldSample;
    if (plan.kind === 'cave') {
      const tilesWide = legacy ? plan.width : Math.max(15, Math.round(plan.width * (.8 + variation(seed, 1) * .4))) | 1;
      const tilesDeep = legacy ? plan.depth : Math.max(13, Math.round(plan.depth * (.8 + variation(seed, 2) * .4))) | 1;
      silhouette = legacy ? plan.silhouette ?? 'rounded' : SILHOUETTES[(SILHOUETTES.indexOf(plan.silhouette ?? 'rounded') + index) % SILHOUETTES.length];
      legacyWidth = tilesWide * TILE_SIZE; legacyDepth = tilesDeep * TILE_SIZE;
      outline = caveOutline(silhouette, seed, legacyWidth, legacyDepth);
      width = Math.ceil(Math.max(...outline.map(point => Math.abs(point.x))) * 2);
      depth = Math.ceil(Math.max(...outline.map(point => Math.abs(point.z))) * 2);
      relief = caveRelief(plan.id, seed, legacyWidth, legacyDepth);
      // Corner tiles stay inside every silhouette; the outer tile ring is the chamber boundary.
      const corners = [[1, 1], [tilesWide - 2, tilesDeep - 2], [tilesWide - 2, 1], [1, tilesDeep - 2]] as const;
      points = links.map((_, slot) => {
        const [x, z] = corners[slot];
        let point = pointForTile(tilesWide, tilesDeep, mirrored ? tilesWide - 1 - x : x, z);
        // A rounded silhouette can shave a corner tile; step it in until it and its landing are on open ground.
        for (let guard = 0; guard < 24 && [point, { x: point.x * (1 - ARRIVAL_STEP / Math.hypot(point.x, point.z)), z: point.z * (1 - ARRIVAL_STEP / Math.hypot(point.x, point.z)) }].some(item => !caveContains(outline, item.x, item.z, 2.8)); guard++)
          point = { x: point.x * .95, z: point.z * .95 };
        return point;
      });
      wallSegments = outline.map((point, wallIndex) => {
        const next = outline[(wallIndex + 1) % outline.length], dx = next.x - point.x, dz = next.z - point.z;
        return { x: (point.x + next.x) / 2, z: (point.z + next.z) / 2, width: Math.hypot(dx, dz), depth: TILE_SIZE, height: 3.4, rotationY: Math.atan2(-dz, dx) };
      });
      const chamber = outline;
      sample = (x, z) => {
        if (![x, z].every(Number.isFinite)) return { height: 0, biome: 'rock', blocked: true };
        return { height: caveFloorHeight(relief, x, z), exactHeight: true, biome: 'rock', blocked: !caveContains(chamber, x, z, 2.8) };
      };
    } else {
      // Pagoda floors narrow toward the top.
      const taper = (plan.style === 'pagoda' || plan.style === 'bell') && count > 1 ? 1 - .18 * index / (count - 1) : 1;
      const halfWidth = Math.round(plan.width * TILE_SIZE * taper) / 2, halfDepth = Math.round(plan.depth * TILE_SIZE * taper) / 2;
      width = legacyWidth = halfWidth * 2; depth = legacyDepth = halfDepth * 2; silhouette = 'room';
      outline = [{ x: -halfWidth, z: -halfDepth }, { x: halfWidth, z: -halfDepth }, { x: halfWidth, z: halfDepth }, { x: -halfWidth, z: halfDepth }];
      relief = caveRelief(plan.id, seed, width, depth, true);
      const inX = halfWidth - ROOM_LINK_INSET, inZ = halfDepth - ROOM_LINK_INSET;
      const corners = [[-inX, -inZ], [inX, inZ], [inX, -inZ], [-inX, inZ]] as const;
      points = links.map((_, slot) => { const [x, z] = corners[slot]; return { x: mirrored ? -x : x, z }; });
      const clearings = points.flatMap(point => [point, { x: point.x * (1 - ARRIVAL_STEP / Math.hypot(point.x, point.z)), z: point.z * (1 - ARRIVAL_STEP / Math.hypot(point.x, point.z)) }]);
      const layout = roomLayout(plan.style, seed, halfWidth, halfDepth, clearings, index, count);
      room = layout;
      wallSegments = [
        { x: 0, z: -halfDepth, width: halfWidth * 2, depth: TILE_SIZE / 2, height: 4.2, rotationY: 0 },
        { x: halfWidth, z: 0, width: halfDepth * 2, depth: TILE_SIZE / 2, height: 4.2, rotationY: Math.PI / 2 },
        { x: 0, z: halfDepth, width: halfWidth * 2, depth: TILE_SIZE / 2, height: 4.2, rotationY: 0 },
        { x: -halfWidth, z: 0, width: halfDepth * 2, depth: TILE_SIZE / 2, height: 4.2, rotationY: Math.PI / 2 },
        ...layout.props.filter(prop => prop.blocking).map(prop => ({ x: prop.x, z: prop.z, width: prop.width, depth: prop.depth, height: prop.height, rotationY: 0 })),
      ];
      sample = (x, z) => ({ height: 0, exactHeight: true, biome: 'rock', blocked: ![x, z].every(Number.isFinite) || roomBlocked(layout, x, z) });
    }
    const arrival = (point: ScenePoint): ScenePoint => {
      const length = Math.hypot(point.x, point.z) || 1;
      return { x: point.x - point.x / length * ARRIVAL_STEP, z: point.z - point.z / length * ARRIVAL_STEP };
    };
    const portals: CavePortal[] = [], stairs: CaveStairs[] = [];
    links.forEach((link, slot) => {
      const interior = points[slot], interiorArrival = arrival(interior);
      if ('surface' in link) portals.push({ ...ends[link.surface], interior, interiorArrival });
      else stairs.push({ id: `${localIds[index]}>${localIds[link.stairs]}`, direction: plan.floors[link.stairs].level > floor.level ? 'up' : 'down',
        targetSceneId: sceneIds[link.stairs], targetStairsId: `${localIds[link.stairs]}>${localIds[index]}`, targetLabel: plan.floors[link.stairs].label, interior, interiorArrival });
    });
    const distance = Math.abs(index - entry);
    return {
      id: localIds[index], sceneId: sceneIds[index], regionId: plan.regionId, kind: plan.kind, style: plan.style,
      dungeonId: plan.id, dungeonName: plan.name, dungeonLabel: plan.label, name: count > 1 ? `${plan.name} ${floor.label}` : plan.name,
      label: count > 1 ? `${plan.label} ${dungeonFloorAsciiLabel(floor.key)}` : plan.label,
      floorIndex: index, floorCount: count, floorLabel: floor.label, level: floor.level,
      encounterLocationId: encounter.id, minLevel: plan.levels?.[0] ?? encounter.minLevel, maxLevel: plan.levels?.[1] ?? encounter.maxLevel,
      levelShift: farthest <= 4 ? distance : Math.round(distance * 4 / farthest), encounters: encounter.encounters,
      ...(floor.areas ? { encounterAreas: floor.areas } : {}), wild: wild[index], supplemental: index === anchor && wild[index],
      ...(index === anchor && plan.legendary?.length ? { legendary: plan.legendary } : {}),
      width, depth, legacyWidth, legacyDepth, tileSize: TILE_SIZE, silhouette, outline, portals, stairs, wallSegments, relief, ...(room ? { room } : {}), sample,
    };
  });
}

export const CAVE_SCENES: readonly CaveScene[] = DUNGEON_PLANS.flatMap(buildDungeon);
const byScene = new Map(CAVE_SCENES.map(scene => [scene.sceneId, scene]));
const byDungeon = new Map<string, CaveScene[]>();
for (const scene of CAVE_SCENES) { const key = `${scene.regionId}:${scene.dungeonId}`; byDungeon.set(key, [...byDungeon.get(key) ?? [], scene]); }

export const getCaveScene = (sceneId: string): CaveScene | undefined => byScene.get(sceneId);
/** Every floor of the dungeon a scene belongs to, in walking order. */
export const dungeonFloors = (scene: Pick<CaveScene, 'regionId' | 'dungeonId'>): readonly CaveScene[] => byDungeon.get(`${scene.regionId}:${scene.dungeonId}`) ?? [];
/** Every surface exit of the dungeon, with the floor it opens from. */
export const dungeonExits = (scene: Pick<CaveScene, 'regionId' | 'dungeonId'>): Array<{ scene: CaveScene; portal: CavePortal }> =>
  dungeonFloors(scene).flatMap(floor => floor.portals.map(portal => ({ scene: floor, portal })));
/** Stairs on `from` that lead one floor closer to `to`. */
export function stairsToward(from: CaveScene, to: CaveScene): CaveStairs | undefined {
  if (from.dungeonId !== to.dungeonId || from.regionId !== to.regionId || from.floorIndex === to.floorIndex) return undefined;
  const next = dungeonFloors(from)[from.floorIndex + Math.sign(to.floorIndex - from.floorIndex)];
  return next ? from.stairs.find(stairs => stairs.targetSceneId === next.sceneId) : undefined;
}
/** A surface entrance of the region by portal id, with the floor it opens onto. */
export const dungeonEntrance = (regionId: string, portalId: string): { scene: CaveScene; portal: CavePortal } | undefined => {
  for (const scene of CAVE_SCENES) if (scene.regionId === regionId) for (const portal of scene.portals) if (portal.id === portalId) return { scene, portal };
  return undefined;
};
const landmarkLocations = new Set(CAVE_SCENES.flatMap(scene => scene.portals.filter(portal => portal.landmark).map(portal => `${scene.regionId}:${portal.surfaceLocationId}`)));
/** A tower, building or plant stands at this surface location, so the generic landmark and cave arch give way. */
export const hasDungeonLandmark = (regionId: string, locationId: string): boolean => landmarkLocations.has(`${regionId}:${locationId}`);
export const caveSceneForRegionLocation =(regionId: string, locationId: string): CaveScene | undefined =>
  CAVE_SCENES.find(scene => scene.regionId === regionId && (scene.id === locationId || scene.portals.some(portal => portal.surfaceLocationId === locationId)));
export const cavePortalAtSurface = (regionId: string, x: number, z: number, radius = scaleWorldDistance(1.8)): { scene: CaveScene; portal: CavePortal } | undefined => {
  for (const scene of CAVE_SCENES) if (scene.regionId === regionId) for (const portal of scene.portals) if (Math.hypot(x - portal.surface.x, z - portal.surface.z) <= radius) return { scene, portal };
  return undefined;
};
export const cavePortalAtInterior = (sceneId: string, x: number, z: number, radius = 1.35): CavePortal | undefined =>
  getCaveScene(sceneId)?.portals.find(portal => Math.hypot(x - portal.interior.x, z - portal.interior.z) <= radius);
export const caveStairsAt = (sceneId: string, x: number, z: number, radius = 1.35): CaveStairs | undefined =>
  getCaveScene(sceneId)?.stairs.find(stairs => Math.hypot(x - stairs.interior.x, z - stairs.interior.z) <= radius);
export function nearestCaveWalkable(sceneId: string, x: number, z: number): ScenePoint | undefined {
  const scene = getCaveScene(sceneId); if (!scene || ![x, z].every(Number.isFinite)) return undefined;
  if (!scene.sample(x, z).blocked) return { x, z };
  for (let radius = .5; radius <= Math.max(scene.width, scene.depth); radius += .5) for (let step = 0; step < 32; step++) {
    const angle = step / 32 * Math.PI * 2, point = { x: x + Math.cos(angle) * radius, z: z + Math.sin(angle) * radius };
    if (!scene.sample(point.x, point.z).blocked) return point;
  }
  return scene.portals[0]?.interiorArrival ?? scene.stairs[0]?.interiorArrival;
}

export const caveLocation = (sceneId: string): KantoLocation | undefined => {
  const scene = getCaveScene(sceneId); if (!scene) return undefined;
  return { id: scene.encounterLocationId, name: scene.name, x: 0, z: 0, kind: scene.kind === 'cave' ? 'cave' : 'special', minLevel: scene.minLevel, maxLevel: scene.maxLevel, encounters: scene.encounters, requiredBadges: 0 };
};
