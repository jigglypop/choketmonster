import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import type { FieldPolicy } from '../src/game/field';
import { createGame } from '../src/game/engine';
import { regionalRuntimePools, regionalSupplementalRules } from '../src/data/regional-encounters';
import { getWorldAtlas } from '../src/openworld/atlas';
import { CAVE_SCENES, dungeonFloors, getCaveScene, hasDungeonLandmark, type CaveScene } from '../src/openworld/caves';
import { terrainSurfaceHeight } from '../src/openworld/grounding';
import { findWorldPath } from '../src/openworld/navigation';
import { parkFloorHeight, parkPondRatio, parkRimGap } from '../src/openworld/park-layout';
import { OpenWorldSimulation, PORTAL_WALK_RADIUS } from '../src/openworld/simulation';
import type { ScenePoint } from '../src/openworld/world-space';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;

const PARKS = CAVE_SCENES.filter(scene => scene.kind === 'park');
const safari = dungeonFloors({ regionId: 'kanto', dungeonId: 'safari-zone' });
const nationalPark = dungeonFloors({ regionId: 'johto', dungeonId: 'national-park' });
const side = (point: ScenePoint) => Math.abs(point.x) > Math.abs(point.z) ? point.x > 0 ? 'east' : 'west' : point.z > 0 ? 'south' : 'north';
const doorways = (scene: CaveScene) => [...scene.portals, ...scene.stairs];
const walkTable = (region: 'kanto' | 'johto', locationId: string, period: 'morning' | 'day' | 'night', areas?: readonly string[]) =>
  new Set(regionalRuntimePools(region, locationId, period, 'meadow', areas).flatMap(pool => pool.slots.map(slot => slot.speciesId)));

describe('open-air parks', () => {
  it('opens the Safari Zone as its four FireRed areas and the National Park as one big floor', () => {
    expect(safari.map(zone => [zone.sceneId, zone.name, zone.encounterAreas])).toEqual([
      ['cave:kanto:safari-zone', '사파리존 중앙 구역', ['middle']], ['cave:kanto:safari-zone-east', '사파리존 동쪽 구역', ['area-1-east']],
      ['cave:kanto:safari-zone-north', '사파리존 북쪽 구역', ['area-2-north']], ['cave:kanto:safari-zone-west', '사파리존 서쪽 구역', ['area-3-west']],
    ]);
    expect(safari.map(zone => zone.label)).toEqual(['Safari Zone Center', 'Safari Zone East', 'Safari Zone North', 'Safari Zone West']);
    expect(nationalPark.map(zone => [zone.sceneId, zone.name, zone.encounterAreas])).toEqual([['cave:johto:national-park', '자연공원', undefined]]);
    expect(PARKS.map(zone => zone.sceneId)).toEqual([...safari, ...nationalPark].map(zone => zone.sceneId));
    for (const zone of PARKS) {
      expect(zone.park, zone.sceneId).toBeDefined();
      expect(zone.encounterLocationId).toBe(zone.dungeonId);
      expect(zone.wild).toBe(true);
      expect(zone.legendary).toBeUndefined();
      // The walkable meadow spans at least 45 × 37 tiles.
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let z = -zone.depth / 2; z <= zone.depth / 2; z++) for (let x = -zone.width / 2; x <= zone.width / 2; x++) if (!zone.sample(x, z).blocked) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      expect(maxX - minX, zone.sceneId).toBeGreaterThanOrEqual(45 * zone.tileSize);
      expect(maxZ - minZ, zone.sceneId).toBeGreaterThanOrEqual(37 * zone.tileSize);
    }
  });

  it('enters each park through a gatehouse beside its surface clearing', () => {
    for (const [zone, place] of [[safari[0], 'safari-zone'], [nationalPark[0], 'national-park']] as const) {
      const atlas = getWorldAtlas(zone.regionId), [portal] = zone.portals;
      expect(zone.portals).toHaveLength(1);
      expect(portal.surfaceLocationId).toBe(place);
      expect(atlas.locationAt(portal.surface.x, portal.surface.z).id).toBe(place);
      expect(atlas.sample(portal.surface.x, portal.surface.z).blocked).toBe(false);
      expect(atlas.sample(portal.landmark!.x, portal.landmark!.z).blocked).toBe(true);
      expect(hasDungeonLandmark(zone.regionId, place)).toBe(true);
    }
  });

  it('joins the Safari zones with gates on the rim, each facing the zone it opens onto', () => {
    expect(safari.map(zone => [...zone.portals.map(portal => `${side(portal.interior)}>${portal.surfaceLocationId}`),
      ...zone.stairs.map(stairs => `${side(stairs.interior)}>${getCaveScene(stairs.targetSceneId)!.floorLabel}`)])).toEqual([
      ['south>safari-zone', 'east>동쪽 구역'], ['west>중앙 구역', 'north>북쪽 구역'], ['east>동쪽 구역', 'west>서쪽 구역'], ['north>북쪽 구역'],
    ]);
    expect(side(nationalPark[0].portals[0].interior)).toBe('west');
    for (const zone of PARKS) {
      const park = zone.park!;
      expect(park.gates.map(gate => gate.interior)).toEqual(doorways(zone).map(item => item.interior));
      for (const doorway of doorways(zone)) expect(parkRimGap(park, doorway.interior.x, doorway.interior.z)).toBeCloseTo(1.6, 3);
      // Every doorway is walked to from every other, around the ponds, trees and boulders.
      const arrivals = doorways(zone).map(item => item.interiorArrival);
      for (const from of arrivals) for (const to of arrivals) if (from !== to) {
        const route = findWorldPath(from, to, zone.sample);
        expect(route.length, zone.sceneId).toBeGreaterThan(0);
        expect(Math.hypot(route.at(-1)!.x - to.x, route.at(-1)!.z - to.z)).toBeLessThan(1.2);
      }
    }
  });

  it('samples meadow on the lawn, open water on the ponds and woods past the rim, at the rendered height', () => {
    for (const zone of PARKS) {
      const park = zone.park!;
      expect(park.ponds.length, zone.sceneId).toBeGreaterThan(0);
      for (const pond of park.ponds) {
        expect(zone.sample(pond.x, pond.z)).toMatchObject({ biome: 'lake', blocked: false, height: pond.level });
        expect(parkFloorHeight(park, pond.x, pond.z)).toBeLessThan(pond.level);
      }
      for (const doorway of doorways(zone)) expect(zone.sample(doorway.interiorArrival.x, doorway.interiorArrival.z)).toMatchObject({ biome: 'meadow', blocked: false });
      for (const gate of park.gates) expect(zone.sample(gate.rim.x * 1.08, gate.rim.z * 1.08)).toMatchObject({ biome: 'forest', blocked: true });
      for (const obstacle of park.obstacles) expect(zone.sample(obstacle.x, obstacle.z).blocked, zone.sceneId).toBe(true);
      // Trees, bushes and boulders stand on ground the partner cannot walk; flowers and lily pads do not block.
      for (const plant of park.plants.filter(item => /^(tree|rock)|^bush$/.test(item.asset))) expect(zone.sample(plant.x, plant.z).blocked).toBe(true);
      let meadow = 0;
      for (let z = -30; z <= 30; z += 3.1) for (let x = -40; x <= 40; x += 3.3) {
        const point = zone.sample(x, z);
        expect(point.exactHeight).toBe(true);
        expect(terrainSurfaceHeight(zone.sample, x, z)).toBe(point.height);
        if (!park.ponds.some(pond => parkPondRatio(pond, x, z) < 1)) expect(point.height).toBe(parkFloorHeight(park, x, z));
        if (point.biome === 'meadow' && !point.blocked) meadow++;
      }
      expect(meadow, zone.sceneId).toBeGreaterThan(300);
    }
  });

  it('draws each Safari zone from its own FireRed area', () => {
    const tables = safari.map(zone => walkTable('kanto', zone.encounterLocationId, 'day', zone.encounterAreas));
    // Rhyhorn and Chansey live in the Center and North, Doduo and Kangaskhan in the East and West, Tauros and Venomoth in the North and West.
    expect([111, 84, 115, 128, 113, 49].map(speciesId => tables.map(table => table.has(speciesId)))).toEqual([
      [true, false, true, false], [false, true, false, true], [false, true, false, true], [false, false, true, true], [true, false, true, false], [false, false, true, true],
    ]);
    // Water opens the surf tables; the Safari Zone's rod tables have none, so its ponds hold no spawns.
    for (const zone of safari) expect(regionalRuntimePools('kanto', 'safari-zone', 'day', 'lake', zone.encounterAreas)).toHaveLength(0);
  });

  it('walks the Safari Zone gate by gate from Fuchsia and back, each zone populated from its own area', () => {
    const game = createGame(1, 'safari-zone-walk');
    game.defeatedGyms = [1, 2, 3, 4, 5]; game.player.badges = 5;
    const world = new OpenWorldSimulation(graph, game, 7311, undefined, policy);
    const step = (point: ScenePoint) => { world.player = { ...point, heading: 0 }; return world.portalUnderfoot() && world.traverseCavePortal(PORTAL_WALK_RADIUS); };
    const wilds = () => world.entities.filter(entity => entity.kind === 'wild');
    const settled = (zone: CaveScene) => {
      const table = walkTable('kanto', 'safari-zone', world.dayPeriod, zone.encounterAreas);
      expect(world.sceneId).toBe(zone.sceneId);
      expect(wilds(), zone.sceneId).toHaveLength(15);
      expect(wilds().every(entity => table.has(entity.speciesId) && world.sampleWorld(entity.x, entity.z).biome === 'meadow'), zone.sceneId).toBe(true);
      expect(world.locationAt(world.player.x, world.player.z).name).toBe(zone.name);
    };
    const [center, , , west] = safari, entrance = center.portals[0];
    expect(step(entrance.surface)).toBe(true);
    settled(center);
    for (const [index, zone] of safari.slice(0, -1).entries()) {
      const gate = zone.stairs.find(stairs => stairs.targetSceneId === safari[index + 1].sceneId)!;
      expect(step(gate.interior)).toBe(true);
      settled(safari[index + 1]);
    }
    const restored = new OpenWorldSimulation(graph, game, world.seed, world.snapshot(), policy);
    expect(restored.sceneId).toBe(west.sceneId);
    for (const [index, zone] of [...safari].reverse().slice(0, -1).entries()) {
      const back = safari[safari.length - 2 - index], gate = zone.stairs.find(stairs => stairs.targetSceneId === back.sceneId)!;
      expect(step(gate.interior)).toBe(true);
      expect(world.sceneId).toBe(back.sceneId);
    }
    expect(step(entrance.interior)).toBe(true);
    expect(world.sceneId).toBe('surface:kanto');
    expect(world.player).toMatchObject(entrance.surfaceArrival);
  }, 120_000);

  it('populates the National Park from its whole table and rare slots', () => {
    const game = createGame(152, 'national-park-walk');
    game.campaign!.johtoBadges = [1, 2, 3, 4, 5, 6, 7, 8];
    const world = new OpenWorldSimulation(graph, game, 7312, undefined, policy);
    world.changeRegion('johto');
    const [park] = nationalPark, entrance = park.portals[0];
    world.player = { ...entrance.surface, heading: 0 };
    expect(world.traverseCavePortal(PORTAL_WALK_RADIUS)).toBe(true);
    expect(world.sceneId).toBe(park.sceneId);
    const table = walkTable('johto', 'national-park', world.dayPeriod);
    const rare = new Set(regionalSupplementalRules('johto', 'national-park', 'meadow', 8, { supplemental: true }).map(rule => rule.speciesId));
    const wilds = world.entities.filter(entity => entity.kind === 'wild');
    expect(wilds).toHaveLength(15);
    expect(wilds.every(entity => table.has(entity.speciesId) || rare.has(entity.speciesId))).toBe(true);
    world.player = { ...entrance.interior, heading: 0 };
    expect(world.traverseCavePortal(PORTAL_WALK_RADIUS)).toBe(true);
    expect(world.sceneId).toBe('surface:johto');
  }, 120_000);
});
