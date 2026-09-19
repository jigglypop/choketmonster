import type { WorldSample } from './types';
import type { KantoLocation, KantoLocationKind, KantoTraversal } from './kanto';
import type { ExpansionRegion } from '../data/expansion-encounters';
import { expansionEncounterPools } from '../data/expansion-encounters';
import { terrainPlateauHeight } from './terrain-elevation';
import { WORLD_MAX, WORLD_SCALE, scaleWorldDistance } from './world-space';

export type AuthoredRegionDefinition = {
  id: ExpansionRegion;
  locations: readonly KantoLocation[];
  connections: ReadonlyArray<readonly [string, string]>;
  terrainFeatures?: readonly AuthoredTerrainFeature[];
};

export type AuthoredTerrainFeature = {
  locationId: string;
  surface: NonNullable<WorldSample['surface']>;
  radius: number;
  elevation: number;
};

export function authoredLocation(region: ExpansionRegion, id: string, name: string, x: number, z: number, kind: KantoLocationKind, fallback: readonly [number, number], requiredBadges = 0): KantoLocation {
  const method = kind === 'sea' ? 'surf' : 'walk', pools = expansionEncounterPools(region, id, method), slots = pools.flatMap(pool => pool.slots);
  return { id, name, x: x * WORLD_SCALE, z: z * WORLD_SCALE, kind,
    minLevel: slots.length ? Math.min(...slots.map(slot => slot.minLevel)) : fallback[0],
    maxLevel: slots.length ? Math.max(...slots.map(slot => slot.maxLevel)) : fallback[1],
    encounters: [...new Set(slots.map(slot => slot.speciesId))], requiredBadges };
}

export function createAuthoredRegionSampler(definition: AuthoredRegionDefinition) {
  const byId = new Map(definition.locations.map(location => [location.id, location]));
  const features = (definition.terrainFeatures ?? []).map(feature => {
    const location = byId.get(feature.locationId);
    if (!location) throw new Error(`${definition.id}: invalid terrain feature ${feature.locationId}`);
    return { ...feature, x: location.x, z: location.z, radius: scaleWorldDistance(feature.radius) };
  });
  const segments = definition.connections.map(([from, to]) => {
    const a = byId.get(from), b = byId.get(to); if (!a || !b) throw new Error(`${definition.id}: invalid connection ${from} -> ${to}`);
    const dx = b.x - a.x, dz = b.z - a.z; return { from: a, to: b, x: a.x, z: a.z, dx, dz, lengthSquared: dx * dx + dz * dz || 1 };
  });
  const towns = definition.locations.filter(location => location.kind === 'town');
  const buildingCache = new Map<string, ReadonlyArray<readonly [number, number]>>();
  const buildingCandidates = [[-5,-4],[5,-4],[-5,4],[5,4],[-6,0],[6,0],[0,-6],[0,6]].map(([x,z])=>[x*WORLD_SCALE,z*WORLD_SCALE] as const);
  const featureAt = (x: number, z: number) => {
    let nearest: typeof features[number] | undefined, distance = Infinity;
    for (const feature of features) {
      const next = Math.hypot(x - feature.x, z - feature.z);
      if (next < feature.radius && next < distance) { nearest = feature; distance = next; }
    }
    return nearest ? { feature: nearest, distance } : undefined;
  };
  const featureLift = (entry: ReturnType<typeof featureAt>) => {
    if (!entry) return 0;
    const t = 1 - entry.distance / entry.feature.radius;
    return entry.feature.elevation * t * t * (3 - 2 * t);
  };
  const baseHeight = (x: number, z: number, feature: ReturnType<typeof featureAt>) => .18 * Math.sin((x / WORLD_SCALE + definition.id.length * 5) * .08)
    + .14 * Math.cos((z / WORLD_SCALE - definition.id.length * 3) * .07) + featureLift(feature);
  const surfaceHeight = (kind: KantoLocationKind, height: number) => kind === 'sea' ? -.68 : height + (kind === 'cave' || kind === 'special' ? .5 : 0);
  const plateaus = towns.map(town => ({ x: town.x, z: town.z, height: baseHeight(town.x, town.z, featureAt(town.x, town.z)) }));
  const nearestLocation = (x: number, z: number) => {
    let nearest = definition.locations[0], distance = Infinity;
    for (const item of definition.locations) {
      const next = Math.hypot(x - item.x, z - item.z);
      if (next < distance) { nearest = item; distance = next; }
    }
    return nearest;
  };
  const nearestSegment = (x: number, z: number) => {
    let nearest = segments[0], nearestT = 0, distance = Infinity;
    for (const segment of segments) {
      const t = Math.max(0, Math.min(1, ((x - segment.x) * segment.dx + (z - segment.z) * segment.dz) / segment.lengthSquared));
      const next = Math.hypot(x - segment.x - segment.dx * t, z - segment.z - segment.dz * t);
      if (next < distance) { nearest = segment; nearestT = t; distance = next; }
    }
    return { segment: nearest, t: nearestT, distance };
  };
  const buildingOffsets = (town: KantoLocation): ReadonlyArray<readonly [number, number]> => {
    const cached=buildingCache.get(town.id); if(cached)return cached;
    const offsets=buildingCandidates.filter(([dx,dz])=>nearestSegment(town.x+dx,town.z+dz).distance>scaleWorldDistance(3.5)).slice(0,3);
    buildingCache.set(town.id,offsets);return offsets;
  };
  const sample = (x: number, z: number): WorldSample => {
    const feature = featureAt(x, z), height = baseHeight(x, z, feature);
    const terrainFeature = feature?.feature;
    if (![x, z].every(Number.isFinite) || Math.abs(x) > WORLD_MAX || Math.abs(z) > WORLD_MAX) return { height, biome: 'rock', blocked: true };
    const nearest = nearestLocation(x, z), path = nearestSegment(x, z), localDistance = Math.hypot(x - nearest.x, z - nearest.z);
    const town=towns.find(item=>Math.hypot(x-item.x,z-item.z)<scaleWorldDistance(8));
    if(town){const blocked=buildingOffsets(town).some(([dx,dz])=>Math.abs(x-town.x-dx)<scaleWorldDistance(1.9)&&Math.abs(z-town.z-dz)<scaleWorldDistance(1.7));return{height:terrainPlateauHeight(height,x,z,plateaus),biome:'meadow',blocked};}
    const radius = scaleWorldDistance(nearest.kind === 'town' ? 8 : nearest.kind === 'sea' ? 6 : nearest.kind === 'route' ? 4.5 : 5.5);
    const playable = path.distance < scaleWorldDistance(3) || localDistance < radius;
    if (!playable) return { height: terrainPlateauHeight(height + (nearest.kind === 'cave' ? .65 : .22), x, z, plateaus), biome: nearest.kind === 'cave' ? 'rock' : 'forest', blocked: true };
    const onPath = path.distance < scaleWorldDistance(3);
    const kind = onPath ? (path.t < .5 ? path.segment.from.kind : path.segment.to.kind) : nearest.kind;
    const biome = kind === 'sea' ? 'lake' : kind === 'cave' || kind === 'special' ? 'rock' : kind === 'forest' ? 'forest' : 'meadow';
    // A connection can join sea directly to a cave or other raised terrain.
    // Blend the endpoint surfaces along that corridor so movement never meets
    // the former one-frame cliff at t=.5.
    const blend = path.t * path.t * (3 - 2 * path.t);
    const surface = onPath
      ? surfaceHeight(path.segment.from.kind, height) * (1 - blend) + surfaceHeight(path.segment.to.kind, height) * blend
      : surfaceHeight(nearest.kind, height);
    return { height: terrainPlateauHeight(surface, x, z, plateaus), biome, ...(terrainFeature ? { surface: terrainFeature.surface } : {}), blocked: false };
  };
  const evaluate = (_from: { x: number; z: number }, to: { x: number; z: number }, badges: number): KantoTraversal => {
    const location = nearestLocation(to.x, to.z);
    if (!Number.isFinite(badges) || badges < location.requiredBadges) return { allowed: false, location, reason: `${location.name} 이동에는 배지 ${location.requiredBadges}개가 필요합니다.` };
    return sample(to.x, to.z).blocked ? { allowed: false, location, reason: '표시된 길과 탐험 지형을 벗어났습니다.' } : { allowed: true, location };
  };
  const safeArrival = (locationId: string, badges = 0) => { const target = byId.get(locationId); return target && target.requiredBadges <= badges ? { x: target.x, z: target.z } : undefined; };
  const nearestWalkable=(x:number,z:number,badges=0):{x:number;z:number}|undefined=>{
    if(![x,z,badges].every(Number.isFinite)||badges<0)return undefined;
    if(!sample(x,z).blocked&&nearestLocation(x,z).requiredBadges<=badges)return{x,z};
    for(let radius=scaleWorldDistance(.5);radius<=scaleWorldDistance(18);radius+=scaleWorldDistance(.5))for(let step=0;step<32;step++){const angle=step/32*Math.PI*2,candidate={x:x+Math.cos(angle)*radius,z:z+Math.sin(angle)*radius};if(!sample(candidate.x,candidate.z).blocked&&nearestLocation(candidate.x,candidate.z).requiredBadges<=badges)return candidate;}
    const fallback=[...definition.locations].filter(location=>location.requiredBadges<=badges).sort((a,b)=>Math.hypot(a.x-x,a.z-z)-Math.hypot(b.x-x,b.z-z))[0];return fallback?safeArrival(fallback.id,badges):undefined;
  };
  return { locationAt: nearestLocation, distanceToPath: (x: number, z: number) => nearestSegment(x, z).distance, sample, evaluate, safeArrival, nearestWalkable, buildingOffsets };
}
