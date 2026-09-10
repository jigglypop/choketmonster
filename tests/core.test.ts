import { describe, it, expect } from 'vitest';
import { Brain, syntheticGraph, validateGraph } from '../src/core/brain';
import { runEpisode, train } from '../src/core/episode';
import { createWorld, observe, stepWorld, type World } from '../src/core/world';
import { starterCollection, parseCollection } from '../src/core/collection';

describe('deterministic simulation and memory', () => {
  it('reproduces an entire episode from a saved checkpoint', () => {
    const brain = new Brain(42); train(brain, 12, 10000);
    const checkpoint = JSON.parse(JSON.stringify(brain.snapshot()));
    const a: World[] = [], b: World[] = [];
    const result = runEpisode(brain, 1000001, { trace: a });
    expect(runEpisode(Brain.restore(checkpoint), 1000001, { trace: b })).toEqual(result);
    expect(a).toEqual(b);
  });
  it('resumes neural state and exploration RNG mid-episode exactly', () => {
    let w = createWorld(200); const original = new Brain(9);
    for (let i = 0; i < 20; i++) w = stepWorld(w, original.act(observe(w), w.tick ? w.lastReward : null, true, 0.2));
    const restored = Brain.restore(JSON.parse(JSON.stringify(original.snapshot())));
    for (let i = 0; i < 30; i++) {
      const a = original.act(observe(w), w.lastReward, true, 0.2);
      expect(restored.act(observe(w), w.lastReward, true, 0.2)).toBe(a);
      w = stepWorld(w, a);
    }
    expect(restored.snapshot()).toEqual(original.snapshot());
  });
  it('updates only the readout during learning and freezes it during evaluation', () => {
    const brain = new Brain(42); const initial = brain.snapshot(); train(brain, 5, 1000);
    expect(brain.state.readout).not.toEqual(initial.readout);
    expect(brain.state.graph).toEqual(initial.graph);
    expect(brain.state.inputWeights).toEqual(initial.inputWeights);
    const learned = brain.snapshot(); runEpisode(brain, 1000000);
    expect(brain.state.readout).toEqual(learned.readout);
    expect(brain.state.updates).toBe(learned.updates);
  });
  it('has no unseeded variation, NaNs, shared creature memory, or mutable terminal worlds', () => {
    const a = new Brain(5), b = new Brain(5);
    expect(train(a, 4, 1000)).toEqual(train(b, 4, 1000));
    expect(a.snapshot()).toEqual(b.snapshot());
    train(a, 2, 5000); expect(a.state.readout).not.toEqual(b.state.readout);
    let w = createWorld(2, 1); w = stepWorld(w, 4);
    expect(w.done).toBe(true); expect(() => stepWorld(w, 4)).toThrow();
    expect(() => Brain.restore({ ...a.snapshot(), activity: [NaN] })).toThrow();
  });
  it('keeps the collect-train-save-restore loop intact', () => {
    const c = starterCollection(); const before = structuredClone(c.creatures[1]);
    const brain = Brain.restore(c.creatures[0].brain); train(brain, 10, 5000);
    c.creatures[0].brain = brain.snapshot(); c.creatures[0].episodes += 10;
    const loaded = parseCollection(JSON.stringify(c));
    expect(parseCollection('\uFEFF' + JSON.stringify(c))).toEqual(c);
    expect(loaded.creatures[1]).toEqual(before); expect(loaded).toEqual(c);
    expect(() => parseCollection('{"schema":2}')).toThrow();
    const bad = structuredClone(c); bad.creatures[0].brain.readout[0][0] = Infinity;
    expect(() => parseCollection(JSON.stringify(bad))).toThrow();
  });
});
describe('data identity', () => {
  it('does not admit a biological provenance claim without its metadata', () => {
    const g = syntheticGraph(3); g.kind = 'connectome-subset';
    expect(() => validateGraph(g)).toThrow();
    expect(syntheticGraph(3).kind).toBe('synthetic');
  });
  it('rejects invalid indices and unsafe numeric neuron identifiers', () => {
    const g = syntheticGraph(3); g.edges[0].source = 100000;
    expect(() => validateGraph(g)).toThrow();
    const bad = { ...syntheticGraph(3), nodes: [720575940123456789, 720575940123456790] };
    expect(() => validateGraph(bad)).toThrow();
  });
});
