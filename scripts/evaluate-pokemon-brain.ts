import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Brain, validateGraph, type BrainState, type Graph } from '../src/core/brain.ts';
import { POKEMON } from '../src/data/pokemon.ts';
import { BRAIN_ASSUMPTIONS, BRAIN_MODEL, ConnectomeController, type NeuralMonster } from '../src/game/connectome.ts';

const BRAIN_SEEDS = Array.from({ length: 16 }, (_, index) => 10_001 + index * 97);

export type PokemonBrainEvidence = {
  schema: 1;
  model: string;
  graph: { id: string; nodes: number; edges: number };
  protocol: Record<string, unknown>;
  circuitAblation: {
    checkpoints: number; observationsPerCheckpoint: number; comparisons: number;
    actionDifferences: number; checkpointsWithActionDifference: number;
    meanActivityL1Difference: number; maxActivityL1Difference: number;
  };
  frozenEvaluation: { unchangedReadout: boolean; unchangedUpdates: boolean; observations: number };
  exactReplay: { actionsMatch: boolean; finalSnapshotMatches: boolean; rngMatches: boolean; observations: number };
  individualState: { speciesRun: number; uniqueBrainSeeds: number; allFinite: boolean; independentMutation: boolean };
  interpretation: string;
};

export function scriptedBattleObservations(count = 48): number[][] {
  return Array.from({ length: count }, (_, index) => {
    const turn = index + 1;
    const selfHp = Math.max(0.05, 1 - index / (count * 1.13));
    const otherHp = Math.max(0.04, 1 - ((index * 7) % count) / count);
    const levelDelta = ((index % 11) - 5) / 30;
    const speedDelta = ((index * 13) % 41 - 20) / 100;
    return [1, selfHp, otherHp, levelDelta, speedDelta, Math.min(turn / 50, 1),
      index % 17 === 0 ? 1 : 0, index % 19 === 0 ? 1 : 0,
      ...Array.from({ length: 4 }, (_, move) => Math.max(0, 1 - ((index + move * 5) % 41) / 40))];
  });
}

function monster(speciesId: number): NeuralMonster {
  const species = POKEMON[speciesId - 1];
  return {
    instanceId: `evidence-species-${speciesId}`, speciesId, level: 35,
    hp: species.baseStats.hp, stats: { hp: species.baseStats.hp, speed: species.baseStats.speed },
    moves: Array.from({ length: 4 }, (_, index) => ({ pp: 10 + ((speciesId + index * 7) % 31) })),
  };
}

function runFrom(checkpoint: BrainState, observations: number[][], epsilon = 0) {
  const brain = Brain.restore(structuredClone(checkpoint));
  const actions = observations.map(observation => brain.act(observation, null, false, epsilon, 4));
  return { actions, snapshot: brain.snapshot() };
}

export function evaluatePokemonBrain(graph: Graph): PokemonBrainEvidence {
  validateGraph(graph);
  if (graph.kind !== 'connectome-subset') throw new Error('Pokemon evidence requires connectome-subset data');
  const observations = scriptedBattleObservations();

  let actionDifferences = 0;
  let activityDifferenceSum = 0;
  let maxActivityL1Difference = 0;
  let checkpointsWithActionDifference = 0;
  for (const seed of BRAIN_SEEDS) {
    const initial = new Brain(seed, graph);
    initial.state.sensoryBypass = false;
    const checkpoint = initial.snapshot();
    const real = Brain.restore(checkpoint);
    const ablatedState = structuredClone(checkpoint);
    ablatedState.graph.edges = ablatedState.graph.edges.map(edge => ({ ...edge, weight: 0 }));
    const ablated = Brain.restore(ablatedState);
    let seedActionDifferences = 0;
    for (const observation of observations) {
      const realAction = real.act(observation, null, false, 0, 4);
      const ablatedAction = ablated.act(observation, null, false, 0, 4);
      if (realAction !== ablatedAction) { actionDifferences++; seedActionDifferences++; }
      const l1 = real.state.activity.reduce((sum, value, index) => sum + Math.abs(value - ablated.state.activity[index]), 0) / graph.nodes.length;
      activityDifferenceSum += l1;
      maxActivityL1Difference = Math.max(maxActivityL1Difference, l1);
    }
    if (seedActionDifferences > 0) checkpointsWithActionDifference++;
  }

  const frozen = new Brain(77_777, graph);
  frozen.state.sensoryBypass = false;
  const frozenReadout = JSON.stringify(frozen.state.readout);
  const frozenUpdates = frozen.state.updates;
  for (const observation of observations) frozen.act(observation, null, false, 0, 4);

  const replayBrain = new Brain(88_888, graph);
  replayBrain.state.sensoryBypass = false;
  const replayCheckpoint = replayBrain.snapshot();
  const replayA = runFrom(replayCheckpoint, observations, 0.12);
  const replayB = runFrom(replayCheckpoint, observations, 0.12);

  const controller = new ConnectomeController(graph);
  const monsters = POKEMON.map(species => monster(species.id));
  for (let index = 0; index < monsters.length; index++) {
    const rival = monsters[(index + 1) % monsters.length];
    controller.choose(monsters[index], rival, index + 1, null, false);
  }
  const uniqueBrainSeeds = new Set(monsters.map(value => value.brain!.seed)).size;
  const allFinite = monsters.every(value => value.brain!.activity.every(Number.isFinite));
  const untouchedBefore = JSON.stringify(monsters[1].brain);
  controller.choose(monsters[0], monsters[1], 49, null, false);
  const independentMutation = untouchedBefore === JSON.stringify(monsters[1].brain);

  const comparisons = BRAIN_SEEDS.length * observations.length;
  return {
    schema: 1,
    model: BRAIN_MODEL,
    graph: { id: graph.id, nodes: graph.nodes.length, edges: graph.edges.length },
    protocol: {
      assumptions: BRAIN_ASSUMPTIONS,
      observations: 'Scripted [bias, self HP, opponent HP, level delta, speed delta, turn, two status flags, four PP fractions]; no type or type-effectiveness input.',
      ablation: 'For each seed, restore one checkpoint twice and replace every graph edge weight with zero in one copy. Input projection and readout remain identical. Both copies receive the same ordered observations.',
      evaluation: 'learning=false, epsilon=0, four recurrent microsteps; readout and update count compared before/after.',
      bounds: `${BRAIN_SEEDS.length} checkpoints x ${observations.length} observations; ${POKEMON.length} one-step species instances.`,
    },
    circuitAblation: {
      checkpoints: BRAIN_SEEDS.length, observationsPerCheckpoint: observations.length, comparisons,
      actionDifferences, checkpointsWithActionDifference,
      meanActivityL1Difference: activityDifferenceSum / comparisons, maxActivityL1Difference,
    },
    frozenEvaluation: {
      unchangedReadout: frozenReadout === JSON.stringify(frozen.state.readout),
      unchangedUpdates: frozenUpdates === frozen.state.updates, observations: observations.length,
    },
    exactReplay: {
      actionsMatch: JSON.stringify(replayA.actions) === JSON.stringify(replayB.actions),
      finalSnapshotMatches: JSON.stringify(replayA.snapshot) === JSON.stringify(replayB.snapshot),
      rngMatches: replayA.snapshot.rng === replayB.snapshot.rng, observations: observations.length,
    },
    individualState: { speciesRun: monsters.length, uniqueBrainSeeds, allFinite, independentMutation },
    interpretation: 'This demonstrates that measured MaleCNS subset edges affect recurrent activity and can affect chosen game actions. It does not test battle win rate, learning efficacy, biological sensory coding, or biological learning.',
  };
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const output = resolve(outIndex >= 0 ? process.argv[outIndex + 1] : 'artifacts/pokemon-brain-evidence.json');
  const graph = JSON.parse(await readFile(resolve('public/data/connectome.json'), 'utf8')) as Graph;
  const report = evaluatePokemonBrain(graph);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`wrote ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
