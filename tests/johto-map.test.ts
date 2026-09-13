import { describe, expect, it } from 'vitest';
import {
  JOHTO_CONNECTIONS, JOHTO_GATES, JOHTO_GYMS, JOHTO_LOCATIONS, JOHTO_MAP_VERSION, JOHTO_START, JOHTO_SURFACE_CONNECTIONS,
  distanceToJohtoPath, evaluateJohtoTraversal, johtoBuildingOffsets, johtoEncounters, johtoLocationAt, johtoTravelPoint,
  johtoGoldSourceLocationId, nearestJohtoWalkable, safeJohtoArrival, sampleJohtoWorld,
} from '../src/openworld/johto';
import { JOHTO_GOLD_ENCOUNTERS } from '../src/data/johto-gold-encounters';

describe('Johto v2 exploration map', () => {
  it('places the ten cities in their Gold-era relative directions and covers Routes 29-46', () => {
    expect(JOHTO_MAP_VERSION).toBe('johto-v2');
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
    for (let route = 29; route <= 46; route += 1) expect(JOHTO_LOCATIONS.some(item => item.id === `route-${route}` || item.id.startsWith(`route-${route}-`)), `Route ${route}`).toBe(true);
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

  it('provides collision-safe arrivals, buildings and out-of-bounds recovery', () => {
    for (const town of JOHTO_LOCATIONS.filter(item => item.kind === 'town')) {
      const arrival = safeJohtoArrival(town.id);
      expect(arrival).toBeDefined(); expect(sampleJohtoWorld(arrival!.x, arrival!.z).blocked).toBe(false);
      expect(johtoTravelPoint(town.id)).toEqual(arrival);
      expect(johtoBuildingOffsets(town).length).toBeGreaterThan(0);
      expect(johtoBuildingOffsets(town).some(([dx, dz]) => sampleJohtoWorld(town.x + dx, town.z + dz).blocked)).toBe(true);
    }
    expect(johtoTravelPoint('route-29')).toBeUndefined();
    const recovered = nearestJohtoWalkable(118, 118);
    expect(recovered).toBeDefined(); expect(sampleJohtoWorld(recovered!.x, recovered!.z).blocked).toBe(false);
    expect(evaluateJohtoTraversal(JOHTO_START, { x: 118, z: 118 }, 0).allowed).toBe(false);
    expect(johtoLocationAt(JOHTO_START.x, JOHTO_START.z).id).toBe('new-bark');
  });

  it('exposes habitat tables without pretending Kanto badges are Johto badges', () => {
    expect(JOHTO_GYMS).toEqual([]); expect(JOHTO_GATES).toEqual([]);
    expect(johtoEncounters('route-29', 0).toSorted((a, b) => a - b)).toEqual([16, 19, 161]);
    expect(johtoEncounters('route-40', 0).toSorted((a, b) => a - b)).toEqual([72, 73]);
    expect(johtoEncounters('dark-cave-west', 0).length).toBeGreaterThan(0);
    expect(johtoEncounters('dark-cave-east', 0).length).toBeGreaterThan(0);
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
