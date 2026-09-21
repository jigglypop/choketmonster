import type { WorldAtlas, WorldRegionId } from './atlas';
import type { KantoLocation, KantoLocationKind } from './kanto';
import type { WorldPoint, WorldSample } from './types';
import { scenerySeed } from './town-style';

export type ExplorationSiteKind = 'junction' | 'rest' | 'lookout' | 'bridge';
export type ExplorationTheme = 'classic' | 'heritage' | 'volcanic' | 'alpine' | 'metro' | 'garden' | 'island' | 'rail' | 'frontier' | 'mosaic';

export type ExplorationSite = WorldPoint & {
  id: string;
  kind: ExplorationSiteKind;
  label: string;
  yaw: number;
  theme: ExplorationTheme;
  biome: WorldSample['biome'];
  destination: WorldPoint;
  connectedLocationIds: readonly string[];
};

export type RouteEdgeMarker = WorldPoint & {
  id: string;
  yaw: number;
  theme: ExplorationTheme;
  biome: WorldSample['biome'];
};

const THEME_BY_REGION: Record<WorldRegionId, ExplorationTheme> = {
  kanto: 'classic', johto: 'heritage', hoenn: 'volcanic', sinnoh: 'alpine', unova: 'metro',
  kalos: 'garden', alola: 'island', galar: 'rail', hisui: 'frontier', paldea: 'mosaic',
};

type Segment = { id: string; from: KantoLocation; to: KantoLocation; dx: number; dz: number; length: number; yaw: number };

function segments(atlas: WorldAtlas, badges: number): Segment[] {
  const locations = new Map(atlas.locations.map(location => [location.id, location]));
  return atlas.surfaceConnections.flatMap(([fromId, toId]) => {
    const from = locations.get(fromId), to = locations.get(toId);
    if (!from || !to || from.requiredBadges > badges || to.requiredBadges > badges) return [];
    const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
    return length > 8 ? [{ id: `${fromId}:${toId}`, from, to, dx, dz, length, yaw: Math.atan2(dx, dz) }] : [];
  });
}

function roadDistance(atlas: WorldAtlas, x: number, z: number): number {
  return atlas.distanceToPath(x, z);
}

function roadsidePoint(atlas: WorldAtlas, sample: (x: number, z: number) => WorldSample, segment: Segment, t: number, preferredSide: number): WorldPoint | undefined {
  const centerX = segment.from.x + segment.dx * t, centerZ = segment.from.z + segment.dz * t;
  const sideX = -segment.dz / segment.length, sideZ = segment.dx / segment.length;
  for (const side of [preferredSide, -preferredSide]) for (const offset of [5.2, 4.7, 4.2, 3.8]) {
    const x = centerX + sideX * offset * side, z = centerZ + sideZ * offset * side;
    if (!sample(x, z).blocked && roadDistance(atlas, x, z) >= 3.45) return { x, z };
  }
  return undefined;
}

function labelFor(kind: ExplorationSiteKind, biome: WorldSample['biome']): string {
  if (kind === 'junction') return '갈림길';
  if (kind === 'bridge') return '수로 다리';
  if (kind === 'rest') return biome === 'forest' ? '숲 쉼터' : biome === 'rock' ? '바위 쉼터' : '길가 쉼터';
  return biome === 'lake' ? '물가 전망대' : biome === 'rock' ? '산길 전망대' : biome === 'forest' ? '숲 전망대' : '전망대';
}

const landmarkKinds = new Set<KantoLocationKind>(['forest', 'cave', 'sea', 'special']);

/** Deterministic, atlas-derived points of interest. They do not alter collision or progression. */
export function buildExplorationSites(atlas: WorldAtlas, sampleWorld: (x: number, z: number) => WorldSample, badges: number): ExplorationSite[] {
  const available = Math.max(0, Number.isFinite(badges) ? badges : 0), edges = segments(atlas, available);
  const theme = THEME_BY_REGION[atlas.id], sites: ExplorationSite[] = [];
  const incident = new Map<string, Segment[]>();
  for (const edge of edges) for (const id of [edge.from.id, edge.to.id]) incident.set(id, [...(incident.get(id) ?? []), edge]);

  for (const [locationId, joined] of incident) {
    if (joined.length < 3) continue;
    const location = atlas.locations.find(item => item.id === locationId)!;
    const edge = joined[scenerySeed(`${atlas.id}:${locationId}`) % joined.length];
    const t = edge.from.id === locationId ? .12 : .88;
    const point = roadsidePoint(atlas, sampleWorld, edge, t, scenerySeed(locationId) % 2 ? 1 : -1);
    if (!point) continue;
    const terrain = sampleWorld(point.x, point.z);
    sites.push({ ...point, id: `junction:${locationId}`, kind: 'junction', label: labelFor('junction', terrain.biome), yaw: edge.yaw,
      theme, biome: terrain.biome, destination: { x: location.x, z: location.z }, connectedLocationIds: joined.map(item => item.from.id === locationId ? item.to.id : item.from.id) });
  }

  edges.forEach((edge, index) => {
    const seed = scenerySeed(`${atlas.id}:${edge.id}`), waterSamples = [.25, .5, .75].map(t => sampleWorld(edge.from.x + edge.dx * t, edge.from.z + edge.dz * t));
    const crossesWater = edge.from.kind === 'sea' || edge.to.kind === 'sea' || waterSamples.some(sample => sample.biome === 'lake');
    if (crossesWater) {
      const t = waterSamples.findIndex(sample => sample.biome === 'lake');
      const at = t < 0 ? .5 : [.25, .5, .75][t];
      const x = edge.from.x + edge.dx * at, z = edge.from.z + edge.dz * at, terrain = sampleWorld(x, z);
      if (!terrain.blocked) sites.push({ x, z, id: `bridge:${edge.id}`, kind: 'bridge', label: labelFor('bridge', terrain.biome), yaw: edge.yaw,
        theme, biome: terrain.biome, destination: { x, z }, connectedLocationIds: [edge.from.id, edge.to.id] });
      return;
    }
    if (index % 3 !== seed % 3) return;
    const point = roadsidePoint(atlas, sampleWorld, edge, .38 + (seed % 20) / 100, seed % 2 ? 1 : -1);
    if (!point) return;
    const terrain = sampleWorld(point.x, point.z);
    sites.push({ ...point, id: `rest:${edge.id}`, kind: 'rest', label: labelFor('rest', terrain.biome), yaw: edge.yaw, theme, biome: terrain.biome,
      destination: point, connectedLocationIds: [edge.from.id, edge.to.id] });
  });

  for (const location of atlas.locations.filter(item => landmarkKinds.has(item.kind) && item.requiredBadges <= available)) {
    const joined = incident.get(location.id);
    if (!joined?.length || scenerySeed(`${atlas.id}:lookout:${location.id}`) % 2) continue;
    const edge = joined[0], t = edge.from.id === location.id ? .16 : .84;
    const point = roadsidePoint(atlas, sampleWorld, edge, t, scenerySeed(location.id) % 2 ? 1 : -1);
    if (!point) continue;
    const terrain = sampleWorld(point.x, point.z);
    sites.push({ ...point, id: `lookout:${location.id}`, kind: 'lookout', label: labelFor('lookout', terrain.biome), yaw: edge.yaw, theme, biome: terrain.biome,
      destination: point, connectedLocationIds: [location.id] });
  }
  return [...new Map(sites.map(site => [site.id, site])).values()];
}

/** Paired roadside posts make long atlas connections readable without laying another road mesh. */
export function buildRouteEdgeMarkers(atlas: WorldAtlas, sampleWorld: (x: number, z: number) => WorldSample, badges: number): RouteEdgeMarker[] {
  const theme = THEME_BY_REGION[atlas.id], markers: RouteEdgeMarker[] = [];
  for (const edge of segments(atlas, Math.max(0, badges))) {
    const count = Math.min(4, Math.floor(edge.length / 28));
    const sideX = -edge.dz / edge.length, sideZ = edge.dx / edge.length;
    for (let index = 1; index <= count; index++) {
      const t = index / (count + 1), cx = edge.from.x + edge.dx * t, cz = edge.from.z + edge.dz * t;
      for (const side of [-1, 1]) {
        const x = cx + sideX * 4.45 * side, z = cz + sideZ * 4.45 * side, terrain = sampleWorld(x, z);
        if (terrain.blocked || roadDistance(atlas, x, z) < 3.45) continue;
        markers.push({ id: `edge:${edge.id}:${index}:${side}`, x, z, yaw: edge.yaw, theme, biome: terrain.biome });
      }
    }
  }
  return markers;
}

export function nearbyExplorationSites<T extends WorldPoint>(items: readonly T[], player: WorldPoint, radius = 90): T[] {
  const limit = Math.max(0, radius);
  return items.filter(item => Math.hypot(item.x - player.x, item.z - player.z) <= limit);
}
