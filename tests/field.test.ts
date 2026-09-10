import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain.ts';
import { FieldSimulation, type FieldPolicy } from '../src/game/field.ts';
import { tileAt } from '../src/game/map.ts';

const loadGraph = async () => JSON.parse(await readFile(new URL('../public/data/connectome.json', import.meta.url), 'utf8')) as Graph;
const loadPolicy = async () => JSON.parse(await readFile(new URL('../public/data/field-policy.json', import.meta.url), 'utf8')) as FieldPolicy;

describe('autonomous connectome field', () => {
  it('runs separate real-graph field brains without embedding graph bytes in snapshots', async () => {
    const graph = await loadGraph();
    const field = new FieldSimulation(graph, 9001, [{ id: 'a', speciesId: 1 }, { id: 'b', speciesId: 25 }, { id: 'c', speciesId: 7 }]);
    for (let step = 0; step < 20; step++) field.step(false);
    expect(field.entities).toHaveLength(3);
    expect(new Set(field.entities.map(entity => `${entity.x}:${entity.y}`)).size).toBe(3);
    for (const entity of field.entities) {
      expect(['tree', 'water', 'building']).not.toContain(tileAt(entity.x, entity.y));
      expect(entity.brain.graph.id).toBe(graph.id);
      expect(entity.brain.sensoryBypass).toBe(false);
      expect(entity.brain.activity.every(Number.isFinite)).toBe(true);
      expect(entity.action).toBeGreaterThanOrEqual(0); expect(entity.action).toBeLessThanOrEqual(4);
    }
    const snapshot = field.snapshot() as unknown as Record<string, unknown>;
    expect(JSON.stringify(snapshot)).not.toContain('"edges"');
    expect((snapshot.entities as Array<{ brain: Record<string, unknown> }>).every(entity => !('graph' in entity.brain))).toBe(true);
  });

  it('replays exactly from a graph-deduplicated checkpoint and preserves member state by ID', async () => {
    const graph = await loadGraph(), members = [{ id: 'one', speciesId: 4 }, { id: 'two', speciesId: 133 }];
    const original = new FieldSimulation(graph, 42, members);
    for (let step = 0; step < 7; step++) original.step(true);
    const checkpoint = original.snapshot();
    const a = new FieldSimulation(graph, 42, members, checkpoint), b = new FieldSimulation(graph, 42, members, checkpoint);
    const traceA = Array.from({ length: 15 }, () => a.step(false));
    const traceB = Array.from({ length: 15 }, () => b.step(false));
    expect(traceA).toEqual(traceB); expect(a.snapshot()).toEqual(b.snapshot());
    const retained = structuredClone(a.entities[0].brain);
    a.setMembers([{ id: 'one', speciesId: 4 }, { id: 'three', speciesId: 151 }]);
    expect(a.entities[0].brain).toEqual(retained);
    expect(a.entities[1].brain.seed).not.toBe(a.entities[0].brain.seed);
  });

  it('supports player collision exclusion and manual food on open tiles', async () => {
    const graph = await loadGraph();
    const field = new FieldSimulation(graph, 7, [{ id: 'solo', speciesId: 7 }]);
    field.setPlayer(12, 10);
    const food = field.dropFood(12, 11);
    expect(field.foods).toContainEqual(food);
    expect(() => field.dropFood(17, 10)).toThrow(/Food/);
    expect(() => field.setPlayer(17, 10)).toThrow(/Player/);
  });

  it('loads the trained policy and can disable real recurrent edges without resetting memory', async () => {
    const graph = await loadGraph(), policy = await loadPolicy();
    const field = new FieldSimulation(graph, 71, [{ id: 'policy', speciesId: 25 }], undefined, policy);
    const entity = field.entities[0], weights = structuredClone(entity.brain.readout), updates = entity.brain.updates;
    field.dropFood(12, 11);
    field.setPlayer(entity.x, entity.y);
    expect(field.foods.some(food => food.x === entity.x && food.y === entity.y)).toBe(false);
    field.setRecurrentEnabled(false);
    expect(entity.brain.graph.edges.every(edge => edge.weight === 0)).toBe(true);
    expect(entity.brain.readout).toEqual(weights); expect(entity.brain.updates).toBe(updates);
    field.setRecurrentEnabled(true); field.step(false);
    expect(entity.brain.graph.id).toBe(graph.id);
    expect(entity.lastObservation).toHaveLength(12);
  });
});
