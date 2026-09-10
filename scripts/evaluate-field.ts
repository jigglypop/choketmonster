import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Graph } from '../src/core/brain.ts';
import { FIELD_MODEL, FieldSimulation, type FieldPolicy } from '../src/game/field.ts';

const TRAINING_SEED = 4_204_204;
const TRAINING_TICKS = 20_000;
const EVALUATION_SEEDS = [8_100_001, 8_100_101, 8_100_201, 8_100_301, 8_100_401, 8_100_501];
const EVALUATION_TICKS = 1_200;
const MEMBER = [{ id: 'field-evaluation', speciesId: 25 }];

type Metrics = { foods: number; collisions: number; reward: number; actionCounts: number[] };
type Condition = Metrics & { meanFoods: number; meanCollisions: number; meanReward: number; perSeed: Array<Metrics & { seed: number }> };

function run(graph: Graph, seed: number, policy: FieldPolicy | undefined, recurrentEnabled: boolean, epsilon: number): Metrics {
  const simulation = new FieldSimulation(graph, seed, MEMBER, undefined, policy); simulation.setRecurrentEnabled(recurrentEnabled);
  let reward = 0; const actionCounts = Array(5).fill(0);
  for (let tick = 0; tick < EVALUATION_TICKS; tick++) {
    simulation.step(false, epsilon); const entity = simulation.entities[0]; reward += entity.reward; actionCounts[entity.action]++;
  }
  const entity = simulation.entities[0]; return { foods: entity.foods, collisions: entity.collisions, reward, actionCounts };
}

function condition(graph: Graph, policy: FieldPolicy | undefined, recurrentEnabled = true, epsilon = 0): Condition {
  const perSeed = EVALUATION_SEEDS.map(seed => ({ seed, ...run(graph, seed, policy, recurrentEnabled, epsilon) }));
  const total = (field: keyof Metrics) => perSeed.reduce((sum, row) => sum + (row[field] as number), 0);
  return { foods: total('foods'), collisions: total('collisions'), reward: total('reward'),
    actionCounts: perSeed.reduce((sum, row) => sum.map((value, index) => value + row.actionCounts[index]), Array(5).fill(0)),
    meanFoods: total('foods') / perSeed.length, meanCollisions: total('collisions') / perSeed.length,
    meanReward: total('reward') / perSeed.length, perSeed };
}

export async function evaluateField(graph: Graph) {
  const training = new FieldSimulation(graph, TRAINING_SEED, [{ id: 'field-policy-training', speciesId: 25 }]);
  for (let tick = 0; tick < TRAINING_TICKS; tick++) training.step(true, 0.12);
  const trained = training.entities[0].brain;
  const policy: FieldPolicy = { schema: 1, model: FIELD_MODEL, graphId: graph.id, trainingSeed: TRAINING_SEED,
    inputWeights: structuredClone(trained.inputWeights), readout: structuredClone(trained.readout),
    note: 'Engineering Q-learning readout trained for 20,000 field ticks with epsilon 0.12. Food direction and collision inputs are designed signals; this is not biological learning.' };

  const frozen = new FieldSimulation(graph, EVALUATION_SEEDS[0], MEMBER, undefined, policy);
  const weightsBefore = JSON.stringify(frozen.entities[0].brain.readout), updatesBefore = frozen.entities[0].brain.updates;
  for (let tick = 0; tick < 300; tick++) frozen.step(false);
  const frozenWeights = weightsBefore === JSON.stringify(frozen.entities[0].brain.readout) && updatesBefore === frozen.entities[0].brain.updates;

  const replaySource = new FieldSimulation(graph, 9_900_001, MEMBER, undefined, policy);
  for (let tick = 0; tick < 25; tick++) replaySource.step(false);
  const checkpoint = replaySource.snapshot();
  const replayA = new FieldSimulation(graph, checkpoint.seed, MEMBER, checkpoint), replayB = new FieldSimulation(graph, checkpoint.seed, MEMBER, checkpoint);
  const traceA = Array.from({ length: 120 }, () => replayA.step(false)), traceB = Array.from({ length: 120 }, () => replayB.step(false));
  const exactReplay = JSON.stringify(traceA) === JSON.stringify(traceB) && JSON.stringify(replayA.snapshot()) === JSON.stringify(replayB.snapshot());

  const isolated = new FieldSimulation(graph, 9_900_101, [{ id: 'kept', speciesId: 1 }, { id: 'removed', speciesId: 4 }], undefined, policy);
  for (let tick = 0; tick < 10; tick++) isolated.step(true);
  const removedBefore = JSON.stringify(isolated.entities[1].brain);
  isolated.setMembers([{ id: 'kept', speciesId: 2 }]);
  for (let tick = 0; tick < 20; tick++) isolated.step(true);
  isolated.setMembers([{ id: 'kept', speciesId: 3 }, { id: 'removed', speciesId: 5 }]);
  const isolatedMemory = removedBefore === JSON.stringify(isolated.entities[1].brain) && isolated.entities[0].brain.updates > 0;

  const fixed = condition(graph, undefined);
  const learned = condition(graph, policy);
  const random = condition(graph, undefined, true, 1);
  const edgeZero = condition(graph, policy, false);
  const report = {
    schema: 1, model: FIELD_MODEL, graph: { id: graph.id, nodes: graph.nodes.length, edges: graph.edges.length },
    protocol: { trainingSeed: TRAINING_SEED, trainingTicks: TRAINING_TICKS, trainingEpsilon: 0.12,
      evaluationSeeds: EVALUATION_SEEDS, evaluationTicksPerSeed: EVALUATION_TICKS, evaluationLearning: false,
      inputs: '[bias, food dx/dy, dx/dy signs, absolute dx/dy, blocked up/right/down/left, energy]',
      actions: '[up, right, down, left, wait]',
      reward: '-0.01/tick, +/-0.08 one-tile food-distance change, -0.3 blocked/entity collision, +2 food',
      note: 'Food coordinates, sensory projection, dynamics, actions, reward and Q-learning are engineered. Real MaleCNS subset edges are only the recurrent topology/weights.' },
    results: { random, fixed, learned, learnedEdgeZero: edgeZero },
    checks: { frozenWeights, exactReplay, isolatedMemory, checkpointContainsGraphEdges: JSON.stringify(checkpoint).includes('"edges"'),
      learnedVsFixedFoodDelta: learned.meanFoods - fixed.meanFoods, learnedVsEdgeZeroFoodDelta: learned.meanFoods - edgeZero.meanFoods },
    interpretation: 'Descriptive bounded field task only. Differences do not establish biological learning or a biologically mapped sensorimotor circuit.',
  };
  return { policy, report };
}

async function main() {
  const graph = JSON.parse(await readFile(resolve('public/data/connectome.json'), 'utf8')) as Graph;
  const { policy, report } = await evaluateField(graph);
  const policyPath = resolve('public/data/field-policy.json');
  const outAt = process.argv.indexOf('--out'), reportPath = resolve(outAt >= 0 ? process.argv[outAt + 1] : 'artifacts/field-neural-evidence.json');
  await mkdir(dirname(policyPath), { recursive: true }); await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(policyPath, JSON.stringify(policy, null, 2) + '\n'); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); console.log(`wrote ${policyPath}\nwrote ${reportPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
