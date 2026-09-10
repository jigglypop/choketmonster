import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Brain, validateGraph, type Graph } from '../src/core/brain';

type RealGraph = Graph & {
  nodeMetadata: Array<{ id: string; type: string; superclass: string; neurotransmitter: string; ntConfidence: number }>;
  selection: { seedType: string; seedIds: string[]; selectedNodes: number; inducedEdges: number; inducedSynapses: number; sourceEdgeRowsScanned: number };
  sourceFiles: Array<{ name: string; bytes: number; sha256: string; url: string }>;
};

describe('prepared MaleCNS circuit', () => {
  it('is a source-fingerprinted real induced graph that runs through Brain dynamics', async () => {
    const graph = JSON.parse(await readFile(new URL('../public/data/connectome.json', import.meta.url), 'utf8')) as RealGraph;
    validateGraph(graph);
    expect(graph.kind).toBe('connectome-subset');
    expect(graph.nodes).toHaveLength(128);
    expect(graph.nodes.every(id => /^\d+$/.test(id))).toBe(true);
    expect(graph.nodeMetadata.map(node => node.id)).toEqual(graph.nodes);
    expect(graph.selection.seedType).toBe('DNa02');
    expect(graph.selection.seedIds).toHaveLength(2);
    expect(graph.selection.inducedEdges).toBe(graph.edges.length);
    expect(graph.selection.inducedSynapses).toBeGreaterThan(graph.edges.length);
    expect(graph.selection.sourceEdgeRowsScanned).toBeGreaterThan(1_000_000);
    expect(graph.sourceFiles).toHaveLength(3);
    expect(graph.sourceFiles.every(file => /^https:\/\//.test(file.url) && /^[a-f0-9]{64}$/.test(file.sha256) && file.bytes > 0)).toBe(true);
    expect(graph.edges.some(edge => edge.weight > 0)).toBe(true);
    expect(graph.edges.some(edge => edge.weight < 0)).toBe(true);
    const incoming = Array(graph.nodes.length).fill(0);
    for (const edge of graph.edges) incoming[edge.target] += Math.abs(edge.weight);
    expect(incoming.filter(total => total > 0).every(total => Math.abs(total - 0.8) < 1e-10)).toBe(true);

    const brain = new Brain(20260910, graph);
    const before = [...brain.state.activity];
    const action = brain.act([1, 0, -1, 0.5, 0, 0, 1, 0, 0, -0.5, 0.25, 0], null, false, 0);
    expect(action).toBeGreaterThanOrEqual(0);
    expect(action).toBeLessThan(5);
    expect(brain.state.activity).not.toEqual(before);
  });
});
