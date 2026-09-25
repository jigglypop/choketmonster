import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { availableMonsterMoveIds, canLearnTechnicalMachine, createGame, createMonster, grantTechnicalMachine, replaceMonsterMove, restoreGame, serializeGame, SHOP_ITEMS, teachTechnicalMachine } from '../src/game/engine';
import { getTechnicalMachine, machineCompatible, technicalMachines } from '../src/game/technical-machines';
import { activeFieldItemPickups, megaStoneAffinity } from '../src/openworld/item-sources';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;

describe('technical machines', () => {
  it('reads species compatibility from the machine catalog', () => {
    expect(technicalMachines().length).toBeGreaterThan(40);
    expect(getTechnicalMachine(89)?.name).toBe('기술머신 지진');
    expect(machineCompatible(89, 6)).toBe(true);
    expect(machineCompatible(89, 12)).toBe(false);
    expect(machineCompatible(89, 0)).toBe(false);
    expect(canLearnTechnicalMachine({ speciesId: 6 }, 89)).toBe(true);
  });

  it('teaches a move without using up the machine, equips it into a free slot and survives a save round trip', () => {
    const game = createGame(1, 'tm-teach'), bulbasaur = game.player.team[0];
    expect(() => teachTechnicalMachine(game, bulbasaur.instanceId, 412)).toThrow(/보유한 기술머신/);
    expect(grantTechnicalMachine(game, 412, 2)).toBe(true);
    expect(grantTechnicalMachine(game, 1)).toBe(false);
    expect(availableMonsterMoveIds(bulbasaur)).not.toContain(412);
    // Owned machines are offered in the move editor to every Pokémon that can learn them.
    expect(availableMonsterMoveIds(bulbasaur, game.technicalMachines)).toContain(412);
    const slots = bulbasaur.moves.length;
    expect(teachTechnicalMachine(game, bulbasaur.instanceId, 412).equipped).toBe(slots < 4);
    expect(availableMonsterMoveIds(bulbasaur)).toContain(412);
    expect(game.technicalMachines).toEqual({ 412: 2 });
    expect(() => teachTechnicalMachine(game, bulbasaur.instanceId, 412)).toThrow(/이미/);
    grantTechnicalMachine(game, 89);
    expect(() => teachTechnicalMachine(game, bulbasaur.instanceId, 89)).toThrow(/배울 수 없습니다/);
    const restored = restoreGame(serializeGame(game));
    expect(restored.technicalMachines).toEqual({ 412: 2, 89: 1 });
    expect(restored.player.team[0].taughtMoves).toEqual([412]);
  });

  it('leaves a full move set for the player to arrange', () => {
    const game = createGame(4, 'tm-full'), charizard = createMonster(game, 6, 40);
    game.player.team.push(charizard);
    while (charizard.moves.length < 4) charizard.moves.push({ moveId: [52, 10, 45, 108].find(id => !charizard.moves.some(slot => slot.moveId === id))!, pp: 10 });
    grantTechnicalMachine(game, 89);
    expect(teachTechnicalMachine(game, charizard.instanceId, 89).equipped).toBe(false);
    expect(charizard.moves).toHaveLength(4);
    expect(availableMonsterMoveIds(charizard)).toContain(89);
  });

  it('no longer sells rare candy', () => {
    expect(SHOP_ITEMS).not.toContain('rare-candy');
  });

  it('picks technical machines up from the roadside into the machine stock', () => {
    // Machines lie where Red/Blue finds them, along roads that open with badges.
    const game = createGame(1, 'tm-roadside');
    game.defeatedGyms = [1, 2, 3, 4, 5, 6, 7, 8]; game.player.badges = 8;
    const world = new OpenWorldSimulation(graph, game, 517);
    world.setControlMode('manual'); world.setAutoHunt(false);
    const pickup = world.fieldPickups.find(item => item.kind === 'technical-machine')!;
    expect(pickup).toBeDefined();
    world.player = { x: pickup.x, z: pickup.z, heading: 0 };
    Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
    expect(world.collectFieldItem(pickup.id)?.id).toBe(pickup.itemId);
    const moveId = Number(pickup.itemId.split(':')[1]);
    expect(game.technicalMachines?.[String(moveId)]).toBe(1);
    expect(world.fieldPickups.some(item => item.id === pickup.id)).toBe(false);
  });

  it('favors the Mega Stones of team species more as their moves are used', () => {
    expect(megaStoneAffinity([{ speciesId: 4 }])).toEqual({ 6: 1 });
    expect(megaStoneAffinity([{ speciesId: 4, moveLearning: { 52: { executed: 300 } } }])).toEqual({ 6: 3 });
    const count = (affinity: Record<number, number>) => Array.from({ length: 40 }, (_, cycle) => activeFieldItemPickups('kanto', 517, { 'field-item:kanto:0': { remainingSeconds: 0, collectedCount: cycle } }, 8, affinity))
      .flat().filter(item => item.kind === 'mega-stone' && item.speciesId === 6).length;
    expect(count({ 6: 4 })).toBeGreaterThan(count({}));
  });

  it('places a bag machine move from the move editor and remembers it', () => {
    const game = createGame(1, 'tm-editor'), bulbasaur = game.player.team[0];
    expect(() => replaceMonsterMove(game, bulbasaur.instanceId, 0, 412)).toThrow();
    grantTechnicalMachine(game, 412);
    replaceMonsterMove(game, bulbasaur.instanceId, 0, 412);
    expect(bulbasaur.moves.some(slot => slot.moveId === 412)).toBe(true);
    expect(bulbasaur.taughtMoves).toEqual([412]);
    expect(game.technicalMachines).toEqual({ 412: 1 });
  });
});
