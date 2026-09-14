import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { hasPokemonModel } from '../src/data/pokemon-models';
import { createGame, createMonster } from '../src/game/engine';
import { VERSIONS } from '../src/data/pokemon-versions';
import { KANTO_LOCATIONS, encountersForLocation } from '../src/openworld/kanto';
import { getWorldAtlas } from '../src/openworld/atlas';
import { OpenWorldSimulation, biomeForSpecies, restoreOpenWorld, serializeOpenWorld, versionEncounters, redEncounters, regionalEncounters, RED_ENCOUNTER_LAYOUT } from '../src/openworld/simulation';
import { getPlayableSpeciesIds, isPlayableSpecies } from '../src/openworld/availability';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;

function moveCheckpointToRegion(world: OpenWorldSimulation, regionId: 'paldea') {
  const checkpoint = world.snapshot(), atlas = getWorldAtlas(regionId), points: Array<{ x: number; z: number }> = [];
  for (let x = -118; x <= 118 && points.length < checkpoint.entities.length + checkpoint.foods.length; x++) {
    for (let z = -118; z <= 118 && points.length < checkpoint.entities.length + checkpoint.foods.length; z++) {
      if (!atlas.sample(x, z).blocked) points.push({ x, z });
    }
  }
  if (points.length < checkpoint.entities.length + checkpoint.foods.length) throw new Error('Regional fixture has too few walkable points');
  checkpoint.regionId = regionId; checkpoint.mapVersion = atlas.mapVersion;
  delete checkpoint.sceneId;
  checkpoint.player = { ...atlas.start, heading: 0 };
  checkpoint.spawnAnchor = { ...atlas.start };
  checkpoint.visitedTownIds = ['cabo-poco'];
  checkpoint.visitedTownsByRegion = { kanto: ['pallet', 'viridian'], paldea: ['cabo-poco'] };
  checkpoint.entities.forEach((entity, index) => Object.assign(entity, points[index]));
  checkpoint.foods.forEach((food, index) => Object.assign(food, points[checkpoint.entities.length + index]));
  return checkpoint;
}

describe('regional open worlds', () => {
  it('normalizes an unsupported new-game version and spawns only species with real models', () => {
    const game = createGame(1, 'regional-version');
    game.adventureVersion = 'scarlet'; game.versionCaught ??= {}; game.versionCaught.scarlet ??= [];
    const world = new OpenWorldSimulation(graph, game, 73_001);
    expect(world.regionId).toBe('kanto');
    expect(game.adventureVersion).toBe('national');
    expect(world.entities.filter(entity => entity.kind === 'wild').every(entity => hasPokemonModel(entity.speciesId) && isPlayableSpecies(entity.speciesId))).toBe(true);
    expect(world.spawnCatalog().map(entry => entry.speciesId)).toEqual(getPlayableSpeciesIds('national'));
    expect(() => world.changeVersion('scarlet')).toThrow(/3D 지역 지도/);
    expect(() => world.changeRegion('paldea')).toThrow(/3D 지역 지도/);
    world.changeVersion('yellow');
    expect(game.adventureVersion).toBe('yellow');
  });

  it('fixes every collection version to the regional FireRed distribution and preserves the roster when switching records', () => {
    const versions = ['national', ...VERSIONS.filter(version => getPlayableSpeciesIds(version.id).length).map(version => version.id)];
    for (const version of versions) for (const badges of [0, 1, 4, 8]) for (const location of KANTO_LOCATIONS) {
      expect(versionEncounters(location.id, version, badges), `${version}:${location.id}:${badges}`).toEqual(regionalEncounters(location.id, badges, 'kanto'));
    }
    const game = createGame(1, 'fixed-red'), source = new OpenWorldSimulation(graph, game, 73009);
    const checkpoint = source.snapshot(), wild = checkpoint.entities.find(entity => entity.kind === 'wild')!;
    checkpoint.selectedWildId = wild.id; checkpoint.selectionPinned = true;
    checkpoint.respawnQueue = [{ id: 'respawn:test', speciesId: wild.speciesId, level: wild.level, biome: biomeForSpecies(wild.speciesId), originX: wild.x, originZ: wild.z, remainingSeconds: 5 }];
    const world = new OpenWorldSimulation(graph, game, source.seed, checkpoint), before = world.snapshot();
    for (const version of versions) { world.changeVersion(version); expect(world.snapshot()).toEqual(before); }
    const national = createGame(1, 'fixed-red'); national.adventureVersion = 'national';
    const red = new OpenWorldSimulation(graph, createGame(1, 'fixed-red'), source.seed);
    expect(new OpenWorldSimulation(graph, national, source.seed).snapshot()).toEqual(red.snapshot());
    expect(game.versionCaught!.red).toEqual([1]);
  }, 15_000);

  it('migrates the expanded roster once while preserving a battle, owned individuals and history', () => {
    const game = createGame(1, 'legacy-national-red'); game.adventureVersion = 'national';
    const owned = createMonster(game, 25, 20); game.player.box.push(owned);
    game.dex.seen.push(25); game.dex.caught.push(25); game.versionCaught = { red: [1], national: [25] };
    const source = new OpenWorldSimulation(graph, game, 73010);
    const wilds = source.entities.filter(entity => entity.kind === 'wild');
    wilds[0].speciesId = 25; expect(source.startEncounter(wilds[0].id)).toBe(true);
    const battle = structuredClone(game.battle), history = structuredClone(game.versionCaught), snapshot = source.snapshot();
    delete snapshot.encounterLayout;
    const remapped = snapshot.entities.find(entity => entity.id === wilds[1].id)!;
    Object.assign(remapped, { speciesId: 150, level: 70 });
    snapshot.respawnQueue = [{ id: 'respawn:old-layout', speciesId: 150, level: 70, biome: 'rock', originX: remapped.x, originZ: remapped.z, remainingSeconds: 5 }];
    const original = structuredClone(snapshot), world = new OpenWorldSimulation(graph, game, source.seed, snapshot);
    const current = world.snapshot(), replacement = current.entities.find(entity => entity.id === remapped.id)!;
    const replacementLocation = getWorldAtlas('kanto').locationAt(replacement.x, replacement.z);
    expect(regionalEncounters(replacementLocation.id, 0, 'kanto')).toContain(replacement.speciesId); expect(replacement.level).toBeGreaterThanOrEqual(replacementLocation.minLevel); expect(replacement.brain).toEqual(remapped.brain);
    expect(current.respawnQueue![0]).toMatchObject({ remainingSeconds: 5 }); expect(current.respawnQueue![0].speciesId).toBeLessThanOrEqual(151);
    expect(current.encounterLayout).toBe(RED_ENCOUNTER_LAYOUT); expect(current.rng).toBe(snapshot.rng);
    expect(game.battle).toEqual(battle); expect(current.entities.find(entity => entity.id === wilds[0].id)!.speciesId).toBe(25);
    expect(game.player.box[0]).toBe(owned); expect(game.versionCaught).toEqual(history); expect(snapshot).toEqual(original);
    // A marked save may contain a legitimate wandering individual outside its original habitat.
    replacement.speciesId = 25;
    const restored = new OpenWorldSimulation(graph, game, source.seed, current);
    expect(restored.snapshot()).toEqual(current);
    expect(redEncounters('route-1', 0)).toEqual([16, 19]);
    expect(() => new OpenWorldSimulation(graph, game, source.seed, { ...current, encounterLayout: 'unknown' as never })).toThrow(/encounter layout/);
  });

  it('rejects unknown regions and mismatched legacy map heads', () => {
    const game = createGame(1, 'regional-validation');
    const world = new OpenWorldSimulation(graph, game, 73_003);
    const checkpoint = world.snapshot();
    expect(() => new OpenWorldSimulation(graph, game, world.seed, { ...checkpoint, regionId: 'missing' as never })).toThrow(/Unknown world region/);
    const paldea = moveCheckpointToRegion(world, 'paldea');
    expect(() => new OpenWorldSimulation(graph, game, world.seed, { ...paldea, mapVersion: 'kanto-v2' })).toThrow(/map version/);
  });

  it('does not expose encounters for a region whose map is not shipped', () => {
    const atlas = getWorldAtlas('paldea');
    const encountered = new Set(atlas.locations.flatMap(location => versionEncounters(location.id, 'scarlet', 8, 'paldea')));
    expect([...encountered]).toEqual([]);
    expect(getPlayableSpeciesIds('national')).toEqual(Array.from({ length: 251 }, (_, index) => index + 1));
    expect(getPlayableSpeciesIds('red')).toEqual(Array.from({ length: 151 }, (_, index) => index + 1));
    expect(getPlayableSpeciesIds('gold')).toEqual(Array.from({ length: 251 }, (_, index) => index + 1));
    expect(getPlayableSpeciesIds('missing')).toEqual([]);
  });

  it('replaces obsolete non-battle wild snapshots while preserving owned species and collection history', () => {
    const game = createGame(1, 'obsolete-wild');
    const owned = createMonster(game, 906, 30); game.player.box.push(owned);
    game.dex.seen.push(906); game.dex.caught.push(906); game.adventureVersion = 'national';
    game.versionCaught ??= {}; game.versionCaught.national = [906];
    const world = new OpenWorldSimulation(graph, game, 73_007);
    const checkpoint = world.snapshot(), obsolete = checkpoint.entities.find(entity => entity.kind === 'wild')!;
    const obsoleteId = obsolete.id, obsoleteBrain = structuredClone(obsolete.brain); obsolete.speciesId = 906;
    checkpoint.respawnQueue = [{ id: 'respawn:obsolete', speciesId: 906, level: 30, biome: biomeForSpecies(906), originX: obsolete.x, originZ: obsolete.z, remainingSeconds: 5 }];

    const restored = new OpenWorldSimulation(graph, game, world.seed, checkpoint);
    const saved = restored.snapshot(), migrated = saved.entities.find(entity => entity.id === obsoleteId)!;
    expect(isPlayableSpecies(migrated.speciesId)).toBe(true);
    expect(migrated.brain).toEqual(obsoleteBrain);
    expect(saved.respawnQueue).toHaveLength(1);
    expect(isPlayableSpecies(saved.respawnQueue![0].speciesId)).toBe(true);
    expect(saved.respawnQueue![0].biome).toBe(biomeForSpecies(saved.respawnQueue![0].speciesId));
    expect(game.player.box.some(monster => monster.instanceId === owned.instanceId && monster.speciesId === 906)).toBe(true);
    expect(game.dex.caught).toContain(906);
    expect(game.versionCaught.national).toContain(906);
    expect(game.logs.at(-1)).toMatch(/저장된 야생 포켓몬을 다시 배치/);
  });

  it('moves a removed-region battle to Kanto without deleting entities, brains, or history', () => {
    const game = createGame(1, 'removed-region-battle');
    const world = new OpenWorldSimulation(graph, game, 73_002);
    const target = world.entities.find(entity => entity.kind === 'wild')!;
    expect(world.startEncounter(target.id)).toBe(true);
    game.adventureVersion = 'scarlet'; game.versionCaught ??= {}; game.versionCaught.scarlet = [1];
    const checkpoint = moveCheckpointToRegion(world, 'paldea');
    const entityMemories = new Map(checkpoint.entities.map(entity => [entity.id, structuredClone(entity.brain)]));

    const restored = new OpenWorldSimulation(graph, game, world.seed, checkpoint);
    const saved = restored.snapshot();
    expect(restored.regionId).toBe('kanto');
    expect(game.adventureVersion).toBe('national');
    expect(restored.player).toEqual({ ...getWorldAtlas('kanto').start, heading: 0 });
    expect(restored.battleWildId).toBe(target.id);
    expect(saved.entities.map(entity => entity.id)).toEqual(checkpoint.entities.map(entity => entity.id));
    for (const entity of saved.entities) expect(entity.brain, entity.id).toEqual(entityMemories.get(entity.id));
    expect(saved.visitedTownsByRegion).toMatchObject({ kanto: ['pallet', 'viridian'], paldea: ['cabo-poco'] });
    expect(game.versionCaught?.scarlet).toEqual([1]);
  });

  it('preserves a capture decision while migrating a removed region', () => {
    const game = createGame(1, 'removed-region-capture');
    const world = new OpenWorldSimulation(graph, game, 73_006);
    const offer = createMonster(game, 25, 4); offer.hp = 0;
    game.captureOffer = offer; game.dex.seen = [...new Set([...game.dex.seen, 25])].sort((a, b) => a - b);
    game.adventureVersion = 'scarlet'; game.versionCaught ??= {}; game.versionCaught.scarlet ??= [];
    const checkpoint = moveCheckpointToRegion(world, 'paldea');

    const restored = new OpenWorldSimulation(graph, game, world.seed, checkpoint);
    expect(restored.regionId).toBe('kanto');
    expect(game.captureOffer?.instanceId).toBe(offer.instanceId);
    expect(game.captureOffer?.hp).toBe(0);
  });

  it('restores pre-region Kanto saves under an expanded version, including an active battle', () => {
    const game = createGame(1, 'legacy-expanded-kanto');
    const world = new OpenWorldSimulation(graph, game, 73_004);
    world.visitedTownIds.push('viridian');
    game.adventureVersion = 'scarlet';
    game.versionCaught ??= {};
    game.versionCaught.scarlet ??= [];
    const target = world.entities.find(entity => entity.kind === 'wild')!;
    expect(world.startEncounter(target.id)).toBe(true);
    const checkpoint = world.snapshot();
    const targetMemory = structuredClone(checkpoint.entities.find(entity => entity.id === target.id)!.brain);
    delete checkpoint.regionId;
    delete checkpoint.visitedTownsByRegion;

    const restored = new OpenWorldSimulation(graph, game, world.seed, checkpoint);
    expect(restored.regionId).toBe('kanto');
    expect(game.adventureVersion).toBe('national');
    expect(game.versionCaught?.scarlet).toEqual([]);
    expect(restored.battleWildId).toBe(target.id);
    expect(restored.visitedTownIds).toEqual(['pallet', 'viridian']);
    expect(restored.snapshot().entities.find(entity => entity.id === target.id)!.brain).toEqual(targetMemory);
  });

  it('does not apply the active atlas collision mask to inactive companion memories', () => {
    const game = createGame(1, 'regional-inactive-memory');
    const boxed = createMonster(game, 1, 5);
    game.player.box.push(boxed);
    const world = new OpenWorldSimulation(graph, game, 73_005);
    const checkpoint = world.snapshot();
    const foreignPoint = (() => {
      for (let x = -120; x <= 120; x += 2) for (let z = -120; z <= 120; z += 2) {
        if (getWorldAtlas('kanto').sample(x, z).blocked && !getWorldAtlas('paldea').sample(x, z).blocked) return { x, z };
      }
      throw new Error('Atlas fixtures need one distinct walkable point');
    })();
    const active = checkpoint.entities.find(entity => entity.kind === 'companion')!;
    checkpoint.companionMemories = [{ ...structuredClone(active), id: `companion:${boxed.instanceId}`, ...foreignPoint }];

    const restored = new OpenWorldSimulation(graph, game, world.seed, checkpoint);
    expect(restored.snapshot().companionMemories).toContainEqual(expect.objectContaining({ id: `companion:${boxed.instanceId}`, ...foreignPoint }));
  });
});
