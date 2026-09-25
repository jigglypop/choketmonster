import { expansionSpeciesHabitats } from '../data/expansion-spawns';
import { getSpecies } from '../data/pokemon';
import { regionalSpeciesHabitats } from '../data/regional-encounters';
import { getWorldAtlas, type WorldRegionId } from './atlas';
import { captureItemChances, fieldItemCatalog, HELD_TOOL_PICKUP_WEIGHTS, HELD_TOOL_SOURCE_FAMILIES, heldToolPickupWeight, type FieldItem } from './field-item-drops';
import { isPlayableWorldRegion } from './availability';
import { surfaceSceneId } from './world-space';
import { surfaceBadges } from './dungeon-gates';
import { getTechnicalMachine, type TechnicalMachine } from '../game/technical-machines';
import { TECHNICAL_MACHINE_LOCATIONS } from '../data/technical-machine-locations';

export type FieldItemLocation = { regionId: WorldRegionId; locationId: string; name: string; requiredBadges: number };
export type FieldItemSource = {
  item: FieldItem;
  captures: Array<{ speciesIds: number[]; speciesNames: string[]; chance: number; locations: FieldItemLocation[] }>;
  roadside: FieldItemLocation[];
};
/** A roadside item: a catalog field item, or a technical machine counted separately in the save. */
export type RoadsideItem = FieldItem | (TechnicalMachine & { kind: 'technical-machine' });
export type FieldItemPickup = RoadsideItem & { itemId: string; x: number; z: number; regionId: WorldRegionId; sceneId: string; locationId: string };
export type FieldItemPickupState = { remainingSeconds: number; collectedCount: number };
/** Mega-capable species on the player's team, 1..4 by how much their moves have been used. */
export type MegaStoneAffinity = Readonly<Record<number, number>>;

/** Roadside slots per region. */
export const FIELD_PICKUP_ACTIVE_LIMIT = 24;
/** Distinct spots beside each road location, so one route can hold several items. */
const ROADSIDE_SPOTS_PER_LOCATION = 3;
export const FIELD_PICKUP_RESPAWN_SECONDS = 10 * 60;
/** Older saves stored 30-minute timers; they load and are shortened to the current wait. */
const LEGACY_RESPAWN_SECONDS = 30 * 60;
/** Walking this close to a roadside item picks it up; roadside slots sit 2.6–3.8 from the road centre. */
export const FIELD_PICKUP_COLLECT_DISTANCE = 4;

const roadsideCache = new Map<string, ReadonlyArray<{ x: number; z: number }>>();
const regionOrder: readonly WorldRegionId[] = ['kanto','johto','hoenn','sinnoh','unova','kalos','alola','galar','hisui','paldea'];
const hash = (text: string): number => { let value = 2166136261; for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0; return value; };

function speciesLocations(speciesId: number): FieldItemLocation[] {
  const habitats = [...regionalSpeciesHabitats(speciesId), ...expansionSpeciesHabitats(speciesId)].filter(habitat => isPlayableWorldRegion(habitat.region));
  const rows = habitats.flatMap(habitat => habitat.locationIds.map(locationId => {
    const atlas = getWorldAtlas(habitat.region), location = atlas.locations.find(candidate => candidate.id === locationId);
    return location ? { regionId: habitat.region as WorldRegionId, locationId, name: location.name, requiredBadges: Math.max(habitat.requiredBadges, location.requiredBadges) } : undefined;
  })).filter((row): row is FieldItemLocation => !!row);
  return [...new Map(rows.map(row => [`${row.regionId}:${row.locationId}`, row])).values()]
    .sort((a, b) => regionOrder.indexOf(a.regionId) - regionOrder.indexOf(b.regionId) || a.requiredBadges - b.requiredBadges || a.locationId.localeCompare(b.locationId));
}

const sourceLocations = new Map<number, FieldItemLocation[]>();
const locationsFor = (id: number) => { if (!sourceLocations.has(id)) sourceLocations.set(id, speciesLocations(id)); return sourceLocations.get(id)!; };
function authoredRoadsideLocations(item: FieldItem): FieldItemLocation[] {
  const extraStoneSpecies: Partial<Record<WorldRegionId, readonly number[]>> = { galar: [6, 248, 376], hisui: [445, 448, 460], paldea: [6, 282, 445, 448, 460] };
  return regionOrder.filter(region => isPlayableWorldRegion(region) && (item.kind === 'held-tool' || extraStoneSpecies[region]?.includes(item.speciesId!))).flatMap(regionId => {
    const atlas = getWorldAtlas(regionId), candidates = atlas.locations.filter(place => ['route', 'forest', 'cave'].includes(place.kind)
      && roadsidePoint(regionId, place.id, 0)).sort((a, b) => a.requiredBadges - b.requiredBadges || hash(`${item.id}:${a.id}`) - hash(`${item.id}:${b.id}`));
    return candidates.slice(0, 2).map(place => ({ regionId, locationId: place.id, name: place.name, requiredBadges: place.requiredBadges }));
  });
}
const sources = new Map(fieldItemCatalog().map(item => {
  const speciesIds = item.kind === 'mega-stone' ? [item.speciesId!] : [...HELD_TOOL_SOURCE_FAMILIES[item.id]];
  const captures = speciesIds.map(speciesId => ({
    speciesIds: [speciesId], speciesNames: [getSpecies(speciesId).name],
    chance: captureItemChances(speciesId).find(candidate => candidate.id === item.id)?.chance ?? 0,
    locations: locationsFor(speciesId),
  })).filter(capture => capture.locations.length && capture.chance > 0);
  const locations = [...new Map(captures.flatMap(capture => capture.locations).map(location => [`${location.regionId}:${location.locationId}`, location])).values()];
  if (!locations.length) throw new Error(`Field item has no authored encounter location: ${item.id}`);
  const roadside = [...new Map([...locations.filter(location => roadsidePoint(location.regionId, location.locationId, 0)), ...authoredRoadsideLocations(item)]
    .map(place => [`${place.regionId}:${place.locationId}`, place])).values()];
  return [item.id, { item, captures, roadside } satisfies FieldItemSource] as const;
}));

export function getFieldItemSources(itemId: string): FieldItemSource | undefined {
  const source = sources.get(itemId); return source ? structuredClone(source) : undefined;
}
export function allFieldItemSources(): readonly FieldItemSource[] { return [...sources.values()].map(source => structuredClone(source)); }
/** What a place offers: catalog items, and the technical machines its version finds there. */
export type LocationItemSource = Omit<FieldItemSource, 'item'> & { item: RoadsideItem };
const locationSources = new Map<string, LocationItemSource[]>();
export function fieldItemsAtLocation(regionId: WorldRegionId, locationId: string): readonly LocationItemSource[] {
  const key = `${regionId}:${locationId}`;
  if (!locationSources.has(key)) {
    const here = (place: FieldItemLocation) => place.regionId === regionId && place.locationId === locationId;
    const place = getWorldAtlas(regionId).locations.find(item => item.id === locationId);
    const machines: LocationItemSource[] = place ? (machinesByRoadside(regionId).get(locationId) ?? []).map(machine => ({ item: { ...machine, kind: 'technical-machine' as const }, captures: [],
      roadside: [{ regionId, locationId, name: place.name, requiredBadges: place.requiredBadges }] })) : [];
    locationSources.set(key, [...[...sources.values()].map(source => ({ ...source,
      captures: source.captures.filter(capture => capture.locations.some(here)).map(capture => ({ ...capture, locations: capture.locations.filter(here) })),
      roadside: source.roadside.filter(here),
    })).filter(source => source.roadside.length || source.captures.length), ...machines]);
  }
  return locationSources.get(key)!;
}

function roadsidePoints(regionId: WorldRegionId, locationId: string, seed: number): ReadonlyArray<{ x: number; z: number }> {
  const key = `${regionId}:${locationId}:${seed}`, cached = roadsideCache.get(key); if (cached) return cached;
  const atlas = getWorldAtlas(regionId), location = atlas.locations.find(candidate => candidate.id === locationId)!;
  const links = atlas.surfaceConnections.filter(([a, b]) => a === locationId || b === locationId), points: Array<{ x: number; z: number }> = [];
  for (let n = 0; n < links.length && points.length < ROADSIDE_SPOTS_PER_LOCATION; n++) {
    const link = links[(seed + n) % links.length], otherId = link[0] === locationId ? link[1] : link[0];
    const other = atlas.locations.find(candidate => candidate.id === otherId)!;
    const dx = other.x - location.x, dz = other.z - location.z, length = Math.hypot(dx, dz) || 1;
    for (const t of [.18, .28, .08, .36]) for (const side of [1, -1]) for (const offset of [3.8, 3.2, 2.8]) {
      if (points.length >= ROADSIDE_SPOTS_PER_LOCATION) break;
      const point = { x: location.x + dx * t - dz / length * side * offset, z: location.z + dz * t + dx / length * side * offset };
      if (points.some(item => Math.hypot(item.x - point.x, item.z - point.z) < 5)) continue;
      if (!atlas.sample(point.x, point.z).blocked && atlas.locationAt(point.x, point.z).id === locationId && atlas.distanceToPath(point.x, point.z) >= 2.6) points.push(point);
    }
  }
  if (roadsideCache.size > 4096) roadsideCache.clear();
  roadsideCache.set(key, points); return points;
}
function roadsidePoint(regionId: WorldRegionId, locationId: string, seed: number): { x: number; z: number } | undefined {
  return roadsidePoints(regionId, locationId, seed)[0];
}

type Point = { x: number; z: number };
type RoadsideSpot = { location: FieldItemLocation; point: Point };
type Candidate = RoadsideSpot & { item: RoadsideItem };
type RegionCandidates = { items: Candidate[]; spots: RoadsideSpot[]; owners: ReadonlyMap<Point, number> };
const pickupCandidates = new Map<string, RegionCandidates>();
const activePickupCache = new Map<string, FieldItemPickup[]>();
const roadsideLocations = (regionId: WorldRegionId): FieldItemLocation[] => getWorldAtlas(regionId).locations
  .filter(place => ['route', 'forest', 'cave'].includes(place.kind))
  .map(place => ({ regionId, locationId: place.id, name: place.name, requiredBadges: place.requiredBadges }));
/** Stronger machines wait for more badges wherever their place is. */
const MACHINE_BADGES: Readonly<Record<TechnicalMachine['tier'], number>> = { common: 0, uncommon: 2, rare: 4 };
const ROADSIDE_KINDS: ReadonlySet<string> = new Set(['route', 'forest', 'cave']);
const machineRoadsideCache = new Map<WorldRegionId, ReadonlyMap<string, readonly TechnicalMachine[]>>();
/**
 * Machines by roadside place: each machine lies where its version finds it. A town, site or sea route standing for a
 * shop, gym or gift passes its machines to the two nearest roads, forests or caves.
 */
function machinesByRoadside(regionId: WorldRegionId): ReadonlyMap<string, readonly TechnicalMachine[]> {
  const cached = machineRoadsideCache.get(regionId); if (cached) return cached;
  const atlas = getWorldAtlas(regionId), roadsides = atlas.locations.filter(place => ROADSIDE_KINDS.has(place.kind));
  const result = new Map<string, TechnicalMachine[]>();
  for (const [move, places] of Object.entries(TECHNICAL_MACHINE_LOCATIONS[regionId] ?? {})) {
    const machine = getTechnicalMachine(Number(move)); if (!machine) continue;
    const targets = new Set<string>();
    for (const id of places) {
      const place = atlas.locations.find(item => item.id === id); if (!place) continue;
      if (ROADSIDE_KINDS.has(place.kind)) { targets.add(place.id); continue; }
      for (const road of [...roadsides].sort((a, b) => Math.hypot(a.x - place.x, a.z - place.z) - Math.hypot(b.x - place.x, b.z - place.z)).slice(0, 2)) targets.add(road.id);
    }
    for (const id of targets) result.set(id, [...result.get(id) ?? [], machine]);
  }
  machineRoadsideCache.set(regionId, result); return result;
}
/** Active items keep this far apart, as roadside spots of one place do; spots closer than this share a slot. */
const SLOT_SITE_SPACING = 5;
/** Fewest badges that open the way to a roadside place, gates on the road there included. */
const placeBadges = (location: FieldItemLocation) => Math.max(location.requiredBadges, surfaceBadges(getWorldAtlas(location.regionId), location.locationId));

/**
 * Every roadside spot belongs to one persistent slot, and spots closer than the item spacing to the same one. A slot
 * chooses only among its own spots, so its item and place never depend on what the other slots hold or whether they
 * were picked up. Spots are dealt out in the order the badges open them, one per slot per round; the few spots that
 * can hold a Mega Stone go first to slots that have none, so as many slots as possible offer every kind.
 */
function slotOwners(seed: number, rows: readonly Candidate[], spots: readonly RoadsideSpot[]): Map<Point, number> {
  const all = [...rows, ...spots], points = [...new Set(all.map(row => row.point))], reach = new Map<Point, number>(), mega = new Set<Point>();
  for (const row of all) reach.set(row.point, Math.min(reach.get(row.point) ?? 8, placeBadges(row.location)));
  for (const row of rows) if (row.item.kind === 'mega-stone') mega.add(row.point);
  const parent = points.map((_, index) => index);
  const root = (index: number): number => parent[index] === index ? index : (parent[index] = root(parent[index]));
  for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++)
    if (Math.hypot(points[a].x - points[b].x, points[a].z - points[b].z) < SLOT_SITE_SPACING) parent[root(a)] = root(b);
  const sites = new Map<number, Point[]>();
  points.forEach((point, index) => { const site = root(index); sites.set(site, [...sites.get(site) ?? [], point]); });
  const ordered = [...sites.values()].map(members => ({ members, reach: Math.min(...members.map(point => reach.get(point)!)), mega: members.some(point => mega.has(point)),
    order: hash(`${seed}:${members.map(point => `${point.x.toFixed(2)},${point.z.toFixed(2)}`).sort().join(';')}`) }))
    .sort((a, b) => a.reach - b.reach || a.order - b.order);
  const load = Array.from({ length: FIELD_PICKUP_ACTIVE_LIMIT }, () => ({ sites: 0, mega: 0 })), owners = new Map<Point, number>();
  for (const site of ordered) {
    let slot = 0;
    for (let next = 1; next < load.length; next++) {
      const a = load[next], b = load[slot];
      if (site.mega ? a.mega < b.mega : a.sites < b.sites) slot = next;
    }
    load[slot].sites++; if (site.mega) load[slot].mega++;
    for (const point of site.members) owners.set(point, slot);
  }
  return owners;
}

function candidatesFor(regionId: WorldRegionId, seed: number): RegionCandidates {
  const key = `${regionId}:${seed}`;
  if (!pickupCandidates.has(key)) {
    const pointCache = new Map<string, ReadonlyArray<Point>>();
    const pointsAt = (locationId: string) => {
      if (!pointCache.has(locationId)) pointCache.set(locationId, roadsidePoints(regionId, locationId, hash(`${seed}:${locationId}`)));
      return pointCache.get(locationId)!;
    };
    const items: Candidate[] = [], spots: RoadsideSpot[] = [];
    for (const source of sources.values()) for (const location of source.roadside) if (location.regionId === regionId) {
      for (const point of pointsAt(location.locationId)) items.push({ item: source.item, location, point });
    }
    for (const location of roadsideLocations(regionId)) for (const point of pointsAt(location.locationId)) {
      spots.push({ location, point });
      for (const machine of machinesByRoadside(regionId).get(location.locationId) ?? []) items.push({ item: { ...machine, kind: 'technical-machine' }, location, point });
    }
    if (pickupCandidates.size > 20) pickupCandidates.clear();
    pickupCandidates.set(key, { items, spots, owners: slotOwners(seed, items, spots) });
  }
  return pickupCandidates.get(key)!;
}

const pickupWeight = (item: RoadsideItem, affinity: MegaStoneAffinity) => item.kind === 'technical-machine' ? HELD_TOOL_PICKUP_WEIGHTS[item.tier]
  : item.kind === 'mega-stone' ? 1 + 4 * (affinity[item.speciesId!] ?? 0) : heldToolPickupWeight(item);

type ItemSpots = { item: RoadsideItem; weight: number; rows: Candidate[] };
type SlotPickups = Map<RoadsideItem['kind'], ItemSpots[]>;
const eligibleCache = new Map<string, SlotPickups[]>();
/** Every reachable item and its spots, slot by slot, for one region, badge count and team; slot state does not change it. */
function eligiblePickups(regionId: WorldRegionId, seed: number, badges: number, affinity: MegaStoneAffinity, affinityKey: string): SlotPickups[] {
  const key = `${regionId}:${seed}:${badges}:${affinityKey}`, cached = eligibleCache.get(key); if (cached) return cached;
  const atlas = getWorldAtlas(regionId), candidates = candidatesFor(regionId, seed);
  const traversable = new Map<Point, boolean>();
  // Walked to from the region's start: through no closed gate and into no place that needs more badges.
  const reachable = (row: RoadsideSpot) => {
    if (placeBadges(row.location) > badges) return false;
    if ('item' in row && (row as Candidate).item.kind === 'technical-machine' && badges < MACHINE_BADGES[((row as Candidate).item as TechnicalMachine).tier]) return false;
    let allowed = traversable.get(row.point);
    if (allowed === undefined) traversable.set(row.point, allowed = atlas.evaluateTraversal(row.point, row.point, badges).allowed);
    return allowed;
  };
  const teamStones = fieldItemCatalog().filter(item => item.kind === 'mega-stone' && (affinity[item.speciesId!] ?? 0) > 0);
  const rows: Candidate[] = [...candidates.items.filter(reachable),
    ...candidates.spots.filter(reachable).flatMap(spot => teamStones.map(item => ({ item, ...spot })))];
  const bySlot = Array.from({ length: FIELD_PICKUP_ACTIVE_LIMIT }, () => new Map<string, ItemSpots>());
  for (const row of rows) {
    const byItem = bySlot[candidates.owners.get(row.point)!], group = byItem.get(row.item.id);
    if (group) group.rows.push(row); else byItem.set(row.item.id, { item: row.item, weight: pickupWeight(row.item, affinity), rows: [row] });
  }
  const result = bySlot.map(byItem => {
    const byKind: SlotPickups = new Map();
    for (const group of byItem.values()) byKind.set(group.item.kind, [...(byKind.get(group.item.kind) ?? []), group]);
    return byKind;
  });
  if (eligibleCache.size > 64) eligibleCache.clear();
  eligibleCache.set(key, result); return result;
}

/** Choose an item by its weight first, then one of its roadside spots. */
function weightedPickup(groups: readonly ItemSpots[], roll: number): Candidate | undefined {
  if (!groups.length) return undefined;
  let target = hash(`${roll}:choice`) % groups.reduce((sum, group) => sum + group.weight, 0);
  const group = groups.find(candidate => (target -= candidate.weight) < 0) ?? groups[groups.length - 1];
  return group.rows[hash(`${roll}:place`) % group.rows.length];
}

const KIND_SHARES: ReadonlyArray<readonly [RoadsideItem['kind'], number]> = [['mega-stone', 7], ['technical-machine', 5], ['held-tool', 8]];
/** Of every 20 slot rolls: 7 Mega Stones, 5 technical machines and 8 held tools; a kind the slot's spots cannot hold passes its share on. */
function slotKind(roll: number, offered: SlotPickups): RoadsideItem['kind'] | undefined {
  const shares = KIND_SHARES.filter(([kind]) => offered.has(kind)), total = shares.reduce((sum, [, share]) => sum + share, 0);
  let bucket = total ? roll % total : 0;
  return shares.find(([, share]) => (bucket -= share) < 0)?.[0];
}

/**
 * Persistent slots per region: a collected slot stays empty for 10 minutes of play, then rolls again on its own spots.
 * Mega Stones of team species can appear on any reachable road, weighted by affinity.
 */
export function activeFieldItemPickups(regionId: WorldRegionId, seed: number, states: Readonly<Record<string, FieldItemPickupState>>, badges = 8, affinity: MegaStoneAffinity = {}): FieldItemPickup[] {
  const affinityKey = Object.entries(affinity).filter(([, level]) => level > 0).map(([id, level]) => `${id}=${level}`).sort().join(',');
  const key = `${regionId}:${seed}:${badges}:${affinityKey}:${Array.from({ length: FIELD_PICKUP_ACTIVE_LIMIT }, (_, slot) => {
    const state = states[`field-item:${regionId}:${slot}`]; return `${state?.collectedCount ?? 0}:${(state?.remainingSeconds ?? 0) > 0}`;
  }).join(',')}`;
  const cached = activePickupCache.get(key); if (cached) return cached;
  const slots = eligiblePickups(regionId, seed, badges, affinity, affinityKey);
  const active: FieldItemPickup[] = [];
  for (let slot = 0; slot < FIELD_PICKUP_ACTIVE_LIMIT; slot++) {
    const id = `field-item:${regionId}:${slot}`, state = states[id];
    if ((state?.remainingSeconds ?? 0) > 0) continue;
    const cycle = state?.collectedCount ?? 0, roll = hash(`${seed}:${id}:${cycle}`), own = slots[slot];
    const kind = slotKind(roll, own), chosen = kind && weightedPickup(own.get(kind)!, roll);
    if (!chosen) continue;
    active.push({ ...chosen.item, itemId: chosen.item.id, id, ...chosen.point, regionId, sceneId: surfaceSceneId(regionId), locationId: chosen.location.locationId });
  }
  if (activePickupCache.size > 128) activePickupCache.clear();
  activePickupCache.set(key, active); return active;
}

type AffinityMonster = { speciesId: number; moveLearning?: Readonly<Record<string, { executed: number }>> };
const megaSpecies = new Set(fieldItemCatalog().filter(item => item.kind === 'mega-stone').map(item => item.speciesId!));
/** The team member's species and every later evolution that has a Mega Stone. */
function megaLine(speciesId: number): number[] {
  const found: number[] = [], queue = [speciesId], seen = new Set<number>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (megaSpecies.has(id)) found.push(id);
    queue.push(...getSpecies(id).evolutions.map(evolution => evolution.target));
  }
  return found;
}
/** Level 1 for any team member in a Mega line, rising as it uses its moves: 50, 250 and 1000 uses. */
export function megaStoneAffinity(team: readonly AffinityMonster[]): Record<number, number> {
  const affinity: Record<number, number> = {};
  for (const monster of team) {
    const used = Object.values(monster.moveLearning ?? {}).reduce((sum, stat) => sum + (Number.isSafeInteger(stat.executed) ? stat.executed : 0), 0);
    const level = 1 + (used >= 50 ? 1 : 0) + (used >= 250 ? 1 : 0) + (used >= 1000 ? 1 : 0);
    for (const species of megaLine(monster.speciesId)) affinity[species] = Math.max(affinity[species] ?? 0, level);
  }
  return affinity;
}

export function validateFieldItemPickupStates(value: unknown): Record<string, FieldItemPickupState> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > regionOrder.length * FIELD_PICKUP_ACTIVE_LIMIT) throw new Error('Invalid field item pickup state');
  const result: Record<string, FieldItemPickupState> = {};
  for (const [id, raw] of Object.entries(value)) {
    const slot = /^field-item:(kanto|johto|hoenn|sinnoh|unova|kalos|alola|galar|hisui|paldea):(2[0-3]|1\d|\d)$/.exec(id);
    if (!slot || Number(slot[2]) >= FIELD_PICKUP_ACTIVE_LIMIT || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid field item pickup slot');
    const { remainingSeconds, collectedCount } = raw as FieldItemPickupState;
    if (!Number.isFinite(remainingSeconds) || remainingSeconds < 0 || remainingSeconds > LEGACY_RESPAWN_SECONDS || !Number.isSafeInteger(collectedCount) || collectedCount < 0 || collectedCount > 1e9) throw new Error('Invalid field item pickup timer');
    result[id] = { remainingSeconds: Math.min(remainingSeconds, FIELD_PICKUP_RESPAWN_SECONDS), collectedCount };
  }
  return result;
}
