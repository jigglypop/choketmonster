import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { getVersionSpeciesIds } from '../src/data/pokemon-versions';
import { createGame, createMonster } from '../src/game/engine';
import { getWorldAtlas } from '../src/openworld/atlas';
import { OpenWorldSimulation, restoreOpenWorld, serializeOpenWorld, versionEncounters } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;

describe('regional open worlds', () => {
  it('moves with a version, keeps National in place, and persists the regional atlas', () => {
    const game = createGame(1, 'regional-version');
    const world = new OpenWorldSimulation(graph, game, 73_001);
    world.changeVersion('scarlet');

    expect(world.regionId).toBe('paldea');
    expect(world.player).toEqual({ ...getWorldAtlas('paldea').start, heading: 0 });
    expect(world.entities.filter(entity => entity.kind === 'wild').every(entity => getVersionSpeciesIds('scarlet').includes(entity.speciesId))).toBe(true);

    world.changeVersion('national');
    expect(world.regionId).toBe('paldea');
    const restored = restoreOpenWorld(graph, serializeOpenWorld(game, world)).simulation;
    expect(restored.regionId).toBe('paldea');
    expect(restored.snapshot().mapVersion).toBe(getWorldAtlas('paldea').mapVersion);
    expect(restored.sampleWorld(restored.player.x, restored.player.z).blocked).toBe(false);
  });

  it('keeps each region visit list and the owned companion memory across travel', () => {
    const game = createGame(1, 'regional-memory');
    const world = new OpenWorldSimulation(graph, game, 73_002);
    world.visitedTownIds.push('viridian');
    const companionBefore = world.snapshot().entities.find(entity => entity.kind === 'companion')!.brain;

    world.changeRegion('johto');
    expect(game.adventureVersion).toBe('gold');
    expect(world.visitedTownIds).toEqual(['new-bark']);
    expect(world.snapshot().entities.find(entity => entity.kind === 'companion')!.brain).toEqual(companionBefore);

    world.changeRegion('kanto');
    expect(world.visitedTownIds).toEqual(['pallet', 'viridian']);
    expect(world.snapshot().visitedTownsByRegion).toMatchObject({ kanto: ['pallet', 'viridian'], johto: ['new-bark'] });
  });

  it('rejects unknown regions, mismatched map heads, and region changes during battle', () => {
    const game = createGame(1, 'regional-validation');
    const world = new OpenWorldSimulation(graph, game, 73_003);
    const checkpoint = world.snapshot();
    expect(() => new OpenWorldSimulation(graph, game, world.seed, { ...checkpoint, regionId: 'missing' as never })).toThrow(/Unknown world region/);

    world.changeRegion('paldea');
    const paldea = world.snapshot();
    expect(() => new OpenWorldSimulation(graph, game, world.seed, { ...paldea, mapVersion: 'kanto-v2' })).toThrow(/map version/);

    const target = world.entities.find(entity => entity.kind === 'wild')!;
    expect(world.startEncounter(target.id)).toBe(true);
    expect(() => world.changeRegion('johto')).toThrow(/배틀/);
  });

  it('offers the complete version dex across a region without cross-version species', () => {
    const atlas = getWorldAtlas('paldea'), expected = getVersionSpeciesIds('scarlet');
    const encountered = new Set(atlas.locations.flatMap(location => versionEncounters(location.id, 'scarlet', 8, 'paldea')));
    expect([...encountered].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
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
