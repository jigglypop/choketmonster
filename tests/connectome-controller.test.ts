import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { ConnectomeController, type NeuralMonster } from '../src/game/connectome';

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
});
