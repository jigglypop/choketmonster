import { describe, expect, it } from 'vitest';
import { VERSIONS } from '../src/data/pokemon-versions';
import { getWorldAtlas, regionForVersion, WORLDS, type WorldRegionId } from '../src/openworld/atlas';
import {
  KANTO_CONNECTIONS, KANTO_GATES, KANTO_GYMS, KANTO_LOCATIONS, KANTO_MAP_VERSION, KANTO_START, KANTO_SURFACE_CONNECTIONS,
  distanceToKantoPath, encountersForLocation, evaluateKantoTraversal, kantoGateHalfWidth, kantoTravelPoint, locationAt,
  nearestKantoWalkable, safeKantoArrival, sampleKantoWorld,
} from '../src/openworld/kanto';

const ids: WorldRegionId[] = ['kanto','johto','hoenn','sinnoh','unova','kalos','alola','galar','hisui','paldea'];

describe('compressed world atlas', () => {
  it('keeps the established Kanto model as an exact wrapper', () => {
    const atlas = getWorldAtlas('kanto');
    expect(atlas).toMatchObject({ id: 'kanto', mapVersion: KANTO_MAP_VERSION, start: KANTO_START });
    expect(atlas.locations).toBe(KANTO_LOCATIONS); expect(atlas.connections).toBe(KANTO_CONNECTIONS);
    expect(atlas.surfaceConnections).toBe(KANTO_SURFACE_CONNECTIONS); expect(atlas.gates).toBe(KANTO_GATES); expect(atlas.gyms).toBe(KANTO_GYMS);
    expect(atlas.sample).toBe(sampleKantoWorld); expect(atlas.locationAt).toBe(locationAt); expect(atlas.distanceToPath).toBe(distanceToKantoPath);
    expect(atlas.evaluateTraversal).toBe(evaluateKantoTraversal); expect(atlas.safeArrival).toBe(safeKantoArrival);
    expect(atlas.nearestWalkable).toBe(nearestKantoWalkable); expect(atlas.travelPoint).toBe(kantoTravelPoint);
    expect(atlas.encounters).toBe(encountersForLocation); expect(atlas.gateHalfWidth).toBe(kantoGateHalfWidth);
  });

  it('provides ten unique, bounded maps with representative settlements and habitats', () => {
    expect(WORLDS.map(world => world.id)).toEqual(ids);
    expect(new Set(WORLDS.map(world => world.mapVersion)).size).toBe(10);
    const regionalLocationIds = WORLDS.slice(1).flatMap(world => world.locations.map(location => location.id));
    expect(new Set(regionalLocationIds).size).toBe(regionalLocationIds.length);
    for (const world of WORLDS) {
      expect(world.locations.length).toBeGreaterThanOrEqual(world.id === 'kanto' ? 50 : 13);
      expect(world.locations.filter(location => location.kind === 'town').length).toBeGreaterThanOrEqual(world.id === 'hisui' ? 6 : 8);
      expect(world.locations.every(location => Math.abs(location.x) <= 240 && Math.abs(location.z) <= 240)).toBe(true);
      expect(world.locations.some(location => Math.abs(location.x) > 120 || Math.abs(location.z) > 120)).toBe(true);
      expect(new Set(world.locations.map(location => location.id)).size).toBe(world.locations.length);
      expect(world.locations.flatMap(location => location.encounters).every(species => Number.isInteger(species) && species >= 1 && species <= 1025)).toBe(true);
    }
    const johtoNames = getWorldAtlas('johto').locations.map(location => location.name);
    expect(johtoNames).toEqual(expect.arrayContaining(['연두마을','금빛시티','인주시티','방울탑','분노의호수','검은먹시티']));
  });

  it('makes every declared surface connection continuously walkable', () => {
    for (const world of WORLDS.slice(1)) {
      const locations = new Map(world.locations.map(location => [location.id, location]));
      for (const [fromId, toId] of world.surfaceConnections) {
        const from = locations.get(fromId)!, to = locations.get(toId)!;
        expect(from, `${world.id}:${fromId}`).toBeDefined(); expect(to, `${world.id}:${toId}`).toBeDefined();
        let priorHeight = world.sample(from.x, from.z).height;
        for (let step = 0; step <= 20; step++) {
          const t = step / 20, sample = world.sample(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t);
          expect(sample.blocked, `${world.id}:${fromId}->${toId}@${t}`).toBe(false);
          expect(Math.abs(sample.height - priorHeight)).toBeLessThan(.7); priorHeight = sample.height;
        }
      }
    }
  });

  it('has building collisions, safe arrivals, travel points and walkable recovery', () => {
    for (const world of WORLDS.slice(1)) {
      const towns = world.locations.filter(location => location.kind === 'town');
      for (const town of towns) expect((() => {
        for (let dx = -14; dx <= 14; dx += 1) for (let dz = -14; dz <= 14; dz += 1) if (world.sample(town.x + dx, town.z + dz).blocked) return true;
        return false;
      })(), `${world.id}:${town.id} building collision`).toBe(true);
      for (const location of world.locations) {
        const arrival = world.safeArrival(location.id, location.requiredBadges); expect(arrival, `${world.id}:${location.id}`).toBeDefined();
        expect(world.sample(arrival!.x, arrival!.z).blocked).toBe(false);
        if (location.requiredBadges > 0) expect(world.encounters(location.id, location.requiredBadges - 1)).toEqual([]);
      }
      const sourcedHabitats = world.locations.filter(location => location.kind !== 'town' && location.kind !== 'special'
        && world.encounters(location.id, location.requiredBadges).length > 0);
      expect(sourcedHabitats.length, `${world.id} encounter-bearing habitats`).toBeGreaterThan(0);
      expect(world.travelPoint(towns[0].id)).toBeDefined();
      expect(world.travelPoint(world.locations.find(location => location.kind === 'route')!.id)).toBeUndefined();
      const recovered = world.nearestWalkable(238, 238); expect(recovered).toBeDefined(); expect(world.sample(recovered!.x, recovered!.z).blocked).toBe(false);
      expect(world.evaluateTraversal(recovered!, world.start, 0).allowed).toBe(true);
      expect(world.evaluateTraversal(world.start, { x: 242, z: 0 }, 0).allowed).toBe(false);
    }
  });

  it('maps every generated version and restores a serialized region deterministically', () => {
    expect(VERSIONS).toHaveLength(53);
    for (const version of VERSIONS) expect(ids).toContain(regionForVersion(version.id));
    const saved = JSON.parse(JSON.stringify({ regionId: regionForVersion('heartgold'), mapVersion: getWorldAtlas(regionForVersion('heartgold')).mapVersion }));
    expect(getWorldAtlas(saved.regionId)).toMatchObject({ id: 'johto', mapVersion: saved.mapVersion });
    expect(regionForVersion('legends-arceus')).toBe('hisui'); expect(regionForVersion('scarlet')).toBe('paldea'); expect(regionForVersion('legends-za')).toBe('kalos');
    expect(() => regionForVersion('missing-version')).toThrow(RangeError); expect(() => getWorldAtlas('orre')).toThrow(RangeError);
  });
});
