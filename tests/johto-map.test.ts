import { describe, expect, it } from 'vitest';
import {
  JOHTO_CONNECTIONS, JOHTO_GATES, JOHTO_GYMS, JOHTO_LOCATIONS, JOHTO_MAP_VERSION, JOHTO_START, JOHTO_SURFACE_CONNECTIONS,
  distanceToJohtoPath, evaluateJohtoTraversal, johtoBuildingOffsets, johtoEncounters, johtoGateHalfWidth, johtoLocationAt, johtoTravelPoint,
  johtoGoldSourceLocationId, nearestJohtoWalkable, safeJohtoArrival, sampleJohtoWorld,
} from '../src/openworld/johto';
import { JOHTO_GOLD_ENCOUNTERS } from '../src/data/johto-gold-encounters';
import { terrainSurfaceHeight } from '../src/openworld/grounding';
import { JOHTO_CAMPAIGN_GYMS } from '../src/game/campaign';
import { getGymScene, gymSceneId } from '../src/openworld/gym-scenes';
import { findWorldPath } from '../src/openworld/navigation';

describe('Johto v3 exploration map', () => {
  it('places the ten cities in their Gold-era relative directions and covers Routes 29-46', () => {
    expect(JOHTO_MAP_VERSION).toBe('johto-v3');
    const at = (id: string) => JOHTO_LOCATIONS.find(item => item.id === id)!;
    expect(JOHTO_START).toEqual({ x: at('new-bark').x, z: at('new-bark').z });
    expect(at('cherrygrove').x).toBeLessThan(at('new-bark').x);
    expect(at('violet').z).toBeLessThan(at('cherrygrove').z);
    expect(at('azalea').z).toBeGreaterThan(at('violet').z);
    expect(at('goldenrod').x).toBeLessThan(at('violet').x);
    expect(at('ecruteak').z).toBeLessThan(at('goldenrod').z);
    expect(at('cianwood').x).toBeLessThan(at('olivine').x);
    expect(at('mahogany').x).toBeGreaterThan(at('ecruteak').x);
    expect(at('blackthorn').x).toBeGreaterThan(at('mahogany').x);
    expect(JOHTO_LOCATIONS.filter(item => item.kind === 'town').map(item => item.id)).toEqual([
      'new-bark', 'cherrygrove', 'violet', 'azalea', 'goldenrod', 'ecruteak', 'olivine', 'cianwood', 'mahogany', 'blackthorn',
    ]);
    expect(JOHTO_CONNECTIONS).toContainEqual(['new-bark', 'route-27']);
    expect(JOHTO_CONNECTIONS).toContainEqual(['tohjo-falls', 'mt-silver']);
    for (let route = 29; route <= 46; route += 1) expect(JOHTO_LOCATIONS.some(item => item.id === `route-${route}` || item.id.startsWith(`route-${route}-`)), `Route ${route}`).toBe(true);
  });

  it('adds a source-backed, badge-locked Mt. Silver spur without moving existing locations', () => {
    const silver = JOHTO_LOCATIONS.find(item => item.id === 'mt-silver')!;
    const falls = JOHTO_LOCATIONS.find(item => item.id === 'tohjo-falls')!;
    expect(falls).toMatchObject({ x: 212, z: 120 });
    expect(silver).toMatchObject({ name: '은빛산', kind: 'cave', requiredBadges: 8 });
    expect(Math.hypot(silver.x - falls.x, silver.z - falls.z)).toBeLessThan(32);
    expect(silver.encounters).toEqual([195, 55, 217, 42, 246, 114, 77, 78, 84, 85, 95, 75]);
    expect(safeJohtoArrival('mt-silver', 7)).toBeUndefined();
    expect(safeJohtoArrival('mt-silver', 8)).toEqual({ x: silver.x, z: silver.z });
    expect(evaluateJohtoTraversal(falls, silver, 7).allowed).toBe(false);
    expect(evaluateJohtoTraversal(falls, silver, 8).allowed).toBe(true);
    expect(johtoEncounters('mt-silver', 7)).toEqual([]);
    expect(johtoEncounters('mt-silver', 8)).toEqual(silver.encounters);
  });

  it('keeps every surface connection continuously walkable and cave-only links out of the surface mesh', () => {
    const byId = new Map(JOHTO_LOCATIONS.map(item => [item.id, item]));
    expect(JOHTO_CONNECTIONS).not.toContainEqual(['dark-cave-east', 'dark-cave-west']);
    for (const [fromId, toId] of JOHTO_SURFACE_CONNECTIONS) {
      const from = byId.get(fromId)!, to = byId.get(toId)!;
      for (let step = 0; step <= 20; step += 1) {
        const t = step / 20, x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t;
        expect(sampleJohtoWorld(x, z).blocked, `${fromId}->${toId}@${t}`).toBe(false);
        expect(distanceToJohtoPath(x, z)).toBeLessThan(1e-7);
      }
    }
    const neighbors = new Map<string, string[]>();
    for (const [from, to] of JOHTO_SURFACE_CONNECTIONS) {
      neighbors.set(from, [...(neighbors.get(from) ?? []), to]); neighbors.set(to, [...(neighbors.get(to) ?? []), from]);
    }
    const reached = new Set(['dark-cave-east']), queue = ['dark-cave-east'];
    while (queue.length) for (const next of neighbors.get(queue.shift()!) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next); }
    expect(reached).toContain('dark-cave-west');
  });

  it('opens each area with the HeartGold/SoulSilver badge that first lets the player reach it', () => {
    const at = (id: string) => JOHTO_LOCATIONS.find(item => item.id === id)!;
    expect(Object.fromEntries(['violet', 'route-32', 'ilex-forest', 'route-36', 'cianwood', 'mt-mortar', 'route-44', 'tohjo-falls', 'mt-silver']
      .map(id => [id, at(id).requiredBadges]))).toEqual({ violet: 0, 'route-32': 1, 'ilex-forest': 2, 'route-36': 3, cianwood: 4, 'mt-mortar': 6, 'route-44': 7, 'tohjo-falls': 8, 'mt-silver': 8 });
    for (const gym of JOHTO_CAMPAIGN_GYMS) expect(at(gym.locationId).requiredBadges, gym.locationId).toBeLessThan(gym.badge);
    for (let badges = 0; badges <= 8; badges++) {
      const reached = new Set(['new-bark']), queue = ['new-bark'];
      for (let head = 0; head < queue.length; head++) for (const [a, b] of JOHTO_CONNECTIONS) {
        const next = a === queue[head] ? b : b === queue[head] ? a : undefined;
        if (next && !reached.has(next) && at(next).requiredBadges <= badges) { reached.add(next); queue.push(next); }
      }
      expect(JOHTO_LOCATIONS.filter(item => item.requiredBadges <= badges && !reached.has(item.id)).map(item => item.id), `stage ${badges}`).toEqual([]);
    }
  });

  it('walks from New Bark to every gym door with one badge fewer than the gym awards', () => {
    let from: { x: number; z: number } = JOHTO_START;
    for (const gym of JOHTO_CAMPAIGN_GYMS) {
      const badges = gym.badge - 1, door = getGymScene(gymSceneId('johto', gym.locationId))!.door;
      const sample = (x: number, z: number) => ({ ...sampleJohtoWorld(x, z), blocked: !evaluateJohtoTraversal({ x, z }, { x, z }, badges).allowed });
      const path = findWorldPath(from, door, sample, 60_000);
      expect(path.length, `${gym.locationId} with ${badges}`).toBeGreaterThan(0);
      expect(Math.hypot(path.at(-1)!.x - door.x, path.at(-1)!.z - door.z)).toBeLessThan(1.5);
      from = door;
    }
  }, 60_000);

  it('marks every badge boundary on a road with a gate at the real locked terrain', () => {
    expect(JOHTO_GATES.length).toBeGreaterThan(0);
    const byId = new Map(JOHTO_LOCATIONS.map(item => [item.id, item]));
    for (const gate of JOHTO_GATES) {
      const a = byId.get(gate.from)!, b = byId.get(gate.to)!, length = Math.hypot(b.x - a.x, b.z - a.z), p = gate.position!;
      const before = { x: p.x - (b.x - a.x) / length * .01, z: p.z - (b.z - a.z) / length * .01 };
      const after = { x: p.x + (b.x - a.x) / length * .01, z: p.z + (b.z - a.z) / length * .01 };
      expect(evaluateJohtoTraversal(before, before, gate.requiredBadges - 1).allowed).not.toBe(evaluateJohtoTraversal(after, after, gate.requiredBadges - 1).allowed);
      expect(evaluateJohtoTraversal(before, after, gate.requiredBadges).allowed).toBe(true);
      expect(evaluateJohtoTraversal(after, before, gate.requiredBadges).allowed).toBe(true);
      expect(gate).toMatchObject({ terrainBoundary: true, badgeLabel: '배지' });
      expect(johtoGateHalfWidth(gate)).toBeGreaterThan(0);
    }
  });

  it('provides collision-safe arrivals, buildings and out-of-bounds recovery', () => {
    for (const town of JOHTO_LOCATIONS.filter(item => item.kind === 'town')) {
      const arrival = safeJohtoArrival(town.id, town.requiredBadges);
      expect(arrival).toBeDefined(); expect(sampleJohtoWorld(arrival!.x, arrival!.z).blocked).toBe(false);
      expect(johtoTravelPoint(town.id, town.requiredBadges)).toEqual(arrival);
      if (town.requiredBadges) expect(johtoTravelPoint(town.id, town.requiredBadges - 1), town.id).toBeUndefined();
      expect(johtoBuildingOffsets(town).length).toBeGreaterThan(0);
      expect(johtoBuildingOffsets(town).some(([dx, dz]) => sampleJohtoWorld(town.x + dx, town.z + dz).blocked)).toBe(true);
    }
    expect(johtoTravelPoint('route-29')).toBeUndefined();
    const recovered = nearestJohtoWalkable(236, 236);
    expect(recovered).toBeDefined(); expect(sampleJohtoWorld(recovered!.x, recovered!.z).blocked).toBe(false);
    expect(evaluateJohtoTraversal(JOHTO_START, { x: 242, z: 0 }, 0).allowed).toBe(false);
    expect(johtoLocationAt(JOHTO_START.x, JOHTO_START.z).id).toBe('new-bark');
  });

  it('keeps every paving tile attached to a flat rendered town surface', () => {
    for (const town of JOHTO_LOCATIONS.filter(item => item.kind === 'town')) {
      const centerHeight = terrainSurfaceHeight(sampleJohtoWorld, town.x, town.z);
      for (let tileX = -7; tileX <= 7; tileX += 1) for (let tileZ = -7; tileZ <= 7; tileZ += 1) {
        if (Math.hypot(tileX, tileZ) > 7.1) continue;
        const height = terrainSurfaceHeight(sampleJohtoWorld, town.x + tileX * 2.24, town.z + tileZ * 2.24);
        expect(Math.abs(height - centerHeight), `${town.id}:${tileX},${tileZ}`).toBeLessThan(1e-6);
      }
    }
  });

  it('exposes habitat tables without pretending Kanto badges are Johto badges', () => {
    expect(JOHTO_GYMS).toEqual([]);
    expect(johtoEncounters('route-29', 0).toSorted((a, b) => a - b)).toEqual([16, 19, 161]);
    expect(johtoEncounters('route-40', 3)).toEqual([]);
    expect(johtoEncounters('route-40', 4).toSorted((a, b) => a - b)).toEqual([72, 73]);
    expect(johtoEncounters('dark-cave-west', 0).length).toBeGreaterThan(0);
    expect(johtoEncounters('dark-cave-east', 7).length).toBeGreaterThan(0);
    for (const town of JOHTO_LOCATIONS.filter(location => location.kind === 'town')) {
      expect(johtoEncounters(town.id, 0), town.id).toEqual([]);
    }
    expect(johtoEncounters('missing', 0)).toEqual([]);
    expect(johtoEncounters('route-29', Number.NaN)).toEqual([]);
  });

  it('summarizes raw Gold species while keeping walk and surf habitats separate', () => {
    expect(JOHTO_GOLD_ENCOUNTERS.some(pool => pool.slots.some(slot => slot.speciesId === 161))).toBe(true);

    for (const location of JOHTO_LOCATIONS) {
      const sourceId = johtoGoldSourceLocationId(location.id);
      const areaName = location.id === 'dark-cave-east' ? 'blackthorn-city-entrance' : location.id === 'dark-cave-west' ? 'violet-city-entrance' : undefined;
      const poolsFor = (method: 'walk' | 'surf') => JOHTO_GOLD_ENCOUNTERS.filter(pool =>
        pool.locationId === sourceId && pool.period === 'day' && pool.method === method && (!areaName || pool.locationAreaName === areaName));
      const pools = poolsFor(location.kind === 'sea' ? 'surf' : 'walk');
      const slots = pools.flatMap(pool => pool.slots);
      expect(location.encounters, location.id).toEqual([...new Set(slots.map(slot => slot.speciesId))]);
      if (slots.length) {
        expect(location.minLevel, location.id).toBe(Math.min(...slots.map(slot => slot.minLevel)));
        expect(location.maxLevel, location.id).toBe(Math.max(...slots.map(slot => slot.maxLevel)));
      }
    }
  });

  it('keeps every numbered route populated and records source-empty traversed habitats', () => {
    const traversedIds = new Set(JOHTO_SURFACE_CONNECTIONS.flatMap(connection => [...connection]));
    const emptyRoutes = JOHTO_LOCATIONS
      .filter(location => traversedIds.has(location.id) && location.kind === 'route')
      .filter(location => location.encounters.length === 0)
      .map(location => location.id);
    const emptyHabitats = JOHTO_LOCATIONS
      .filter(location => traversedIds.has(location.id) && location.kind !== 'town' && location.kind !== 'special')
      .filter(location => location.encounters.length === 0)
      .map(location => location.id);
    expect(emptyRoutes).toEqual([]);
    // Gold exposes Dragon's Den as surf-only; cave summaries intentionally use walk pools.
    expect(emptyHabitats).toEqual(['dragons-den']);
  });
});
