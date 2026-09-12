import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { actBattle, createGame, createMonster } from '../src/game/engine';
import { automatedMoveMask, availableMoveMask, battleMoveSenses, ConnectomeController, mapToAvailableMove, type NeuralMonster } from '../src/game/connectome';

const graph: Graph = {
  schema: 1,
  kind: 'connectome-subset',
  id: 'test-connectome-two-neurons',
  nodes: ['720575940000000001', '720575940000000002'],
  edges: [{ source: 0, target: 1, weight: .5 }],
  provenance: {
    source: 'https://example.org/test-connectome',
    version: 'fixture-v1',
    license: 'test-only',
    sha256: 'a'.repeat(64),
    note: 'Small test fixture, not biological evidence.',
  },
};

function monster(instanceId: string, speciesId: number, moveId?: number): NeuralMonster {
  return {
    instanceId,
    speciesId,
    level: 20,
    hp: 50,
    stats: { hp: 100, speed: 50 },
    moves: [{ pp: 20, ...(moveId === undefined ? {} : { moveId }) }],
  };
}

describe('connectome battle observations', () => {
  it('keeps 12 inputs while differentiating move matchup at equal HP and stats', () => {
    const controller = new ConnectomeController(graph);
    const squirtle = monster('self', 7, 55); // Water Gun
    const fireOpponent = monster('fire', 4);
    const waterOpponent = monster('water', 7);
    const fire = controller.observe(squirtle, fireOpponent, 3);
    const water = controller.observe(squirtle, waterOpponent, 3);

    expect(fire).toHaveLength(12);
    expect(water).toHaveLength(12);
    expect(fire.slice(0, 8)).toEqual(water.slice(0, 8));
    expect(fire[8]).toBeGreaterThan(water[8]);
    expect(controller.observe(monster('legacy', 7), fireOpponent, 3)[8]).toBe(.5);
  });

  it('restores an existing 12-input individual brain without resetting learned updates', () => {
    const controller = new ConnectomeController(graph);
    const self = monster('persistent-individual', 7, 55);
    const opponent = monster('opponent', 4);
    controller.choose(self, opponent, 1, null, false);
    const snapshot = structuredClone(self.brain!);
    snapshot.updates = 7;
    self.brain = snapshot;

    const decision = controller.choose(self, opponent, 2, null, false);
    expect(decision.updates).toBe(7);
    expect(self.brain!.inputWeights.every((row) => row.length === 12)).toBe(true);
    expect(self.brain!.graph.id).toBe(graph.id);
  });

  it('exports deterministic legality masks and maps empty PP without changing the 12-input schema', () => {
    const self = monster('mask', 1);
    self.moves = [{ moveId: 33, pp: 0 }, { moveId: 45, pp: 40 }, { moveId: 73, pp: 0 }];
    expect(availableMoveMask(self)).toEqual([false, true, false, false, true]);
    expect(mapToAvailableMove(0, availableMoveMask(self))).toBe(1);
    expect(mapToAvailableMove(4, availableMoveMask(self))).toBe(4);
    expect(new ConnectomeController(graph).observe(self, monster('foe', 4), 1)).toHaveLength(12);
  });

  it('encodes recovery need, saturated buffs, and status immunity in each move slot', () => {
    const self = monster('strategy', 1); self.moves = [
      { moveId: 105, pp: 10 }, { moveId: 14, pp: 20 }, { moveId: 77, pp: 35 }, { moveId: 55, pp: 25 },
    ];
    const fire = monster('fire', 4), poison = monster('poison', 1);
    self.hp = 20;
    const hurt = battleMoveSenses(self, fire, { selfStatStages: { attack: 0 } });
    self.hp = 100;
    const full = battleMoveSenses(self, fire, { selfStatStages: { attack: 6 } });
    const immune = battleMoveSenses(self, poison, { selfStatStages: { attack: 6 } });
    expect(hurt[0]).toBeGreaterThan(full[0]);
    expect(hurt[1]).toBeGreaterThan(full[1]);
    expect(immune[2]).toBeLessThan(full[2]);
    expect(hurt.every(Number.isFinite)).toBe(true);
  });

  it('masks ineffective recovery, saturated buffs, and immune status during automatic battle', () => {
    const self = monster('automatic-strategy', 1); self.moves = [
      { moveId: 105, pp: 10 }, // Recover
      { moveId: 14, pp: 20 }, // Swords Dance
      { moveId: 77, pp: 35 }, // Poison Powder
      { moveId: 33, pp: 35 }, // Tackle
    ];
    const poisonOpponent = monster('poison-target', 1);
    self.hp = self.stats.hp;
    expect(automatedMoveMask(self, poisonOpponent, 1, { selfStatStages: { attack: 6 } }))
      .toEqual([false, false, false, true, false]);

    self.hp = 25;
    expect(automatedMoveMask(self, monster('fire-target', 4), 1, { selfStatStages: { attack: 0 } }))
      .toEqual([true, true, true, true, false]);
  });

  it('reserves every third automatic turn for a non-immune attack and keeps fixed-damage moves', () => {
    const self = monster('automatic-attack', 1); self.moves = [
      { moveId: 69, pp: 20 }, // Seismic Toss: power 0, fixed damage
      { moveId: 77, pp: 35 },
    ];
    const foe = monster('automatic-foe', 4);
    expect(automatedMoveMask(self, foe, 1)).toEqual([true, true, false, false, false]);
    expect(automatedMoveMask(self, foe, 3)).toEqual([true, false, false, false, false]);
    expect(mapToAvailableMove(4, automatedMoveMask(self, foe, 3))).toBe(0);
  });

  it('produces no waits and at least one attack per three turns in a fixed 50-turn automatic comparison', () => {
    const self = monster('automatic-50-turns', 1); self.moves = [{ moveId: 33, pp: 99 }, { moveId: 14, pp: 99 }];
    const foe = monster('automatic-50-turn-foe', 4);
    const actions = Array.from({ length: 50 }, (_, index) => mapToAvailableMove(4, automatedMoveMask(self, foe, index + 1, { selfStatStages: { attack: 0 } })));
    expect(actions.filter(action => action === 4)).toHaveLength(0);
    expect(actions.filter(action => action === 0).length).toBeGreaterThanOrEqual(Math.floor(50 / 3));

    self.moves.forEach(slot => { slot.pp = 0; });
    expect(automatedMoveMask(self, foe, 1)).toEqual([true, false, false, false, false]);
  });

  it('executes Struggle for both automated sides after all PP are depleted', () => {
    const game = createGame(1, 'no-pp-auto'), self = game.player.team[0], foe = createMonster(game, 4, 5);
    for (const monster of [self, foe]) monster.moves.forEach(slot => { slot.pp = 0; });
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [foe], activeIndex: 0 }, turn: 1, canRun: true };
    const controller = new ConnectomeController(graph);
    const mine = controller.choose(self, foe, 1, null, true, { automatic: true });
    const theirs = controller.choose(foe, self, 1, null, true, { automatic: true });
    const result = actBattle(game, { type: 'move', index: mine.action }, theirs.action);
    expect(result.executedMoves).toHaveLength(2);
    expect(result.executedMoves.every(move => move.result === 'struggle' && move.damage > 0)).toBe(true);
  });
});
