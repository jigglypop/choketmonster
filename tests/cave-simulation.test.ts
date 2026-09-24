import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import type { FieldPolicy } from '../src/game/field';
import { createGame } from '../src/game/engine';
import { CAVE_SCENES, dungeonFloors, getCaveScene, type CavePortal } from '../src/openworld/caves';
import { OpenWorldSimulation, PORTAL_WALK_RADIUS } from '../src/openworld/simulation';
import { regionalRuntimePools, regionalSupplementalRules, supplementalEncounterRules } from '../src/data/regional-encounters';
import { expansionEncounterSpecies, expansionSupplementalRules } from '../src/data/expansion-spawns';
import type { ExpansionRegion } from '../src/data/expansion-encounters';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;

// Mt. Moon lies past Pewter's gate, so its doorways open with the Boulder Badge.
const boulder = (game: ReturnType<typeof createGame>) => { game.defeatedGyms = [1]; game.player.badges = 1; return game; };

describe('cave simulation scenes', () => {
  it('enables new-world auto capture while preserving an explicit saved false value', () => {
    const game = createGame(1, 'auto-capture-default'), world = new OpenWorldSimulation(graph, game, 7181, undefined, policy);
    expect(world.autoCapture).toBe(true);
    world.setAutoCapture(false);
    const restored = new OpenWorldSimulation(graph, game, world.seed, world.snapshot(), policy);
    expect(restored.autoCapture).toBe(false);
  });

  it('enters, saves, restores and exits through a real portal', () => {
    const game = boulder(createGame(1, 'cave-scene')), world = new OpenWorldSimulation(graph, game, 7182, undefined, policy);
    const cave = getCaveScene('cave:kanto:mt-moon')!, portal = cave.portals[0];
    expect(world.movePlayer({ ...portal.surface, heading: 0 })).toBe(true);
    expect(world.traverseCavePortal()).toBe(true);
    expect(world.sceneId).toBe(cave.sceneId);
    expect(world.locationAt(world.player.x, world.player.z).id).toBe(cave.encounterLocationId);
    expect(world.entities.filter(entity => entity.kind === 'wild')).toHaveLength(15);
    const restored = new OpenWorldSimulation(graph, game, world.seed, world.snapshot(), policy);
    expect(restored.sceneId).toBe(cave.sceneId);
    expect(restored.movePlayer({ ...portal.interior, heading: 0 })).toBe(true);
    expect(restored.traverseCavePortal()).toBe(true);
    expect(restored.sceneId).toBe(portal.surfaceSceneId);
  });

  it('restores historical interior coordinates and walks straight across the open chamber', () => {
    const game = boulder(createGame(1, 'open-cave-restore')), cave = getCaveScene('cave:kanto:mt-moon')!;
    const world = new OpenWorldSimulation(graph, game, 7183, undefined, policy);
    expect(world.movePlayer({ ...cave.portals[0].surface, heading: 0 })).toBe(true);
    expect(world.traverseCavePortal()).toBe(true);
    world.player = { x: 0, z: 0, heading: 0 };
    const restored = new OpenWorldSimulation(graph, game, world.seed, world.snapshot(), policy);
    expect(restored.sceneId).toBe(cave.sceneId);
    expect(restored.player).toMatchObject({ x: 0, z: 0 });
    expect(restored.movePlayer({ x: cave.legacyWidth / 2 - cave.tileSize * 1.5, z: cave.legacyDepth / 2 - cave.tileSize * 1.5, heading: 0 })).toBe(true);
  });

  it('lists every exit of the dungeon and immediately leaves through the nearest or selected real portal', () => {
    const game = boulder(createGame(1, 'cave-quick-exit')), cave = getCaveScene('cave:kanto:mt-moon')!, deepest = getCaveScene('cave:kanto:mt-moon-b2f')!;
    const world = new OpenWorldSimulation(graph, game, 7184, undefined, policy);
    // Route 3 opens onto 1F; the Route 4 exit is on the deepest floor.
    world.sceneId = deepest.sceneId; world.player = { ...deepest.portals[0].interiorArrival, heading: 0 };
    expect(world.caveExits().map(exit => exit.surfaceLocationId)).toEqual(['route-4', 'route-3']);
    expect(world.exitCave()).toBe(true);
    expect(world.sceneId).toBe(deepest.portals[0].surfaceSceneId);
    expect(world.player).toMatchObject(deepest.portals[0].surfaceArrival);

    world.sceneId = cave.sceneId; world.player = { x: 0, z: 0, heading: 0 };
    expect(world.caveExits().map(exit => exit.surfaceLocationId)).toEqual(['route-3', 'route-4']);
    expect(world.exitCave(deepest.portals[0].id)).toBe(true);
    expect(world.player).toMatchObject(deepest.portals[0].surfaceArrival);
    expect(world.exitCave()).toBe(false);

    world.sceneId = cave.sceneId;
    game.captureOffer = { ...game.player.team[0], hp: 0 };
    expect(world.exitCave()).toBe(false);
    expect(world.sceneId).toBe(cave.sceneId);
  });

  it('walks through Mt. Moon floor by floor, from Route 3 to Route 4, only when stepping onto a doorway', () => {
    const game = boulder(createGame(1, 'cave-walk-through')), world = new OpenWorldSimulation(graph, game, 7185, undefined, policy);
    const floors = dungeonFloors({ regionId: 'kanto', dungeonId: 'mt-moon' }), entrance = floors[0].portals[0];
    const step = (point: { x: number; z: number }) => { world.player = { ...point, heading: 0 }; return world.portalUnderfoot() && world.traverseCavePortal(PORTAL_WALK_RADIUS); };
    // Standing near, but not on, the entrance does nothing.
    expect(step({ x: entrance.surface.x + PORTAL_WALK_RADIUS + .4, z: entrance.surface.z })).toBe(false);
    expect(step(entrance.surface)).toBe(true);
    expect(world.sceneId).toBe(floors[0].sceneId);
    expect(world.player).toMatchObject(entrance.interiorArrival);
    expect(world.portalUnderfoot()).toBe(false);
    for (const [index, floor] of floors.slice(0, -1).entries()) {
      const down = floor.stairs.find(stairs => stairs.targetSceneId === floors[index + 1].sceneId)!;
      expect(down.direction).toBe('down');
      expect(step(down.interior)).toBe(true);
      expect(world.sceneId).toBe(floors[index + 1].sceneId);
      expect(world.sampleWorld(world.player.x, world.player.z).blocked).toBe(false);
      expect(world.entities.filter(entity => entity.kind === 'wild')).toHaveLength(15);
    }
    expect(world.locationAt(world.player.x, world.player.z).name).toBe('달맞이산 동굴 지하 2층');
    expect(step(floors.at(-1)!.portals[0].interior)).toBe(true);
    expect(world.sceneId).toBe('surface:kanto');
    expect(world.player).toMatchObject(floors.at(-1)!.portals[0].surfaceArrival);
    expect(world.atlas.locationAt(world.player.x, world.player.z).id).toBe('mt-moon');
  });

  it('keeps surface gates closed underground: an exit opens only with the badges that reach its side', () => {
    const game = createGame(1, 'dungeon-gates'), world = new OpenWorldSimulation(graph, game, 7188, undefined, policy);
    const diglett = getCaveScene('cave:kanto:diglett-cave')!, [east, west] = diglett.portals;
    world.player = { ...west.surface, heading: 0 };
    expect(world.traverseCavePortal()).toBe(true);
    // Without the Cascade Badge the tunnel's east end stays shut, as does the gate it bypasses.
    expect(world.caveExits().map(exit => exit.surfaceLocationId)).toEqual(['diglett-cave-west']);
    expect(world.exitCave(east.id)).toBe(false);
    world.player = { ...east.interior, heading: 0 };
    expect(world.portalUnderfoot()).toBe(false);
    expect(world.traverseCavePortal()).toBe(false);
    expect(world.sceneId).toBe(diglett.sceneId);
    game.defeatedGyms = [1, 2]; game.player.badges = 2;
    expect(world.caveExits().map(exit => exit.surfaceLocationId).sort()).toEqual(['diglett-cave-east', 'diglett-cave-west']);
    expect(world.traverseCavePortal()).toBe(true);
    expect(world.player).toMatchObject(east.surfaceArrival);
    // Cerulean Cave, and every other gated place, refuses its entrance until the badges allow the place itself.
    const cerulean = getCaveScene('cave:kanto:cerulean-cave')!;
    world.player = { ...cerulean.portals[0].surface, heading: 0 };
    expect(world.traverseCavePortal()).toBe(false);
    game.defeatedGyms = [1, 2, 3, 4, 5, 6, 7, 8]; game.player.badges = 8;
    expect(world.traverseCavePortal()).toBe(true);
    expect(world.sceneId).toBe(cerulean.sceneId);
  });

  it('draws each floor from its own encounter areas and keeps the lower Pokémon Tower floors empty', () => {
    const game = createGame(1, 'dungeon-floor-encounters');
    game.defeatedGyms = [1, 2, 3, 4, 5, 6, 7, 8]; game.player.badges = 8;
    const world = new OpenWorldSimulation(graph, game, 7186, undefined, policy);
    const tower = dungeonFloors({ regionId: 'kanto', dungeonId: 'pokemon-tower' });
    world.sceneId = tower[0].sceneId; (world as any).resetScenePopulation(tower[0].portals[0].interiorArrival);
    expect(world.sceneHasWilds).toBe(false);
    expect(world.entities.filter(entity => entity.kind === 'wild')).toHaveLength(0);
    expect(world.rosterStatus()).toMatchObject({ alive: 0, pending: 15 });
    world.step({ deltaSeconds: 5 });
    expect(world.rosterStatus()).toMatchObject({ alive: 0, pending: 15 });
    // A save on the empty floor keeps its waiting roster.
    const restored = new OpenWorldSimulation(graph, game, world.seed, world.snapshot(), policy);
    expect(restored.sceneId).toBe(tower[0].sceneId);
    expect(restored.rosterStatus()).toMatchObject({ alive: 0, pending: 15 });
    const third = tower[2], from = tower[1].stairs.find(stairs => stairs.targetSceneId === third.sceneId)!;
    restored.sceneId = tower[1].sceneId; restored.player = { ...from.interior, heading: 0 };
    expect(restored.traverseCavePortal()).toBe(true);
    expect(restored.sceneId).toBe(third.sceneId);
    const wilds = restored.entities.filter(entity => entity.kind === 'wild');
    expect(wilds).toHaveLength(15);
    const floorSpecies = new Set(regionalRuntimePools('kanto', 'pokemon-tower', restored.dayPeriod, 'rock', ['3f']).flatMap(pool => pool.slots.map(slot => slot.speciesId)));
    const rare = new Set(regionalSupplementalRules('kanto', 'pokemon-tower', 'rock', 8, { areas: ['3f'], supplemental: third.supplemental }).map(rule => rule.speciesId));
    expect(wilds.every(entity => floorSpecies.has(entity.speciesId) || rare.has(entity.speciesId))).toBe(true);
    expect(wilds.every(entity => entity.level >= 20 + third.levelShift)).toBe(true);

    // Only the anchor floor hosts a dungeon's legendary: Articuno waits on Seafoam B4F.
    const seafoam = dungeonFloors({ regionId: 'kanto', dungeonId: 'seafoam-islands' });
    expect(seafoam.filter(floor => floor.supplemental).map(floor => floor.floorLabel)).toEqual(['지하 4층']);
    const at = (floor: typeof seafoam[number]) => regionalSupplementalRules('kanto', floor.encounterLocationId, 'rock', 8, { areas: floor.encounterAreas, supplemental: floor.supplemental }).map(rule => rule.speciesId);
    expect(at(seafoam.at(-1)!)).toContain(144);
    expect(at(seafoam[0])).toEqual([]);
    const legendaryFloors = [['kanto', 'cerulean-cave', 150, '지하 1층'], ['kanto', 'victory-road', 146, '2층'], ['kanto', 'power-plant', 145, undefined],
      ['johto', 'whirl-islands', 249, '지하 3층'], ['johto', 'bell-tower', 250, '9층']] as const;
    for (const [region, dungeonId, speciesId, label] of legendaryFloors) {
      const anchor = dungeonFloors({ regionId: region, dungeonId }).find(floor => floor.supplemental)!;
      expect(anchor.floorLabel, dungeonId).toBe(label ?? anchor.floorLabel);
      expect(supplementalEncounterRules(region).some(rule => rule.speciesId === speciesId && rule.locationId === anchor.encounterLocationId), dungeonId).toBe(true);
    }
  });

  it('restores older saves inside every historical cave, including the rebuilt Power Plant hall', () => {
    const game = createGame(1, 'legacy-cave-save'), plant = getCaveScene('cave:kanto:power-plant')!;
    const world = new OpenWorldSimulation(graph, game, 7187, undefined, policy);
    world.sceneId = plant.sceneId; (world as any).resetScenePopulation(plant.portals[0].interiorArrival);
    const snapshot = world.snapshot();
    // The old chamber accepted this corner; the hall's machines and walls now cover it.
    const blocked = [{ x: -26, z: -12 }, { x: 24, z: 14 }, ...plant.room!.props.filter(prop => prop.blocking).slice(0, 2)].find(point => plant.sample(point.x, point.z).blocked)!;
    snapshot.player = { x: blocked.x, z: blocked.z, heading: 0 };
    snapshot.entities.find(entity => entity.kind === 'wild')!.x = blocked.x;
    snapshot.entities.find(entity => entity.kind === 'wild')!.z = blocked.z;
    snapshot.foods.push({ id: snapshot.nextFoodId, x: blocked.x, z: blocked.z }); snapshot.nextFoodId++;
    const restored = new OpenWorldSimulation(graph, game, world.seed, snapshot, policy);
    expect(restored.sceneId).toBe(plant.sceneId);
    expect(plant.sample(restored.player.x, restored.player.z).blocked).toBe(false);
    expect(restored.entities.every(entity => !plant.sample(entity.x, entity.z).blocked)).toBe(true);
    expect(restored.foods.every(food => !plant.sample(food.x, food.z).blocked)).toBe(true);
  });

  it('populates, restores and leaves every later-region dungeon floor from its own tables', () => {
    const game = createGame(1, 'later-region-dungeons'), cleared = { badges: [1, 2, 3, 4, 5, 6, 7, 8], league: 5 };
    game.defeatedGyms = [1, 2, 3, 4, 5, 6, 7, 8]; game.player.badges = 8; game.championDefeated = true;
    Object.assign(game.campaign!, { johtoBadges: cleared.badges, johtoLeague: 5, kantoLeague: 5,
      expansion: Object.fromEntries(['hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'hisui', 'paldea'].map(region => [region, structuredClone(cleared)])) });
    const later = CAVE_SCENES.filter(scene => scene.regionId !== 'kanto' && scene.regionId !== 'johto');
    expect(new Set(later.map(scene => scene.regionId))).toEqual(new Set(['hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'hisui', 'paldea']));
    for (const [index, cave] of later.entries()) {
      const world = new OpenWorldSimulation(graph, game, 7400 + index, undefined, policy);
      world.changeRegion(cave.regionId as Parameters<typeof world.changeRegion>[0]);
      const doorway = (cave.portals[0] as CavePortal | undefined) ?? cave.stairs[0];
      world.sceneId = cave.sceneId; (world as any).resetScenePopulation(doorway.interiorArrival);
      const wilds = world.entities.filter(entity => entity.kind === 'wild');
      expect(wilds, cave.sceneId).toHaveLength(cave.wild ? 15 : 0);
      const tables = new Set(expansionEncounterSpecies(cave.regionId as ExpansionRegion, cave.encounterLocationId, 8, world.dayPeriod, 'rock', 20, { areas: cave.encounterAreas, supplemental: cave.supplemental }));
      expect(wilds.every(entity => tables.has(entity.speciesId) || expansionSupplementalRules(cave.regionId as ExpansionRegion).some(rule => rule.speciesId === entity.speciesId)), cave.sceneId).toBe(true);
      const restored = new OpenWorldSimulation(graph, game, world.seed, world.snapshot(), policy);
      expect(restored.sceneId).toBe(cave.sceneId);
      expect(restored.movePlayer({ ...doorway.interior, heading: 0 })).toBe(true);
      expect(restored.traverseCavePortal(), cave.sceneId).toBe(true);
    }
  }, 120_000);

  it('populates, restores and leaves every shipped dungeon floor at the completed-region gate', () => {
    for (const [index, cave] of CAVE_SCENES.filter(scene => scene.regionId === 'kanto' || scene.regionId === 'johto').entries()) {
      const game=createGame(cave.regionId==='kanto'?1:152,`all-caves-${cave.id}`);
      if(cave.regionId==='kanto'){game.defeatedGyms=[1,2,3,4,5,6,7,8];game.player.badges=8;}
      else game.campaign!.johtoBadges=[1,2,3,4,5,6,7,8];
      const world=new OpenWorldSimulation(graph,game,7200+index,undefined,policy);
      if(cave.regionId==='johto')world.changeRegion('johto');
      const doorway=(cave.portals[0] as CavePortal|undefined)??cave.stairs[0];
      world.sceneId=cave.sceneId;(world as any).resetScenePopulation(doorway.interiorArrival);
      const wilds=world.entities.filter(entity=>entity.kind==='wild');
      expect(wilds, cave.sceneId).toHaveLength(cave.wild?15:0);
      expect(world.rosterStatus().total, cave.sceneId).toBe(15);
      expect(wilds.every(entity=>world.locationAt(entity.x,entity.z).id===cave.encounterLocationId&&!world.sampleWorld(entity.x,entity.z).blocked),cave.sceneId).toBe(true);
      const restored=new OpenWorldSimulation(graph,game,world.seed,world.snapshot(),policy);
      expect(restored.sceneId).toBe(cave.sceneId);
      expect(restored.movePlayer({...doorway.interior,heading:0})).toBe(true);
      expect(restored.traverseCavePortal()).toBe(true);
      expect(restored.sceneId).toBe('surfaceSceneId' in doorway?doorway.surfaceSceneId:doorway.targetSceneId);
      expect(restored.rosterStatus().total, cave.sceneId).toBe(15);
    }
  },120_000);
});
