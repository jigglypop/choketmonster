import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Brain, type Graph } from '../src/core/brain.ts';
import { createGame, createMonster } from '../src/game/engine.ts';
import type { FieldPolicy } from '../src/game/field.ts';
import { OPEN_WORLD_MODEL, OpenWorldSimulation, biomeForSpecies, movementSpeed, nextSpeciesInBiome, restoreOpenWorld, sampleWorld, serializeOpenWorld, speciesForSpawn } from '../src/openworld/simulation.ts';

const loadGraph = async () => JSON.parse(await readFile(new URL('../public/data/connectome.json', import.meta.url), 'utf8')) as Graph;
const loadPolicy = async () => JSON.parse(await readFile(new URL('../public/data/field-policy.json', import.meta.url), 'utf8')) as FieldPolicy;
const loadOpenWorldPolicy = async () => JSON.parse(await readFile(new URL('../public/data/openworld-policy.json', import.meta.url), 'utf8')) as FieldPolicy;
const forceRight = (source: FieldPolicy): FieldPolicy => {
  const policy = structuredClone(source);
  policy.inputWeights = policy.inputWeights.map(row => row.map(() => 0)); policy.inputWeights[0][0] = 10;
  policy.readout = policy.readout.map(row => row.map(() => 0)); policy.readout[1][12] = 10;
  return policy;
};

describe('connectome open world', () => {
  it('runs 15 autonomous wild brains in a deterministic continuous world and covers all 151 species', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(1, 'open-world-roster');
    const world = new OpenWorldSimulation(graph, game, 1001, undefined, policy);
    expect(world.entities.filter(entity => entity.kind === 'wild')).toHaveLength(15);
    expect(world.entities.filter(entity => entity.kind === 'wild').slice(0, 3).every(entity => Math.hypot(entity.x, entity.z) <= 15 && entity.level >= 2 && entity.level <= 3)).toBe(true);
    expect(world.visibleEntities()).toHaveLength(12);
    expect(world.spawnCatalog().map(entry => entry.speciesId)).toEqual(Array.from({ length: 151 }, (_, index) => index + 1));
    expect(Array.from({ length: 151 }, (_, index) => speciesForSpawn(index + 1))).toEqual(Array.from({ length: 151 }, (_, index) => index + 1));
    expect(speciesForSpawn(152)).toBe(1);
    expect(new Set(world.spawnCatalog().map(entry => entry.biome))).toEqual(new Set(['meadow', 'forest', 'lake', 'rock']));
    for (const entry of world.spawnCatalog()) expect(biomeForSpecies(nextSpeciesInBiome(entry.speciesId))).toBe(entry.biome);
    for (const biome of ['meadow', 'forest', 'lake', 'rock'] as const) {
      const species = world.spawnCatalog().filter(entry => entry.biome === biome).map(entry => entry.speciesId), reached = new Set<number>(); let cursor = species[0];
      for (let count = 0; count < species.length; count++) { reached.add(cursor); cursor = nextSpeciesInBiome(cursor); }
      expect(reached).toEqual(new Set(species));
    }
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

  it('maps species Speed to frame-rate independent movement and samples long paths for obstacles', async () => {
    const graph = await loadGraph(), policy = forceRight(await loadPolicy()), game = createGame(1, 'open-world-speed');
    expect(movementSpeed(150)).toBeGreaterThan(movementSpeed(1));
    const source = new OpenWorldSimulation(graph, game, 440, undefined, policy), checkpoint = source.snapshot();
    const zeroBefore = source.entities.map(entity => ({ x: entity.x, z: entity.z })); source.step({ deltaSeconds: 0 });
    expect(source.entities.map(entity => ({ x: entity.x, z: entity.z }))).toEqual(zeroBefore);

    const tracked = checkpoint.entities.find(entity => entity.id === 'wild-1')!;
    tracked.x = -10; tracked.z = 20;
    const short = new OpenWorldSimulation(graph, createGame(1, 'open-world-speed'), 440, structuredClone(checkpoint), policy);
    const long = new OpenWorldSimulation(graph, createGame(1, 'open-world-speed'), 440, structuredClone(checkpoint), policy);
    const shortBefore = short.entities.find(entity => entity.id === tracked.id)!.x, longBefore = long.entities.find(entity => entity.id === tracked.id)!.x;
    short.step({ deltaSeconds: .1 }); long.step({ deltaSeconds: .2 });
    expect(short.entities.find(entity => entity.id === tracked.id)!.x - shortBefore).toBeCloseTo(movementSpeed(tracked.speciesId) * .1, 8);
    expect(long.entities.find(entity => entity.id === tracked.id)!.x - longBefore).toBeCloseTo(movementSpeed(tracked.speciesId) * .2, 8);

    tracked.x = 20; tracked.z = -28;
    const blocked = new OpenWorldSimulation(graph, createGame(1, 'open-world-speed'), 440, structuredClone(checkpoint), policy);
    blocked.step({ deltaSeconds: 5 });
    const stopped = blocked.entities.find(entity => entity.id === tracked.id)!;
    expect(stopped.x).toBe(20); expect(stopped.z).toBe(-28); expect(stopped.collisions).toBeGreaterThan(tracked.collisions);
  });

  it('keeps per-instance learning state isolated and freezes weights during evaluation', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(1, 'open-world-frozen');
    const world = new OpenWorldSimulation(graph, game, 771, undefined, policy);
    const first = world.entities[0].brain, second = world.entities[1].brain;
    expect(first).not.toBe(second); expect(first.activity).not.toBe(second.activity); expect(first.readout).not.toBe(second.readout);
    const before = world.entities.map(entity => ({ id: entity.id, inputWeights: entity.brain.inputWeights, readout: entity.brain.readout, updates: entity.brain.updates }));
    for (let tick = 0; tick < 40; tick++) world.step({ deltaSeconds: .1, learning: false });
    expect(world.entities.map(entity => ({ id: entity.id, inputWeights: entity.brain.inputWeights, readout: entity.brain.readout, updates: entity.brain.updates }))).toEqual(before);
  });

  it('moves one visible partner with bounded collision checks and replays the manual-control hold', async () => {
    const graph = await loadGraph(), policy = await loadOpenWorldPolicy(), game = createGame(1, 'open-world-manual-partner');
    const world = new OpenWorldSimulation(graph, game, 3_131, undefined, policy); world.setAutoHunt(false);
    world.step({ deltaSeconds: .1, learning: true });
    const companion = world.entities.find(entity => entity.kind === 'companion')!, updatesBefore = companion.brain.updates;
    const next = { x: companion.x + movementSpeed(companion.speciesId) * .1, z: companion.z, heading: 1 };
    expect(world.movePartner(next)).toBe(true); expect(world.player).toEqual(next); expect(companion.brain.previous).toBeNull();
    expect(world.movePartner({ ...next, x: next.x + movementSpeed(companion.speciesId) })).toBe(false);
    const checkpointJson = serializeOpenWorld(game, world), a = restoreOpenWorld(graph, checkpointJson, policy), b = restoreOpenWorld(graph, checkpointJson, policy);
    expect(a.simulation.manualControlRemaining).toBeCloseTo(.3); expect(a.simulation.snapshot()).toEqual(b.simulation.snapshot());
    const positionBefore = { x: a.simulation.entities[0].x, z: a.simulation.entities[0].z };
    const stepA = a.simulation.step({ deltaSeconds: .2, learning: true }), stepB = b.simulation.step({ deltaSeconds: .2, learning: true });
    expect(stepA).toEqual(stepB); expect({ x: a.simulation.entities[0].x, z: a.simulation.entities[0].z }).toEqual(positionBefore);
    expect(a.simulation.entities[0].brain.updates).toBe(updatesBefore); expect(a.simulation.syncPlayerToCompanion()).toEqual(a.simulation.player);
  });

  it('uses transformed moves for neural choices and excludes queued manual turns from player learning', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(1, 'open-world-transform');
    game.player.team = [createMonster(game, 1, 16)];
    const player = game.player.team[0], brain = new Brain(991, graph); brain.state.sensoryBypass = false; brain.state.readout.forEach(row => row.fill(0)); player.brain = brain.snapshot();
    const world = new OpenWorldSimulation(graph, game, 912, undefined, policy), target = world.entities.find(entity => entity.kind === 'wild')!;
    world.startEncounter(target.id);
    const form = createMonster(game, 7, 16), transformedMoves = structuredClone(player.moves); transformedMoves.forEach(move => { move.pp = 0; }); transformedMoves[2].pp = 3;
    game.battle!.transformations = { [player.instanceId]: { speciesId: form.speciesId, stats: form.stats, moves: transformedMoves } };
    const automatic = world.step({ deltaSeconds: 1, learning: true }).events.find(event => event.type === 'battle-turn');
    expect(automatic?.type === 'battle-turn' && automatic.result.playerAction).toEqual({ type: 'move', index: 2 });
    expect(game.battle!.transformations![player.instanceId].moves[2].pp).toBe(2);
    player.hp = Math.max(1, player.hp - 1);
    const updatesBeforeManual = player.brain!.updates;
    expect(world.requestAction({ type: 'item', item: 'potion' })).toBe(true);
    const manual = world.step({ deltaSeconds: 1, learning: true }).events.find(event => event.type === 'battle-turn');
    expect(manual?.type === 'battle-turn' && manual.result.playerAction).toEqual({ type: 'item', item: 'potion' });
    expect(player.brain!.updates).toBe(updatesBeforeManual); expect(player.brain!.previous).toBeNull();
  });

  it('retains inactive companion field learning across lead switches and save restore', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(1, 'open-world-companion-memory');
    game.player.team.push(createMonster(game, 4, 5));
    const firstId = game.player.team[0].instanceId, world = new OpenWorldSimulation(graph, game, 733, undefined, policy);
    world.step({ deltaSeconds: .1, learning: true }); world.step({ deltaSeconds: .1, learning: true });
    const learned = world.entities.find(entity => entity.id === `companion:${firstId}`)!.brain, learnedWeights = structuredClone(learned.readout), learnedUpdates = learned.updates;
    game.player.team.reverse(); world.step({ deltaSeconds: 0, learning: false });
    const memory = world.snapshot().companionMemories!.find(entity => entity.id === `companion:${firstId}`)!;
    expect(memory.brain.readout).toEqual(learnedWeights); expect(memory.brain.updates).toBe(learnedUpdates);
    const restored = restoreOpenWorld(graph, serializeOpenWorld(game, world), policy);
    expect(restored.simulation.snapshot().companionMemories).toEqual(world.snapshot().companionMemories);
    restored.game.player.team.reverse(); restored.simulation.step({ deltaSeconds: 0, learning: false });
    const activeAgain = restored.simulation.entities.find(entity => entity.id === `companion:${firstId}`)!;
    expect(activeAgain.brain.readout).toEqual(learnedWeights); expect(activeAgain.brain.updates).toBe(learnedUpdates);
  });

  it('uses actBattle for autonomous victory, experience, money, and eligible evolution', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(1, 'open-world-win');
    game.player.team = [createMonster(game, 1, 16)];
    const world = new OpenWorldSimulation(graph, game, 9, undefined, policy);
    const target = world.entities.filter(entity => entity.kind === 'wild').sort((a, b) => a.level - b.level)[0];
    const beforeXp = game.player.team[0].xp, beforeMoney = game.player.money;
    expect(world.startEncounter(target.id)).toBe(true);
    expect(game.player.team[0].moves).toHaveLength(4);
    game.player.team[0].hp -= 5; const potionBefore = game.inventory.potion;
    expect(world.requestAction({ type: 'item', item: 'potion' })).toBe(true);
    const manual = world.step({ deltaSeconds: 1 }).events.find(event => event.type === 'battle-turn');
    expect(manual?.type === 'battle-turn' && manual.result.playerAction).toEqual({ type: 'item', item: 'potion' });
    expect(game.inventory.potion).toBe(potionBefore - 1);
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
    expect(world.rosterStatus()).toEqual({ alive: 14, pending: 1, total: 15 });
  });

  it('auto-selects, approaches through the connectome, battles for rewards, and restores a delayed replacement', async () => {
    const graph = await loadGraph(), policy = forceRight(await loadPolicy()), game = createGame(1, 'open-world-auto-hunt');
    game.player.team = [createMonster(game, 1, 16)];
    const world = new OpenWorldSimulation(graph, game, 557, undefined, policy), checkpoint = world.snapshot();
    checkpoint.player = { x: 15, z: -24, heading: 2 };
    const companion = checkpoint.entities.find(entity => entity.kind === 'companion')!, target = checkpoint.entities.find(entity => entity.id === 'wild-1')!;
    companion.x = 15; companion.z = -28; target.x = 20; target.z = -28; target.level = 2;
    const hunt = new OpenWorldSimulation(graph, game, 557, checkpoint, policy), companionStart = { x: companion.x, z: companion.z };
    let encounter = false;
    for (let tick = 0; tick < 40 && !game.battle; tick++) {
      const step = hunt.step({ deltaSeconds: .25 }); encounter ||= step.events.some(event => event.type === 'encounter');
      if (tick === 0) expect(hunt.selectedWildId).toBe(target.id);
    }
    const movedCompanion = hunt.entities.find(entity => entity.kind === 'companion')!;
    expect(encounter).toBe(true); expect(movedCompanion.x).toBeGreaterThan(companionStart.x); expect(hunt.player).toEqual(checkpoint.player);
    const moneyBefore = game.player.money, xpBefore = game.player.team[0].xp;
    let outcome: string | undefined;
    for (let turn = 0; turn < 500 && game.battle; turn++) for (const event of hunt.step({ deltaSeconds: 1 }).events) if (event.type === 'battle-turn') outcome = event.result.outcome ?? outcome;
    expect(outcome).toBe('won'); expect(game.player.money).toBeGreaterThan(moneyBefore); expect(game.player.team[0].xp).toBeGreaterThan(xpBefore);
    expect(hunt.rosterStatus()).toEqual({ alive: 14, pending: 1, total: 15 });
    const pendingSave = serializeOpenWorld(game, hunt), restored = restoreOpenWorld(graph, pendingSave, policy);
    expect(restored.simulation.respawnQueue).toEqual(hunt.respawnQueue); expect(restored.simulation.rosterStatus()).toEqual(hunt.rosterStatus());
    restored.simulation.setAutoHunt(false);
    for (let tick = 0; tick < 13; tick++) restored.simulation.step({ deltaSeconds: .5 });
    expect(restored.simulation.rosterStatus()).toEqual({ alive: 15, pending: 0, total: 15 });
    const replacementSpecies = nextSpeciesInBiome(target.speciesId), replacement = restored.simulation.entities.find(entity => entity.kind === 'wild' && entity.id !== target.id && entity.speciesId === replacementSpecies)!;
    expect(replacement).toBeDefined(); expect(sampleWorld(replacement.x, replacement.z).biome).toBe(biomeForSpecies(replacementSpecies));
  });

  it('repeats autonomous hunts and rewards on a held-out seed with the deployed frozen policy', async () => {
    const graph = await loadGraph(), policy = await loadOpenWorldPolicy(), game = createGame(1, 'open-world-heldout-6012044');
    const world = new OpenWorldSimulation(graph, game, 6_012_044, undefined, policy, 12);
    const fieldWeights = world.entities.map(entity => ({ readout: entity.brain.readout, updates: entity.brain.updates }));
    const moneyBefore = game.player.money, xpBefore = game.player.team[0].xp; let encounters = 0, wins = 0, replacements = 0, previousPending = 0, moneyRewards = 0;
    for (let tick = 0; tick < 200; tick++) {
      const beforeStep = game.player.money, step = world.step({ deltaSeconds: .25, learning: false });
      moneyRewards += Math.max(0, game.player.money - beforeStep); encounters += step.events.filter(event => event.type === 'encounter').length;
      wins += step.events.filter(event => event.type === 'battle-turn' && event.result.outcome === 'won').length;
      const pending = world.rosterStatus().pending; if (pending < previousPending) replacements += previousPending - pending; previousPending = pending;
    }
    expect(encounters).toBeGreaterThanOrEqual(2); expect(wins).toBeGreaterThanOrEqual(1); expect(replacements).toBeGreaterThanOrEqual(2);
    expect(moneyRewards).toBeGreaterThan(0); expect(game.player.team[0].xp).toBeGreaterThan(xpBefore); expect(game.player.money).not.toBe(moneyBefore);
    expect(world.rosterStatus().total).toBe(12);
    expect(world.entities.map(entity => ({ readout: entity.brain.readout, updates: entity.brain.updates }))).toEqual(fieldWeights);
  }, 15_000);

  it('round-trips a graph-deduplicated save and replays exactly during battle', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(4, 'open-world-replay');
    const world = new OpenWorldSimulation(graph, game, 8080, undefined, policy), target = world.entities.find(entity => entity.kind === 'wild')!;
    world.selectWild(target.id); world.startEncounter(target.id); world.step({ deltaSeconds: .4 }); world.requestAction({ type: 'move', index: 0 });
    const json = serializeOpenWorld(game, world);
    expect(json).not.toContain('"edges"'); expect(JSON.parse(json).world.model).toBe(OPEN_WORLD_MODEL);
    const a = restoreOpenWorld(graph, json, policy), b = restoreOpenWorld(graph, json, policy);
    const traceA = Array.from({ length: 10 }, () => a.simulation.step({ deltaSeconds: .2 }));
    const traceB = Array.from({ length: 10 }, () => b.simulation.step({ deltaSeconds: .2 }));
    expect(traceA).toEqual(traceB); expect(a.simulation.snapshot()).toEqual(b.simulation.snapshot()); expect(a.game).toEqual(b.game);
  });
});
