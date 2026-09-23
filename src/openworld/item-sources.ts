import { expansionSpeciesHabitats } from '../data/expansion-spawns';
import { getSpecies } from '../data/pokemon';
import { regionalSpeciesHabitats } from '../data/regional-encounters';
import { getWorldAtlas, type WorldRegionId } from './atlas';
import { captureItemChances, fieldItemCatalog, HELD_TOOL_SOURCE_FAMILIES, heldToolPickupWeight, type FieldItem } from './field-item-drops';
import { isPlayableWorldRegion } from './availability';
import { surfaceSceneId } from './world-space';

export type FieldItemLocation = { regionId: WorldRegionId; locationId: string; name: string; requiredBadges: number };
export type FieldItemSource = {
  item: FieldItem;
  captures: Array<{ speciesIds: number[]; speciesNames: string[]; chance: number; locations: FieldItemLocation[] }>;
  roadside: FieldItemLocation[];
};
export type FieldItemPickup = FieldItem & { itemId: string; x: number; z: number; regionId: WorldRegionId; sceneId: string; locationId: string };
export type FieldItemPickupState = { remainingSeconds: number; collectedCount: number };

export const FIELD_PICKUP_ACTIVE_LIMIT = 3;
export const FIELD_PICKUP_RESPAWN_SECONDS = 30 * 60;
/** Walking this close to a roadside item picks it up; roadside slots sit 2.6–3.8 from the road centre. */
export const FIELD_PICKUP_COLLECT_DISTANCE = 4;

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
const locationSources = new Map<string, FieldItemSource[]>();
export function fieldItemsAtLocation(regionId: WorldRegionId, locationId: string): readonly FieldItemSource[] {
  const key = `${regionId}:${locationId}`;
  if (!locationSources.has(key)) {
    const here = (place: FieldItemLocation) => place.regionId === regionId && place.locationId === locationId;
    locationSources.set(key, [...sources.values()].map(source => ({ ...source,
      captures: source.captures.filter(capture => capture.locations.some(here)).map(capture => ({ ...capture, locations: capture.locations.filter(here) })),
      roadside: source.roadside.filter(here),
    })).filter(source => source.roadside.length || source.captures.length));
  }
  return locationSources.get(key)!;
}

function roadsidePoint(regionId: WorldRegionId, locationId: string, seed: number): { x: number; z: number } | undefined {
  const atlas = getWorldAtlas(regionId), location = atlas.locations.find(candidate => candidate.id === locationId)!;
  const links = atlas.surfaceConnections.filter(([a, b]) => a === locationId || b === locationId);
  for (let n = 0; n < links.length; n++) {
    const link = links[(seed + n) % links.length], otherId = link[0] === locationId ? link[1] : link[0];
    const other = atlas.locations.find(candidate => candidate.id === otherId)!;
    const dx = other.x - location.x, dz = other.z - location.z, length = Math.hypot(dx, dz) || 1;
    for (const t of [.18, .28, .08, .36]) for (const side of [1, -1]) for (const offset of [3.8, 3.2, 2.8]) {
      const point = { x: location.x + dx * t - dz / length * side * offset, z: location.z + dz * t + dx / length * side * offset };
      if (!atlas.sample(point.x, point.z).blocked && atlas.locationAt(point.x, point.z).id === locationId && atlas.distanceToPath(point.x, point.z) >= 2.6) return point;
    }
  }
  return undefined;
}

type Candidate = { source: FieldItemSource; location: FieldItemLocation; point: { x: number; z: number } };
const pickupCandidates = new Map<string, Candidate[]>();
const activePickupCache = new Map<string, FieldItemPickup[]>();
function candidatesFor(regionId: WorldRegionId, seed: number): Candidate[] {
  const key = `${regionId}:${seed}`;
  if (!pickupCandidates.has(key)) {
    const rows: Candidate[] = [];
    for (const source of sources.values()) for (const location of source.roadside) if (location.regionId === regionId) {
      const point = roadsidePoint(regionId, location.locationId, hash(`${seed}:${location.locationId}`));
      if (point) rows.push({ source, location, point });
    }
    if (pickupCandidates.size > 20) pickupCandidates.clear();
    pickupCandidates.set(key, rows);
  }
  return pickupCandidates.get(key)!;
}

/** Choose an item by its tier weight first, then one of its eligible roadside spots. */
function weightedPickup(pool: readonly Candidate[], roll: number): Candidate {
  const byItem = new Map<string, Candidate[]>();
  for (const row of pool) {
    const rows = byItem.get(row.source.item.id);
    if (rows) rows.push(row); else byItem.set(row.source.item.id, [row]);
  }
  const groups = [...byItem.values()], total = groups.reduce((sum, rows) => sum + heldToolPickupWeight(rows[0].source.item), 0);
  let target = hash(`${roll}:choice`) % total;
  const rows = groups.find(candidates => (target -= heldToolPickupWeight(candidates[0].source.item)) < 0) ?? groups[groups.length - 1];
  return rows[hash(`${roll}:place`) % rows.length];
}

/** Three persistent slots per region: a collected slot stays empty for 30 minutes of play. */
export function activeFieldItemPickups(regionId: WorldRegionId, seed: number, states: Readonly<Record<string, FieldItemPickupState>>, badges = 8): FieldItemPickup[] {
  const key = `${regionId}:${seed}:${badges}:${[0, 1, 2].map(slot => {
    const state = states[`field-item:${regionId}:${slot}`]; return `${state?.collectedCount ?? 0}:${(state?.remainingSeconds ?? 0) > 0}`;
  }).join(',')}`;
  const cached = activePickupCache.get(key); if (cached) return cached;
  const atlas = getWorldAtlas(regionId), eligible = candidatesFor(regionId, seed).filter(row => row.location.requiredBadges <= badges
    && atlas.evaluateTraversal(row.point, row.point, badges).allowed);
  const active: FieldItemPickup[] = [];
  for (let slot = 0; slot < FIELD_PICKUP_ACTIVE_LIMIT; slot++) {
    const id = `field-item:${regionId}:${slot}`, state = states[id];
    if ((state?.remainingSeconds ?? 0) > 0 || !eligible.length) continue;
    const cycle = state?.collectedCount ?? 0, roll = hash(`${seed}:${id}:${cycle}`);
    const kind = roll % 4 === 0 ? 'mega-stone' : 'held-tool';
    const spaced = (row: Candidate) => !active.some(item => Math.hypot(item.x - row.point.x, item.z - row.point.z) < 5);
    const available = eligible.filter(row => row.source.item.kind === kind && spaced(row));
    const pool = available.length ? available : eligible.filter(spaced);
    if (!pool.length) continue;
    const chosen = weightedPickup(pool, roll);
    active.push({ ...chosen.source.item, itemId: chosen.source.item.id, id, ...chosen.point, regionId, sceneId: surfaceSceneId(regionId), locationId: chosen.location.locationId });
  }
  if (activePickupCache.size > 128) activePickupCache.clear();
  activePickupCache.set(key, active); return active;
}

export function validateFieldItemPickupStates(value: unknown): Record<string, FieldItemPickupState> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > regionOrder.length * FIELD_PICKUP_ACTIVE_LIMIT) throw new Error('Invalid field item pickup state');
  const result: Record<string, FieldItemPickupState> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!/^field-item:(kanto|johto|hoenn|sinnoh|unova|kalos|alola|galar|hisui|paldea):[0-2]$/.test(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid field item pickup slot');
    const { remainingSeconds, collectedCount } = raw as FieldItemPickupState;
    if (!Number.isFinite(remainingSeconds) || remainingSeconds < 0 || remainingSeconds > FIELD_PICKUP_RESPAWN_SECONDS || !Number.isSafeInteger(collectedCount) || collectedCount < 0 || collectedCount > 1e9) throw new Error('Invalid field item pickup timer');
    result[id] = { remainingSeconds, collectedCount };
  }
  return result;
}
