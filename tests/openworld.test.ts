import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Brain, type Graph } from '../src/core/brain.ts';
import { createGame, createMonster } from '../src/game/engine.ts';
import type { FieldPolicy } from '../src/game/field.ts';
import { OPEN_WORLD_MODEL, OpenWorldSimulation, movementSpeed, regionalEncounters, restoreOpenWorld, sampleWorld, serializeOpenWorld } from '../src/openworld/simulation.ts';
import { KANTO_LOCATIONS, KANTO_START } from '../src/openworld/kanto.ts';
import { getWorldAtlas } from '../src/openworld/atlas.ts';
import { regionalRuntimePools, supplementalEncounterRules } from '../src/data/regional-encounters.ts';
import { regionalWildLevels } from '../src/game/campaign.ts';

const loadGraph = async () => JSON.parse(await readFile(new URL('../public/data/connectome.json', import.meta.url), 'utf8')) as Graph;
const loadPolicy = async () => JSON.parse(await readFile(new URL('../public/data/field-policy.json', import.meta.url), 'utf8')) as FieldPolicy;
const loadOpenWorldPolicy = async () => JSON.parse(await readFile(new URL('../public/data/openworld-policy.json', import.meta.url), 'utf8')) as FieldPolicy;
const forceRight = (source: FieldPolicy): FieldPolicy => {
  const policy = structuredClone(source);
  policy.inputWeights = policy.inputWeights.map(row => row.map(() => 0)); policy.inputWeights[0][0] = 10;
  policy.readout = policy.readout.map(row => row.map(() => 0)); policy.readout[1][12] = 10;
  return policy;
};

const atlas = getWorldAtlas('kanto');
const REMOTE_FIXTURE_POINTS = atlas.locations.filter(location => location.kind !== 'town')
  .map(location => atlas.nearestWalkable(location.x, location.z, 8)!)
  .filter(point => point && atlas.locationAt(point.x, point.z).kind !== 'town' && Math.hypot(point.x + 90, point.z + 24) > 60);

function engageWildAtLocation(world: OpenWorldSimulation, id: string) {
  const target = world.entities.find(entity => entity.id === id)!;
  world.player = { x: target.x, z: target.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  return world.startEncounter(id);
}

describe('connectome open world', () => {
  it('runs 15 autonomous wild brains in deterministic local Kanto encounter tables', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(1, 'open-world-roster');
    const world = new OpenWorldSimulation(graph, game, 1001, undefined, policy);
    const wilds = world.entities.filter(entity => entity.kind === 'wild');
    expect(wilds).toHaveLength(15);
    expect(new Set(wilds.map(entity => entity.id)).size).toBe(15);
    expect(world.player).toEqual({ ...KANTO_START, heading: 0 });
    expect(world.visibleEntities()).toHaveLength(12);
    for (const entity of wilds) {
      const location = getWorldAtlas('kanto').locationAt(entity.x, entity.z);
      expect(regionalEncounters(location.id, game.player.badges, 'kanto')).toContain(entity.speciesId);
      const biome = getWorldAtlas('kanto').sample(entity.x, entity.z).biome;
      const sourceSlots = regionalRuntimePools('kanto', location.id, world.dayPeriod, biome).flatMap(pool => pool.slots).filter(slot => slot.speciesId === entity.speciesId);
      const balanced=regionalWildLevels(game,'kanto',location);
      const supplemental = Number(entity.id.slice(5)) % 20 === 0 && supplementalEncounterRules('kanto').some(rule => rule.speciesId === entity.speciesId && rule.locationId === location.id && rule.biome === biome && rule.requiredBadges <= game.player.badges);
      expect((sourceSlots.length>0&&entity.level>=balanced.minLevel&&entity.level<=balanced.maxLevel) || supplemental).toBe(true);
    }
    const replay = new OpenWorldSimulation(graph, createGame(1, 'open-world-roster'), 1001, undefined, policy);
    expect(replay.snapshot()).toEqual(world.snapshot());
    for (let tick = 0; tick < 30; tick++) world.step({ deltaSeconds: .1 });
    for (const entity of world.entities) {
      expect(entity.observation).toHaveLength(12); expect(entity.brain.graph.id).toBe(graph.id);
      expect(entity.brain.sensoryBypass).toBe(false); expect(entity.action).toBeGreaterThanOrEqual(0); expect(entity.action).toBeLessThanOrEqual(4);
      expect(sampleWorld(entity.x, entity.z).blocked).toBe(false);
      expect(entity.brain.graph).toBe(world.graph);
    }
    expect(JSON.stringify(world.snapshot())).not.toContain('"edges"');
  });

  it('repairs a short saved roster while preserving every saved wild brain across another restore', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(1, 'short-roster-restore');
    const source = new OpenWorldSimulation(graph, game, 24_680, undefined, policy);
    const raw = JSON.parse(serializeOpenWorld(game, source));
    raw.world.entities = raw.world.entities.filter((entity: { kind: string }) => entity.kind === 'companion')
      .concat(raw.world.entities.filter((entity: { kind: string }) => entity.kind === 'wild').slice(0, 8));
    raw.world.respawnQueue = [];
    const savedWilds = new Map(raw.world.entities.filter((entity: { kind: string }) => entity.kind === 'wild').map((entity: { id: string; brain: unknown }) => [entity.id, entity.brain]));

    const repaired = restoreOpenWorld(graph, JSON.stringify(raw), policy);
    expect(repaired.simulation.rosterStatus()).toEqual({ alive: 12, pending: 0, total: 12 });
    for (const [id, brain] of savedWilds) expect(repaired.simulation.snapshot().entities.find(entity => entity.id === id)?.brain).toEqual(brain);
    const restoredAgain = restoreOpenWorld(graph, serializeOpenWorld(repaired.game, repaired.simulation), policy);
    expect(restoredAgain.simulation.snapshot()).toEqual(repaired.simulation.snapshot());
  });

  it('requires the actual partner model before manual movement and ignores stale species callbacks', async () => {
    const graph = await loadGraph(), game = createGame(1, 'required-model');
    const world = new OpenWorldSimulation(graph, game, 731);
    const companion = world.entities.find(entity => entity.kind === 'companion')!;
    world.requireReadyModels();
    expect(world.modelsReady).toBe(false);
    const start = { ...world.player };
    expect(world.movePartner({ ...start, x: start.x + .1 })).toBe(false);
    world.step({ deltaSeconds: 1 }); expect(world.player).toEqual(start);
    world.setModelStatus(companion.id, 'ready', 4);
    expect(world.modelsReady).toBe(false);
    world.setModelStatus(companion.id, 'failed');
    world.setModelStatus(companion.id, 'untracked');
    expect(world.modelStatus(companion.id)).toBe('failed');
    world.setModelStatus(companion.id, 'ready');
    expect(world.modelsReady).toBe(true);
    world.setModelStatus(companion.id, 'untracked');
    expect(world.modelsReady).toBe(false);
  });

  it('quarantines a creature whose visible 3D model is loading or failed', async () => {
    const graph = await loadGraph(), policy = forceRight(await loadPolicy()), game = createGame(1, 'model-load-quarantine');
    const world = new OpenWorldSimulation(graph, game, 51_804, undefined, policy);
    const wild = world.entities.find(entity => entity.kind === 'wild')!;
    const before = { x: wild.x, z: wild.z };
    world.setModelStatus(wild.id, 'loading');
    const loading = world.step({ deltaSeconds: .5 }).events.find(event => event.entityId === wild.id);
    expect({ x: wild.x, z: wild.z }).toEqual(before);
    expect(loading).toMatchObject({ type: 'wait', reward: 0 });
    expect(engageWildAtLocation(world, wild.id)).toBe(false);
    world.setModelStatus(wild.id, 'failed');
    expect(world.modelStatus(wild.id)).toBe('failed');
    expect(world.canEngageWild(wild.id)).toBe(false);
    world.setModelStatus(wild.id, 'ready');
    expect(world.modelStatus(wild.id)).toBeUndefined();
    expect(world.startEncounter(wild.id)).toBe(true);
  });

  it('rotates healthy team members into automatic wild battles and persists the next slot', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(1, 'automatic-team-rotation');
    game.player.team.push(createMonster(game, 4, 5), createMonster(game, 7, 5));
    const world = new OpenWorldSimulation(graph, game, 93_112, undefined, policy);
    const wilds = world.entities.filter(entity => entity.kind === 'wild');
    expect(engageWildAtLocation(world, wilds[0].id)).toBe(true);
    expect(game.battle?.player.activeIndex).toBe(0);
    expect(world.snapshot().nextBattleTeamIndex).toBe(1);
    game.battle!.enemy.team[0].hp = 0;
    world.step({ deltaSeconds: 1, learning: false });
    expect(engageWildAtLocation(world, wilds[1].id)).toBe(true);
    expect(game.battle?.player.activeIndex).toBe(1);
    const restored = restoreOpenWorld(graph, serializeOpenWorld(game, world), policy);
    expect(restored.simulation.nextBattleTeamIndex).toBe(2);
  });

  it('maps species Speed to frame-rate independent movement and samples long paths for obstacles', async () => {
    const graph = await loadGraph(), policy = forceRight(await loadPolicy()), game = createGame(1, 'open-world-speed');
    expect(movementSpeed(150)).toBeGreaterThan(movementSpeed(1));
    const source = new OpenWorldSimulation(graph, game, 440, undefined, policy), checkpoint = source.snapshot();
    const zeroBefore = source.entities.map(entity => ({ x: entity.x, z: entity.z })); source.step({ deltaSeconds: 0 });
    expect(source.entities.map(entity => ({ x: entity.x, z: entity.z }))).toEqual(zeroBefore);

    const tracked = checkpoint.entities.find(entity => entity.id === 'wild-1')!;
    tracked.x = -136; tracked.z = 132;
    const short = new OpenWorldSimulation(graph, createGame(1, 'open-world-speed'), 440, structuredClone(checkpoint), policy);
    const long = new OpenWorldSimulation(graph, createGame(1, 'open-world-speed'), 440, structuredClone(checkpoint), policy);
    const shortBefore = short.entities.find(entity => entity.id === tracked.id)!.x, longBefore = long.entities.find(entity => entity.id === tracked.id)!.x;
    short.step({ deltaSeconds: .1 }); long.step({ deltaSeconds: .2 });
    expect(short.entities.find(entity => entity.id === tracked.id)!.x - shortBefore).toBeCloseTo(movementSpeed(tracked.speciesId) * .1, 8);
    expect(long.entities.find(entity => entity.id === tracked.id)!.x - longBefore).toBeCloseTo(movementSpeed(tracked.speciesId) * .2, 8);

    tracked.x = -136; tracked.z = 132;
    const blocked = new OpenWorldSimulation(graph, createGame(1, 'open-world-speed'), 440, structuredClone(checkpoint), policy);
    blocked.step({ deltaSeconds: 5 });
    const stopped = blocked.entities.find(entity => entity.id === tracked.id)!;
    expect(stopped.x).toBeCloseTo(-136); expect(stopped.z).toBe(132); expect(stopped.collisions).toBeGreaterThan(tracked.collisions);
  });

  it('loads new local individuals only after traveling without changing surviving brains', async () => {
    const graph = await loadGraph(), policy = await loadOpenWorldPolicy();
    for (const seed of [4_401, 4_501, 4_601]) {
      const game = createGame(1, `open-world-density-${seed}`), world = new OpenWorldSimulation(graph, game, seed, undefined, policy); world.setAutoHunt(false);
      const before = new Map(world.entities.filter(entity => entity.kind === 'wild').map(entity => [entity.id, { x: entity.x, z: entity.z, readout: structuredClone(entity.brain.readout), updates: entity.brain.updates }]));
      expect(world.movePlayer({ x: -136, z: -14, heading: 0 })).toBe(true);
      Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
      world.setControlMode('manual');
      for (let tick = 0; tick < 7; tick++) world.step({ deltaSeconds: .5, learning: false });
      expect(world.nearbyWildCount(38)).toBeGreaterThanOrEqual(4);
      const nearby = world.entities.filter(entity => entity.kind === 'wild' && Math.hypot(entity.x - world.player.x, entity.z - world.player.z) <= 38);
      expect(nearby.every(entity => !sampleWorld(entity.x, entity.z).blocked)).toBe(true);
      const streamed = nearby.filter(entity => !before.has(entity.id));
      expect(streamed.length).toBeGreaterThanOrEqual(4);
      for (const entity of world.entities.filter(entity => before.has(entity.id))) {
        expect(entity.brain.readout).toEqual(before.get(entity.id)!.readout);
        expect(entity.brain.updates).toBe(before.get(entity.id)!.updates);
      }
      const json = serializeOpenWorld(game, world), a = restoreOpenWorld(graph, json, policy), b = restoreOpenWorld(graph, json, policy);
      const traceA = Array.from({ length: 8 }, () => a.simulation.step({ deltaSeconds: .4, learning: false })), traceB = Array.from({ length: 8 }, () => b.simulation.step({ deltaSeconds: .4, learning: false }));
      expect(traceA).toEqual(traceB); expect(a.simulation.snapshot()).toEqual(b.simulation.snapshot());
    }
  }, 15_000);

  it('never rerolls distant Red encounters on a timer and restores old saves without the adjustment', async () => {
    const graph = await loadGraph(), policy = await loadOpenWorldPolicy();
    const game = createGame(1, 'red-stationary'), source = new OpenWorldSimulation(graph, game, 4401, undefined, policy);
    const snapshot = source.snapshot();
    snapshot.player = { x: -136, z: -14, heading: 0 };
    Object.assign(snapshot.entities.find(entity => entity.kind === 'companion')!, snapshot.player);
    delete snapshot.spawnAnchor; snapshot.densityRemaining = .01;
    snapshot.autoHunt = false; snapshot.controlMode = 'manual';
    const world = new OpenWorldSimulation(graph, game, source.seed, snapshot, policy);
    const ids = world.entities.map(entity => entity.id), serial = world.spawnSerial;
    for (let tick = 0; tick < 24; tick++) world.step({ deltaSeconds: .5, learning: false });
    expect(world.spawnSerial).toBe(serial); expect(world.entities.map(entity => entity.id)).toEqual(ids);
    expect(world.snapshot().densityRemaining).toBeUndefined();
    expect(world.snapshot().spawnAnchor).toMatchObject({ x: -136, z: -14 });
    const restored = restoreOpenWorld(graph, serializeOpenWorld(game, world), policy);
    expect(restored.simulation.snapshot()).toEqual(world.snapshot());
    const bad = world.snapshot(); bad.spawnAnchor = { x: NaN, z: 0 };
    expect(() => new OpenWorldSimulation(graph, game, world.seed, bad, policy)).toThrow(/anchor/);
  });

  it('keeps per-instance learning state isolated and freezes weights during evaluation', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(1, 'open-world-frozen');
    const world = new OpenWorldSimulation(graph, game, 771, undefined, policy);
    const first = world.entities[0].brain, second = world.entities[1].brain;
    expect(first).not.toBe(second); expect(first.activity).not.toBe(second.activity); expect(first.readout).not.toBe(second.readout);
    const before = new Map(world.entities.map(entity => [entity.id, structuredClone({ inputWeights: entity.brain.inputWeights, readout: entity.brain.readout, updates: entity.brain.updates })]));
    for (let tick = 0; tick < 40; tick++) world.step({ deltaSeconds: .1, learning: false });
    for (const entity of world.entities) {
      expect(entity.brain.updates).toBe(0);
      if (before.has(entity.id)) expect({ inputWeights: entity.brain.inputWeights, readout: entity.brain.readout, updates: entity.brain.updates }).toEqual(before.get(entity.id));
    }
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
    const player = game.player.team[0], brain = new Brain(991, graph); brain.state.sensoryBypass = false;
    brain.state.inputWeights.forEach(row => { row.fill(0); row[0] = 1; });
    brain.state.readout.forEach((row, action) => { row.fill(0); for (let i = 12; i < row.length; i++) row[i] = action === 2 ? 1 : -1; });
    player.brain = brain.snapshot();
    const world = new OpenWorldSimulation(graph, game, 912, undefined, policy), target = world.entities.find(entity => entity.kind === 'wild')!;
    engageWildAtLocation(world, target.id);
    const form = createMonster(game, 7, 16), transformedMoves = [{ moveId: 45, pp: 0 }, { moveId: 39, pp: 0 }, { moveId: 14, pp: 0 }];
    game.battle!.transformations = { [player.instanceId]: { speciesId: form.speciesId, stats: form.stats, moves: transformedMoves } };
    const automatic = world.step({ deltaSeconds: 1, learning: true }).events.find(event => event.type === 'battle-turn');
    expect(automatic?.type === 'battle-turn' && automatic.result.playerAction).toEqual({ type: 'move', index: 2 });
    expect(automatic?.type === 'battle-turn' && automatic.result.executedMoves.find(move => move.actorInstanceId === player.instanceId)).toMatchObject({ moveId: 14, category: 'buff', strategicEffect: true });
    expect(game.battle!.transformations![player.instanceId].moves[2].pp).toBe(0);
    expect(player.moveLearning?.[14]).toMatchObject({ choices: 1, executed: 1, effective: 1 });
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
    expect(engageWildAtLocation(world, target.id)).toBe(true);
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
    const target = world.entities.find(entity => entity.kind === 'wild')!, targetSpecies = target.speciesId;
    expect(engageWildAtLocation(world, target.id)).toBe(true);
    let outcome: string | undefined;
    for (let attempt = 0; attempt < 8 && game.battle; attempt++) {
      expect(world.requestCapture('poke-ball')).toBe(true);
      for (const event of world.step({ deltaSeconds: 1 }).events) if (event.type === 'battle-turn') outcome = event.result.outcome ?? outcome;
    }
    expect(outcome).toBe('caught'); expect(game.dex.caught).toContain(targetSpecies); expect(game.inventory['poke-ball']).toBeLessThan(8);
    expect(world.rosterStatus()).toEqual({ alive: 14, pending: 1, total: 15 });
  });

  it('auto mode replaces a pinned distant target with the nearest wild even without balls or a legacy hunt flag', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(1, 'one-auto-mode');
    const initial = new OpenWorldSimulation(graph, game, 557, undefined, policy), checkpoint = initial.snapshot();
    checkpoint.controlMode = 'manual'; checkpoint.autoHunt = false;
    checkpoint.player = { x: -90, z: -24, heading: 1 }; checkpoint.spawnAnchor = { ...checkpoint.player };
    const companion = checkpoint.entities.find(entity => entity.kind === 'companion')!;
    Object.assign(companion, checkpoint.player);
    const wilds = checkpoint.entities.filter(entity => entity.kind === 'wild');
    wilds.forEach((entity, index) => Object.assign(entity, REMOTE_FIXTURE_POINTS[index]));
    Object.assign(wilds[0], { x: -89, z: -24 });
    checkpoint.selectedWildId = wilds[1].id; checkpoint.selectionPinned = true;
    game.inventory['poke-ball'] = game.inventory['great-ball'] = game.inventory['ultra-ball'] = 0;
    const world = new OpenWorldSimulation(graph, game, 557, checkpoint, policy);
    world.step({ deltaSeconds: 0 }); expect(game.battle).toBeUndefined();
    world.setControlMode('auto');
    expect(world.selectionPinned).toBe(false);
    expect(world.step({ deltaSeconds: 0 }).events).toContainEqual(expect.objectContaining({ type: 'encounter', entityId: wilds[0].id }));
    expect(world.battleWildId).toBe(wilds[0].id);
    expect(world.autoHunt).toBe(true);
    const saved = world.snapshot(); saved.autoHunt = false;
    expect(new OpenWorldSimulation(graph, game, 557, saved, policy).autoHunt).toBe(true);
  });

  it('auto-selects, approaches through the connectome, battles for rewards, and restores a delayed replacement', async () => {
    const graph = await loadGraph(), policy = forceRight(await loadPolicy()), game = createGame(1, 'open-world-auto-hunt');
    game.player.team = [createMonster(game, 150, 16)];
    const world = new OpenWorldSimulation(graph, game, 557, undefined, policy), checkpoint = world.snapshot();
    checkpoint.player = { x: -92, z: -24, heading: 1 };
    checkpoint.spawnAnchor = { x: checkpoint.player.x, z: checkpoint.player.z };
    const companion = checkpoint.entities.find(entity => entity.kind === 'companion')!, target = checkpoint.entities.find(entity => entity.id === 'wild-1')!;
    companion.x = -90; companion.z = -24; target.x = -80; target.z = -24; target.speciesId = 10; target.level = 2;
    checkpoint.entities.filter(entity => entity.kind === 'wild' && entity.id !== target.id).forEach((entity, index) => Object.assign(entity, REMOTE_FIXTURE_POINTS[index]));
    const hunt = new OpenWorldSimulation(graph, game, 557, checkpoint, policy), companionStart = { x: companion.x, z: companion.z };
    let encounter = false;
    for (let tick = 0; tick < 40 && !game.battle; tick++) {
      const step = hunt.step({ deltaSeconds: .25 }); encounter ||= step.events.some(event => event.type === 'encounter');
      if (tick === 0) expect(hunt.selectedWildId).toBe(target.id);
    }
    const movedCompanion = hunt.entities.find(entity => entity.kind === 'companion')!;
    expect(encounter).toBe(true); expect(movedCompanion.x).toBeGreaterThan(companionStart.x); expect(hunt.player).toEqual({ x: movedCompanion.x, z: movedCompanion.z, heading: movedCompanion.heading });
    const moneyBefore = game.player.money, xpBefore = game.player.team[0].xp;
    let outcome: string | undefined;
    for (let turn = 0; turn < 500 && game.battle; turn++) for (const event of hunt.step({ deltaSeconds: 1 }).events) if (event.type === 'battle-turn') outcome = event.result.outcome ?? outcome;
    expect(outcome).toBe('won'); expect(game.player.money).toBeGreaterThan(moneyBefore); expect(game.player.team[0].xp).toBeGreaterThan(xpBefore);
    expect(hunt.rosterStatus()).toEqual({ alive: 14, pending: 1, total: 15 });
    const pendingSave = serializeOpenWorld(game, hunt), restored = restoreOpenWorld(graph, pendingSave, policy);
    expect(restored.simulation.respawnQueue).toEqual(hunt.respawnQueue); expect(restored.simulation.rosterStatus()).toEqual(hunt.rosterStatus());
    restored.simulation.releaseVictory();
    restored.simulation.setAutoHunt(false); restored.simulation.setControlMode('manual');
    const idsBeforeRespawn = new Set(restored.simulation.entities.filter(entity => entity.kind === 'wild').map(entity => entity.id));
    for (let tick = 0; tick < 13 && restored.simulation.rosterStatus().pending; tick++) restored.simulation.step({ deltaSeconds: .5 });
    expect(restored.simulation.rosterStatus()).toEqual({ alive: 15, pending: 0, total: 15 });
    const replacement = restored.simulation.entities.find(entity => entity.kind === 'wild' && !idsBeforeRespawn.has(entity.id))!;
    expect(replacement).toBeDefined();
    const replacementLocation = getWorldAtlas('kanto').locationAt(replacement.x, replacement.z);
    expect(regionalEncounters(replacementLocation.id, game.player.badges, 'kanto')).toContain(replacement.speciesId);
  });

  it('repeats autonomous hunts and rewards on a held-out seed with the deployed frozen policy', async () => {
    const graph = await loadGraph(), policy = forceRight(await loadOpenWorldPolicy()), game = createGame(1, 'open-world-heldout-6012044');
    game.player.team = [createMonster(game, 150, 19, 'kanto')];
    const source = new OpenWorldSimulation(graph, game, 6_012_044, undefined, policy, 12), checkpoint = source.snapshot();
    checkpoint.player = { x: -92, z: -24, heading: 1 };
    checkpoint.spawnAnchor = { x: checkpoint.player.x, z: checkpoint.player.z };
    const companion = checkpoint.entities.find(entity => entity.kind === 'companion')!;
    companion.x = -90; companion.z = -24;
    checkpoint.entities.filter(entity => entity.kind === 'wild').slice(0, 2).forEach((entity, index) => {
      entity.x = -80 + index * 12; entity.z = -24; entity.speciesId = 10; entity.level = 2;
    });
    checkpoint.entities.filter(entity => entity.kind === 'wild').slice(2).forEach((entity, index) => Object.assign(entity, REMOTE_FIXTURE_POINTS[index]));
    const world = new OpenWorldSimulation(graph, game, 6_012_044, checkpoint, policy, 12);
    world.setAutoCapture(true);
    const moneyBefore = game.player.money, xpBefore = game.player.team[0].xp; let encounters = 0, wins = 0, replacements = 0, previousPending = 0, moneyRewards = 0;
    for (let tick = 0; tick < 400; tick++) {
      const beforeStep = game.player.money, step = world.step({ deltaSeconds: .25, learning: false });
      moneyRewards += Math.max(0, game.player.money - beforeStep); encounters += step.events.filter(event => event.type === 'encounter').length;
      wins += step.events.filter(event => event.type === 'battle-turn' && event.result.outcome === 'won').length;
      const pending = world.rosterStatus().pending; if (pending < previousPending) replacements += previousPending - pending; previousPending = pending;
    }
    expect(encounters).toBeGreaterThanOrEqual(2); expect(wins).toBeGreaterThanOrEqual(1); expect(replacements).toBeGreaterThanOrEqual(2);
    expect(moneyRewards).toBeGreaterThan(0); expect(game.player.team[0].xp).toBeGreaterThan(xpBefore); expect(game.player.money).not.toBe(moneyBefore);
    expect(world.rosterStatus().total).toBe(12);
    expect(world.entities.every(entity => entity.brain.updates === 0 && JSON.stringify(entity.brain.readout) === JSON.stringify(policy.readout))).toBe(true);
  }, 15_000);

  it('round-trips a graph-deduplicated save and replays exactly during battle', async () => {
    const graph = await loadGraph(), policy = await loadPolicy(), game = createGame(4, 'open-world-replay');
    const world = new OpenWorldSimulation(graph, game, 8080, undefined, policy), target = world.entities.find(entity => entity.kind === 'wild')!;
    world.selectWild(target.id); engageWildAtLocation(world, target.id); world.step({ deltaSeconds: .4 }); world.requestAction({ type: 'move', index: 0 });
    const json = serializeOpenWorld(game, world);
    expect(json).not.toContain('"edges"'); expect(JSON.parse(json).world.model).toBe(OPEN_WORLD_MODEL);
    const a = restoreOpenWorld(graph, json, policy), b = restoreOpenWorld(graph, json, policy);
    const traceA = Array.from({ length: 10 }, () => a.simulation.step({ deltaSeconds: .2 }));
    const traceB = Array.from({ length: 10 }, () => b.simulation.step({ deltaSeconds: .2 }));
    expect(traceA).toEqual(traceB); expect(a.simulation.snapshot()).toEqual(b.simulation.snapshot()); expect(a.game).toEqual(b.game);
  });
});
