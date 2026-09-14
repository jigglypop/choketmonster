import { describe, expect, it } from 'vitest';
import { POKEMON } from '../src/data/pokemon';
import { createSceneryPlacements } from '../src/openworld/scenery';
import {
  encountersForLocation,
  evaluateKantoTraversal,
  KANTO_CONNECTIONS,
  KANTO_GATES,
  KANTO_MAP_VERSION,
  KANTO_GYMS,
  KANTO_LOCATIONS,
  KANTO_START,
  kantoSpeciesSources,
  locationAt,
  isKantoPlayable,
  kantoGateHalfWidth,
  kantoTravelPoint,
  nearestKantoWalkable,
  safeKantoArrival,
  sampleKantoWorld,
  townBuildingOffsets,
} from '../src/openworld/kanto';
import { terrainSurfaceHeight } from '../src/openworld/grounding';

describe('compressed Kanto open world', () => {
  it('places the original journey in the intended relative directions', () => {
    const at = (id: string) => KANTO_LOCATIONS.find(item => item.id === id)!;
    expect(at('viridian').z).toBeLessThan(KANTO_START.z);
    expect(at('pewter').z).toBeLessThan(at('viridian').z);
    expect(at('mt-moon').x).toBeGreaterThan(at('pewter').x);
    expect(at('cerulean').x).toBeGreaterThan(at('mt-moon').x);
    expect(at('vermilion').z).toBeGreaterThan(at('cerulean').z);
    expect(at('celadon').x).toBeLessThan(at('saffron').x);
    expect(at('lavender').x).toBeGreaterThan(at('saffron').x);
    expect(at('fuchsia').z).toBeGreaterThan(at('saffron').z);
    expect(at('cinnabar').z).toBeGreaterThan(at('pallet').z);
  });

  it('represents routes 1 through 25 and connects every core location', () => {
    const represented = new Set(KANTO_LOCATIONS.flatMap(item => {
      const match = /^route-(\d+)/.exec(item.id);
      return match ? [Number(match[1])] : [];
    }));
    expect([...Array(25)].map((_, index) => index + 1).every(number => represented.has(number))).toBe(true);
    const adjacency = new Map<string, string[]>();
    for (const [from, to] of KANTO_CONNECTIONS) {
      adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
      adjacency.set(to, [...(adjacency.get(to) ?? []), from]);
    }
    const reached = new Set(['pallet']), queue = ['pallet'];
    while (queue.length) for (const next of adjacency.get(queue.shift()!) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next); }
    expect(reached.size).toBe(KANTO_LOCATIONS.length);
  });

  it('keeps towns and every mapped path endpoint walkable inside the world', () => {
    for (const item of KANTO_LOCATIONS) {
      expect(Math.abs(item.x)).toBeLessThanOrEqual(120);
      expect(Math.abs(item.z)).toBeLessThanOrEqual(120);
      expect(sampleKantoWorld(item.x, item.z).blocked, item.id).toBe(false);
      expect(locationAt(item.x, item.z).id).toBe(item.id);
    }
    for (const town of KANTO_LOCATIONS.filter(item => item.kind === 'town')) {
      expect(townBuildingOffsets(town).length, `${town.id} buildings`).toBeGreaterThan(0);
      const [offsetX, offsetZ] = townBuildingOffsets(town)[0];
      expect(sampleKantoWorld(town.x + offsetX, town.z + offsetZ).blocked, `${town.id} building`).toBe(true);
      expect(sampleKantoWorld(town.x, town.z).blocked, `${town.id} center`).toBe(false);
    }
    const byId = new Map(KANTO_LOCATIONS.map(item => [item.id, item]));
    for (const [fromId, toId] of KANTO_CONNECTIONS) {
      const from = byId.get(fromId)!, to = byId.get(toId)!;
      if (fromId === 'diglett-cave-east' && toId === 'diglett-cave-west') continue;
      for (let step = 0; step <= 10; step += 1) {
        const t = step / 10;
        expect(sampleKantoWorld(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t).blocked, `${fromId} -> ${toId} at ${t}`).toBe(false);
      }
    }
  });

  it('keeps every paving tile attached to a flat rendered town surface', () => {
    for (const town of KANTO_LOCATIONS.filter(item => item.kind === 'town')) {
      const centerHeight = terrainSurfaceHeight(sampleKantoWorld, town.x, town.z);
      for (let tileX = -7; tileX <= 7; tileX += 1) for (let tileZ = -7; tileZ <= 7; tileZ += 1) {
        if (Math.hypot(tileX, tileZ) > 7.1) continue;
        const height = terrainSurfaceHeight(sampleKantoWorld, town.x + tileX * 1.12, town.z + tileZ * 1.12);
        expect(Math.abs(height - centerHeight), `${town.id}:${tileX},${tileZ}`).toBeLessThan(1e-6);
      }
    }
  });

  it('encloses play to towns and road corridors without blocking the opening journey', () => {
    expect(isKantoPlayable(KANTO_START.x, KANTO_START.z)).toBe(true);
    expect(isKantoPlayable(0, 0)).toBe(false);
    expect(isKantoPlayable(80, 80)).toBe(false);
    expect(sampleKantoWorld(-20, 110)).toMatchObject({ biome: 'lake', blocked: true });
    for (const id of ['pallet', 'route-1', 'viridian', 'route-2-south', 'viridian-forest', 'route-2-north', 'pewter']) {
      const place = KANTO_LOCATIONS.find(item => item.id === id)!;
      expect(evaluateKantoTraversal(place, place, 0).allowed, id).toBe(true);
    }
  });

  it('returns exact badge-gate failures and safe teleport arrivals', () => {
    expect(KANTO_MAP_VERSION).toBe('kanto-v2');
    const byId = new Map(KANTO_LOCATIONS.map(item => [item.id, item]));
    for (const gate of KANTO_GATES.filter(item => item.visible !== false)) {
      const from = byId.get(gate.from)!, to = byId.get(gate.to)!;
      const center = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
      const length = Math.hypot(to.x - from.x, to.z - from.z);
      const step = { x: (to.x - from.x) / length, z: (to.z - from.z) / length };
      const before = { x: center.x - step.x, z: center.z - step.z };
      const after = { x: center.x + step.x, z: center.z + step.z };
      const denied = evaluateKantoTraversal(before, after, gate.requiredBadges - 1);
      expect(denied).toMatchObject({ allowed: false, reason: gate.reason });
      expect(denied.gate?.id).toBe(gate.id);
      expect(evaluateKantoTraversal(before, after, gate.requiredBadges).allowed).toBe(true);
      expect(evaluateKantoTraversal(center, before, gate.requiredBadges - 1).allowed).toBe(true);
      expect(nearestKantoWalkable(center.x, center.z, gate.requiredBadges - 1)).not.toEqual(center);

      // The same half-width drives the visible crossbar and collision. Crossing
      // near its edge must still fail, including where a town disc widens a road.
      const halfWidth = kantoGateHalfWidth(gate);
      let playableCrossings = 0;
      for (let lateral = -halfWidth; lateral <= halfWidth; lateral += .5) {
        const side = { x: -step.z * lateral, z: step.x * lateral };
        const edgeBefore = { x: before.x + side.x, z: before.z + side.z };
        const edgeAfter = { x: after.x + side.x, z: after.z + side.z };
        if (!isKantoPlayable(edgeBefore.x, edgeBefore.z) || !isKantoPlayable(edgeAfter.x, edgeAfter.z)) continue;
        playableCrossings += 1;
        const edgeDenied = evaluateKantoTraversal(edgeBefore, edgeAfter, gate.requiredBadges - 1);
        expect(edgeDenied.gate?.id, `${gate.id} lateral ${lateral}`).toBe(gate.id);
      }
      expect(playableCrossings, `${gate.id} playable cross-section`).toBeGreaterThan(0);
    }
    expect(kantoGateHalfWidth(KANTO_GATES.find(gate => gate.id === 'pallet-surf')!)).toBeGreaterThan(7);
    expect(KANTO_GATES.filter(gate => gate.visible !== false).every(gate => kantoGateHalfWidth(gate) >= 3.6)).toBe(true);
    expect(KANTO_GATES.find(gate => gate.id === 'diglett-tunnel')).toMatchObject({ requiredBadges: 2, visible: false });
    for (const town of KANTO_LOCATIONS.filter(item => item.kind === 'town')) {
      const arrival = safeKantoArrival(town.id, 0);
      expect(arrival, town.id).toBeDefined();
      expect(sampleKantoWorld(arrival!.x, arrival!.z).blocked).toBe(false);
    }
    expect(safeKantoArrival('mew-sanctum', 7)).toBeUndefined();
    expect(safeKantoArrival('mew-sanctum', 8)).toEqual({ x: -109, z: -18 });
    expect(safeKantoArrival('missing', 8)).toBeUndefined();
    expect(kantoTravelPoint('pallet')).toEqual(KANTO_START);
    expect(kantoTravelPoint('route-1')).toBeUndefined();
    const migrated = nearestKantoWalkable(0, 0);
    expect(migrated).toBeDefined();
    expect(isKantoPlayable(migrated!.x, migrated!.z)).toBe(true);
    expect(nearestKantoWalkable(KANTO_START.x, KANTO_START.z)).toEqual(KANTO_START);
    expect(nearestKantoWalkable(Number.NaN, 0)).toBeUndefined();
  });

  it('places visible route fences on the same blocked boundary used by movement', () => {
    const scenery = createSceneryPlacements(sampleKantoWorld);
    expect(scenery.fence.length).toBeGreaterThan(100);
    expect(scenery.fence.every(item => sampleKantoWorld(item.x, item.z).blocked)).toBe(true);
    for (const id of ['rock-tall', 'rock-ridge', 'cliff'] as const) {
      expect(scenery[id].length).toBeGreaterThan(0);
      expect(scenery[id].every(item => sampleKantoWorld(item.x, item.z).blocked)).toBe(true);
    }
  });

  it('uses fixed local levels and gates only isolated legendary encounters', () => {
    const legendary = new Set([144, 145, 146, 150, 151]);
    for (const item of KANTO_LOCATIONS) {
      expect(item.minLevel).toBeLessThanOrEqual(item.maxLevel);
      for (const speciesId of item.encounters) {
        if (legendary.has(speciesId)) {
          expect(item.kind).toBe('special');
          expect(item.requiredBadges).toBe(8);
        } else expect(item.requiredBadges).toBe(0);
      }
    }
    expect(encountersForLocation('zapdos-roost', 7)).toEqual([]);
    expect(encountersForLocation('zapdos-roost', 8)).toEqual([145]);
    expect(encountersForLocation('route-1', 0)).toEqual([16, 19]);
    expect(encountersForLocation('missing', 8)).toEqual([]);
  });

  it('keeps early encounters basic while all 151 remain collectible through evolution', () => {
    const earlyIds = new Set(['pallet', 'route-1', 'viridian', 'route-2-south', 'viridian-forest', 'route-2-north']);
    const allowedEarly = new Set([10, 13, 16, 19, 25]);
    const earlyEncounters = KANTO_LOCATIONS.filter(item => earlyIds.has(item.id)).flatMap(item => item.encounters);
    expect(earlyEncounters.every(speciesId => allowedEarly.has(speciesId))).toBe(true);
    expect(earlyEncounters.some(speciesId => [11, 14, 17, 20].includes(speciesId))).toBe(false);
    expect(earlyEncounters.some(speciesId => [144, 145, 146, 150, 151].includes(speciesId))).toBe(false);

    const reachable = new Set<number>([1, 4, 7, ...KANTO_LOCATIONS.flatMap(item => item.encounters)]);
    let added = true;
    while (added) {
      added = false;
      for (const speciesId of [...reachable]) for (const evolution of POKEMON[speciesId - 1].evolutions) {
        if (!reachable.has(evolution.target)) { reachable.add(evolution.target); added = true; }
      }
    }
    expect([...Array(151)].map((_, index) => index + 1).filter(speciesId => !reachable.has(speciesId))).toEqual([]);
    expect(KANTO_LOCATIONS.filter(item => item.encounters.some(speciesId => [144, 145, 146, 150, 151].includes(speciesId)))
      .every(item => item.kind === 'special' && item.requiredBadges === 8)).toBe(true);
    expect(KANTO_LOCATIONS.find(item => item.id === 'cinnabar-lab')?.encounters).toEqual(expect.arrayContaining([1, 4, 7, 138, 140, 142]));
    expect(kantoSpeciesSources(1)).toEqual(expect.arrayContaining(['태초마을 스타터 선택', '홍련 연구소']));
    expect(kantoSpeciesSources(139)).toContain('암나이트에서 진화');
    expect(kantoSpeciesSources(151)).toEqual(['환상의 정원']);
    expect(kantoSpeciesSources(152)).toEqual([]);
  });

  it('defines the eight gym leaders at fixed original-order levels', () => {
    expect(KANTO_GYMS.map(gym => [gym.name, gym.level])).toEqual([
      ['웅', 14], ['이슬', 21], ['마티스', 24], ['민화', 29],
      ['독수', 43], ['초련', 43], ['강연', 47], ['비주기', 50],
    ]);
    expect(KANTO_GYMS.map(gym => gym.badge)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(KANTO_GYMS.every(gym => gym.badgeName.endsWith('배지'))).toBe(true);
    expect(new Set(KANTO_GYMS.map(gym => gym.locationId)).size).toBe(8);
  });
});
