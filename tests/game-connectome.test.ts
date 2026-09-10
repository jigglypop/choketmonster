import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain.ts';
import { evaluatePokemonBrain } from '../scripts/evaluate-pokemon-brain.ts';

describe('Pokemon connectome execution evidence', () => {
  it('uses circuit edges, freezes evaluation, replays exactly, and isolates 151 brains', async () => {
    const graph = JSON.parse(await readFile(new URL('../public/data/connectome.json', import.meta.url), 'utf8')) as Graph;
    const report = evaluatePokemonBrain(graph);
    expect(report.graph).toMatchObject({ nodes: 128, edges: 3623 });
    expect(report.circuitAblation.meanActivityL1Difference).toBeGreaterThan(0);
    expect(report.circuitAblation.maxActivityL1Difference).toBeGreaterThan(0);
    expect(report.circuitAblation.actionDifferences).toBeGreaterThan(0);
    expect(report.circuitAblation.checkpointsWithActionDifference).toBeGreaterThan(0);
    expect(report.frozenEvaluation).toMatchObject({ unchangedReadout: true, unchangedUpdates: true });
    expect(report.exactReplay).toMatchObject({ actionsMatch: true, finalSnapshotMatches: true, rngMatches: true });
    expect(report.individualState).toEqual({ speciesRun: 151, uniqueBrainSeeds: 151, allFinite: true, independentMutation: true });
  });
});
