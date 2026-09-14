import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import type { FieldPolicy } from '../src/game/field';
import { createGame, createMonster, experienceAtLevel, validateGame } from '../src/game/engine';
import { getSpecies } from '../src/data/pokemon';
import { ConnectomeController } from '../src/game/connectome';
import { packSave, unpackSave, defaultView } from '../src/game/storage';
import { OpenWorldSimulation, serializeOpenWorld, restoreOpenWorld } from '../src/openworld/simulation';
import { KANTO_GYMS, KANTO_LOCATIONS, KANTO_START } from '../src/openworld/kanto';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
function setup(seed = 38211) {
  const game = createGame(1, `kanto-gameplay-${seed}`);
  const world = new OpenWorldSimulation(graph, game, seed, undefined, policy);
  world.setControlMode('manual'); return { game, world };
}
function prepareWin(world: OpenWorldSimulation) {
  world.startEncounter(world.entities.find(entity => entity.kind === 'wild')!.id);
  const battle = world.game.battle!;
  battle.player.team[0].moves = [{ moveId: 33, pp: 35 }];
  battle.enemy.team[0].hp = 1; battle.enemy.team[0].status = 'sleep'; battle.enemy.team[0].statusTurns = 3;
  world.requestAction({ type: 'move', index: 0 });
}

describe('Kanto player flows', () => {
  it('records manual wins and shared growth without updating either individual brain, and replays ledgers', () => {
    const { game, world } = setup(39216), controller = new ConnectomeController(graph), lead = game.player.team[0];
    const bench = createMonster(game, 19, 3); game.player.team.push(bench);
    bench.xp = experienceAtLevel(4, getSpecies(19).growthRate) - 1;
    controller.ensure(lead); controller.ensure(bench);
    const before = [lead, bench].map(monster => structuredClone(monster.brain));
    prepareWin(world); world.step({ deltaSeconds: 1, learning: true });
    expect(world.rewardLedgers[lead.instanceId].latest.at(-1)).toMatchObject({ source: 'manual', learningEligible: false, breakdown: { outcome: 1 } });
    expect(bench.level).toBeGreaterThan(3);
    expect(world.rewardLedgers[bench.instanceId].latest.at(-1)).toMatchObject({ source: 'fallback', learningEligible: false, breakdown: { growth: .25, outcome: 0 } });
    for (const [index, monster] of [lead, bench].entries()) { expect(monster.brain!.readout).toEqual(before[index]!.readout); expect(monster.brain!.updates).toBe(before[index]!.updates); }
    const a = restoreOpenWorld(graph, serializeOpenWorld(game, world), policy), b = restoreOpenWorld(graph, serializeOpenWorld(game, world), policy);
    expect(a.simulation.rewardLedgers).toEqual(world.rewardLedgers);
    for (let i = 0; i < 5; i++) expect(a.simulation.step({ deltaSeconds: .25, learning: false })).toEqual(b.simulation.step({ deltaSeconds: .25, learning: false }));
    expect(serializeOpenWorld(a.game, a.simulation)).toBe(serializeOpenWorld(b.game, b.simulation));
  });
  it('holds manual movement and turns indefinitely, and executes only the queued turn', () => {
    const { game, world } = setup(); const partner = world.entities.find(entity => entity.kind === 'companion')!;
    const before = { x: partner.x, z: partner.z, brain: structuredClone(partner.brain) };
    for (let i = 0; i < 12; i++) world.step({ deltaSeconds: .5, learning: true });
    expect({ x: partner.x, z: partner.z }).toEqual({ x: before.x, z: before.z });
    expect(partner.brain).toEqual(before.brain);
    expect(game.battle).toBeUndefined();
    world.startEncounter(world.entities.find(entity => entity.kind === 'wild')!.id);
    const battleBefore = structuredClone(game.battle);
    for (let i = 0; i < 4; i++) world.step({ deltaSeconds: 5, learning: true });
    expect(game.battle).toEqual(battleBefore);
    world.requestAction({ type: 'wait' }); world.step({ deltaSeconds: 5 });
    expect(game.battle!.turn).toBe(2);
    world.step({ deltaSeconds: 5 }); expect(game.battle!.turn).toBe(2);
  });

  it('persists a victory offer, catches once, and keeps the same brain when a ball is available', () => {
    const { game, world } = setup(38212);
    prepareWin(world); const enemyId = game.battle!.enemy.team[0].instanceId;
    world.step({ deltaSeconds: 1 });
    expect(game.battle).toBeUndefined(); expect(game.captureOffer?.instanceId).toBe(enemyId);
    const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot() });
    expect(JSON.stringify(save).match(/"edges":/g)).toHaveLength(1);
    const loaded = unpackSave(save, graph), restored = new OpenWorldSimulation(graph, loaded.game, world.seed, loaded.view.openWorld, policy);
    const memory = structuredClone(loaded.game.captureOffer!.brain), balls = loaded.game.inventory['poke-ball'];
    expect(restored.captureVictory()).toBe(true); expect(restored.captureVictory()).toBe(false);
    expect(loaded.game.inventory['poke-ball']).toBe(balls - 1);
    const captured = loaded.game.player.team.find(mon => mon.instanceId === enemyId)!;
    expect(captured.hp).toBe(1); expect(captured.brain).toEqual(memory); expect(loaded.game.captureOffer).toBeUndefined();
    expect(() => validateGame(loaded.game)).not.toThrow();
  });

  it('passes defeated wild Pokemon without a ball and keeps automatic hunting active', () => {
    const { game, world } = setup(38217);
    game.inventory['poke-ball'] = 0; game.inventory['great-ball'] = 0; game.inventory['ultra-ball'] = 0;
    world.setControlMode('auto'); prepareWin(world); world.step({ deltaSeconds: 1 });
    expect(game.battle).toBeUndefined(); expect(game.captureOffer).toBeUndefined();
    expect(world.autoHunt).toBe(true); expect(world.controlMode).toBe('auto');
    world.step({ deltaSeconds: .25 });
    expect(world.selectedWildId).toBeDefined();
    expect(game.logs.at(-1)).toContain('놓아주었습니다');
  });

  it('does not leave a blocking victory offer in manual mode without a ball', () => {
    const { game, world } = setup(38219);
    game.inventory['poke-ball'] = 0; game.inventory['great-ball'] = 0; game.inventory['ultra-ball'] = 0;
    prepareWin(world); world.step({ deltaSeconds: 1 });
    expect(game.captureOffer).toBeUndefined(); expect(world.controlMode).toBe('manual');
    expect(world.startEncounter(world.entities.find(entity => entity.kind === 'wild')!.id)).toBe(true);
  });

  it('releases a restored victory offer when its last ball is gone', () => {
    const { game, world } = setup(38220);
    prepareWin(world); world.step({ deltaSeconds: 1 });
    expect(game.captureOffer).toBeDefined();
    const restored = restoreOpenWorld(graph, serializeOpenWorld(game, world), policy);
    restored.game.inventory['poke-ball'] = 0; restored.game.inventory['great-ball'] = 0; restored.game.inventory['ultra-ball'] = 0;
    restored.simulation.step({ deltaSeconds: .25 });
    expect(restored.game.captureOffer).toBeUndefined();
    expect(restored.game.logs.at(-1)).toContain('놓아주었습니다');
  });

  it('continues a normal battle if a queued capture loses its last ball', () => {
    const { game, world } = setup(38218);
    const target = world.entities.find(entity => entity.kind === 'wild')!;
    expect(world.startEncounter(target.id)).toBe(true);
    expect(world.requestCapture('poke-ball')).toBe(true);
    game.inventory['poke-ball'] = 0; game.inventory['great-ball'] = 0; game.inventory['ultra-ball'] = 0;
    const turn = game.battle!.turn, result = world.step({ deltaSeconds: 1 });
    expect(result.events.find(event => event.type === 'battle-turn')?.result.outcome).not.toBe('ran');
    expect(game.battle?.turn ?? turn + 1).toBe(turn + 1);
    expect(world.escaping).toBe(false); expect(world.autoHunt).toBe(true);
  });

  it('auto-catches after victory into a full team box with the cheapest available ball', () => {
    const { game, world } = setup(38213);
    while (game.player.team.length < 6) game.player.team.push(createMonster(game, 19, 3));
    game.inventory['ultra-ball'] = 2; const balls = game.inventory['poke-ball'];
    world.setAutoCapture(true); prepareWin(world); world.step({ deltaSeconds: 1 });
    expect(game.captureOffer).toBeUndefined(); expect(game.player.box).toHaveLength(1);
    expect(game.inventory['poke-ball']).toBe(balls + 2 - 1); expect(game.inventory['ultra-ball']).toBe(0);
    expect(game.player.box[0].brain?.graph.id).toBe(graph.id);
  });

  it('migrates legacy terrain without losing owned memories or an active wild battle', () => {
    const { game, world } = setup(38214); prepareWin(world);
    const checkpoint = world.snapshot(); delete checkpoint.mapVersion;
    checkpoint.player = { x: 0, z: 0, heading: 0 };
    const companion = checkpoint.entities.find(entity => entity.kind === 'companion')!, memory = structuredClone(companion.brain);
    const before = structuredClone(checkpoint), battleId = world.battleWildId;
    const loaded = new OpenWorldSimulation(graph, game, world.seed, checkpoint, policy);
    expect(checkpoint).toEqual(before);
    expect(loaded.player).toMatchObject(KANTO_START);
    expect(loaded.entities.find(entity => entity.kind === 'companion')!.brain.readout).toEqual(memory.readout);
    expect(loaded.battleWildId).toBe(battleId); expect(loaded.rosterStatus().total).toBe(15);
    expect(() => restoreOpenWorld(graph, serializeOpenWorld(game, loaded), policy)).not.toThrow();
  });

  it('awards ordered gym badges through real battles and preserves a gym checkpoint', () => {
    const { game, world } = setup(38215);
    const gym = KANTO_GYMS[0], city = KANTO_LOCATIONS.find(item => item.id === gym.locationId)!;
    world.player = { x: city.x, z: city.z, heading: 0 };
    Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
    expect(world.challengeLocalGym()).toBe(true);
    expect(world.requestCapture()).toBe(false); expect(world.requestAction({ type: 'run' })).toBe(false);
    const restored = restoreOpenWorld(graph, serializeOpenWorld(game, world), policy);
    restored.game.battle!.enemy.team[0].hp = 1; restored.game.battle!.enemy.team[0].status = 'sleep'; restored.game.battle!.enemy.team[0].statusTurns = 3;
    restored.game.player.team[0].moves = [{ moveId: 33, pp: 35 }];
    restored.simulation.requestAction({ type: 'move', index: 0 });
    const money = restored.game.player.money, result = restored.simulation.step({ deltaSeconds: 1 });
    const victory = result.events.find(event => event.type === 'battle-turn');
    expect(victory?.type === 'battle-turn' && victory.result.gymVictory).toEqual({ badge: 1, money: 1500, region: 'kanto' });
    expect(restored.game.player.money - money).toBe(1500);
    expect(restored.simulation.step({ deltaSeconds: .25 }).events.some(event => event.type === 'battle-turn' && event.result.gymVictory)).toBe(false);
    expect(restored.game.player.badges).toBe(1); expect(restored.game.captureOffer).toBeUndefined();
    expect(restored.simulation.challengeLocalGym()).toBe(false);
    expect(() => validateGame(restored.game)).not.toThrow();
  });
});
