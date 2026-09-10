import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain.ts';
import { createGame, createMonster } from '../src/game/engine.ts';
import type { FieldPolicy } from '../src/game/field.ts';
import { OPEN_WORLD_MODEL, OpenWorldSimulation, biomeForSpecies, restoreOpenWorld, sampleWorld, serializeOpenWorld, speciesForSpawn } from '../src/openworld/simulation.ts';

const loadGraph = async () => JSON.parse(await readFile(new URL('../public/data/connectome.json', import.meta.url), 'utf8')) as Graph;
const loadPolicy = async () => JSON.parse(await readFile(new URL('../public/data/field-policy.json', import.meta.url), 'utf8')) as FieldPolicy;

describe('connectome open world', () => {
  it('runs 15 autonomous wild brains in a deterministic continuous world and covers all 151 species', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(1, 'open-world-roster');
    const world = new OpenWorldSimulation(graph, game, 1001, undefined, policy);
    expect(world.entities.filter(entity => entity.kind === 'wild')).toHaveLength(15);
    expect(world.visibleEntities()).toHaveLength(12);
    expect(world.spawnCatalog().map(entry => entry.speciesId)).toEqual(Array.from({ length: 151 }, (_, index) => index + 1));
    expect(Array.from({ length: 151 }, (_, index) => speciesForSpawn(index + 1))).toEqual(Array.from({ length: 151 }, (_, index) => index + 1));
    expect(speciesForSpawn(152)).toBe(1);
    expect(new Set(world.spawnCatalog().map(entry => entry.biome))).toEqual(new Set(['meadow', 'forest', 'lake', 'rock']));
    expect(biomeForSpecies(10)).toBe('forest'); expect(sampleWorld(42, -28).blocked).toBe(true);
    for (let tick = 0; tick < 30; tick++) world.step({ deltaSeconds: .1 });
    for (const entity of world.entities) {
      expect(entity.observation).toHaveLength(12); expect(entity.brain.graph.id).toBe(graph.id);
      expect(entity.brain.sensoryBypass).toBe(false); expect(entity.action).toBeGreaterThanOrEqual(0); expect(entity.action).toBeLessThanOrEqual(4);
      expect(sampleWorld(entity.x, entity.z).blocked).toBe(false);
      expect(entity.brain.graph).toBe(world.graph);
    }
    expect(JSON.stringify(world.snapshot())).not.toContain('"edges"');
  });

  it('uses actBattle for autonomous victory, experience, money, and eligible evolution', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(1, 'open-world-win');
    game.player.team = [createMonster(game, 1, 16)];
    const world = new OpenWorldSimulation(graph, game, 9, undefined, policy);
    const target = world.entities.filter(entity => entity.kind === 'wild').sort((a, b) => a.level - b.level)[0];
    const beforeXp = game.player.team[0].xp, beforeMoney = game.player.money;
    expect(world.startEncounter(target.id)).toBe(true);
    let outcome: string | undefined;
    for (let turn = 0; turn < 500 && game.battle; turn++) {
      for (const event of world.step({ deltaSeconds: 1 }).events) if (event.type === 'battle-turn') outcome = event.result.outcome ?? outcome;
    }
    expect(outcome).toBe('won'); expect(game.player.money).toBeGreaterThan(beforeMoney); expect(game.player.team[0].xp).toBeGreaterThan(beforeXp);
    expect(game.player.team[0].speciesId).toBe(2); expect(game.player.team[0].moves.length).toBeLessThanOrEqual(4);
  });

  it('captures a wild Pokemon through the engine probability and ball inventory path', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(7, 'open-world-catch');
    const world = new OpenWorldSimulation(graph, game, 345, undefined, policy);
    const target = world.entities.find(entity => entity.kind === 'wild' && entity.speciesId === 10)!;
    expect(world.startEncounter(target.id)).toBe(true);
    let outcome: string | undefined;
    for (let attempt = 0; attempt < 8 && game.battle; attempt++) {
      expect(world.requestCapture('poke-ball')).toBe(true);
      for (const event of world.step({ deltaSeconds: 1 }).events) if (event.type === 'battle-turn') outcome = event.result.outcome ?? outcome;
    }
    expect(outcome).toBe('caught'); expect(game.dex.caught).toContain(10); expect(game.inventory['poke-ball']).toBeLessThan(8);
    expect(world.entities.filter(entity => entity.kind === 'wild')).toHaveLength(15);
  });

  it('round-trips a graph-deduplicated save and replays exactly during battle', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(4, 'open-world-replay');
    const world = new OpenWorldSimulation(graph, game, 8080, undefined, policy), target = world.entities.find(entity => entity.kind === 'wild')!;
    world.selectWild(target.id); world.startEncounter(target.id); world.step({ deltaSeconds: .4 });
    const json = serializeOpenWorld(game, world);
    expect(json).not.toContain('"edges"'); expect(JSON.parse(json).world.model).toBe(OPEN_WORLD_MODEL);
    const a = restoreOpenWorld(graph, json, policy), b = restoreOpenWorld(graph, json, policy);
    const traceA = Array.from({ length: 10 }, () => a.simulation.step({ deltaSeconds: .2 }));
    const traceB = Array.from({ length: 10 }, () => b.simulation.step({ deltaSeconds: .2 }));
    expect(traceA).toEqual(traceB); expect(a.simulation.snapshot()).toEqual(b.simulation.snapshot()); expect(a.game).toEqual(b.game);
  });
});
