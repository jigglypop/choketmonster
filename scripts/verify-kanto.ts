import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrainState, Graph } from '../src/core/brain.ts';
import { createGame } from '../src/game/engine.ts';
import { FIELD_MODEL, type FieldPolicy } from '../src/game/field.ts';
import { OpenWorldSimulation, restoreOpenWorld, serializeOpenWorld } from '../src/openworld/simulation.ts';

const HELD_OUT_SEEDS = [9_311_027, 9_311_129];
const TICKS = 120;
const DELTA_SECONDS = .25;
const INITIAL_POLICY_SEED = 7_711_003;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value: unknown) => hash(JSON.stringify(value));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

type ConditionName = 'random-epsilon1' | 'initial-readout' | 'deployed-readout' | 'edgezero-ablation';
type Condition = { name: ConditionName; graph: Graph; policy: FieldPolicy; epsilon: number };

function policyFromBrain(graph: Graph, brain: Readonly<BrainState>): FieldPolicy {
  return {
    schema: 1,
    model: FIELD_MODEL,
    graphId: graph.id,
    trainingSeed: INITIAL_POLICY_SEED,
    inputWeights: structuredClone(brain.inputWeights),
    readout: structuredClone(brain.readout),
    note: 'Untrained deterministic readout reconstructed from the published training protocol before any learning update.',
  };
}

function comparableStart(world: OpenWorldSimulation) {
  const snapshot = world.snapshot();
  return {
    player: snapshot.player,
    foods: snapshot.foods,
    entities: snapshot.entities.map(({ brain: _brain, ...entity }) => entity),
    spawnSerial: snapshot.spawnSerial,
    nextFoodId: snapshot.nextFoodId,
    mapVersion: snapshot.mapVersion,
  };
}

function activityEvidence(world: OpenWorldSimulation) {
  const activities = world.entities.map(entity => entity.brain.activity);
  const maxAbsActivity = Math.max(...activities.flat().map(Math.abs));
  const maxAbsRecurrentReadoutContribution = Math.max(...world.entities.flatMap(entity => entity.brain.readout.map(row =>
    Math.abs(row.slice(12).reduce((value, weight, index) => value + weight * entity.brain.activity[index] * .35, 0)))));
  return {
    maxAbsActivity,
    maxAbsRecurrentReadoutContribution,
    activitySha256: jsonHash(activities),
    distinctEntityActivityStates: new Set(activities.map(jsonHash)).size,
  };
}

function resolveCaptureDecision(world: OpenWorldSimulation): number {
  if (!world.game.captureOffer) return 0;
  world.releaseVictory();
  return 1;
}

function run(condition: Condition, seed: number) {
  const game = createGame(1, `kanto-heldout-${seed}`);
  const world = new OpenWorldSimulation(condition.graph, game, seed, undefined, condition.policy, 15);
  world.setAutoCapture(true);
  const caughtBefore = game.dex.caught.length;
  const startSha256 = jsonHash(comparableStart(world));
  const initialUpdates = sum(world.entities.map(entity => entity.brain.updates));
  const brainBaselines = new Map<string, string>();
  let readoutChanged = false, maxObservedUpdates = initialUpdates;
  const observeFrozenBrains = () => {
    for (const entity of world.entities) {
      const weights = jsonHash({ inputWeights: entity.brain.inputWeights, readout: entity.brain.readout });
      const baseline = brainBaselines.get(entity.id);
      if (baseline === undefined) brainBaselines.set(entity.id, weights);
      else if (baseline !== weights) readoutChanged = true;
      maxObservedUpdates = Math.max(maxObservedUpdates, entity.brain.updates);
    }
  };
  observeFrozenBrains();
  const actionCounts = [0, 0, 0, 0, 0];
  const eventCounts = { move: 0, wait: 0, collision: 0, food: 0, encounter: 0, battleTurns: 0, completedBattles: 0, wins: 0, losses: 0, escaped: 0 };
  let reward = 0, releasedCaptureOffers = 0;
  const traceHasher = createHash('sha256');
  for (let tick = 0; tick < TICKS; tick++) {
    releasedCaptureOffers += resolveCaptureDecision(world);
    observeFrozenBrains();
    const step = world.step({ deltaSeconds: DELTA_SECONDS, learning: false, epsilon: condition.epsilon });
    releasedCaptureOffers += resolveCaptureDecision(world);
    for (const event of step.events) {
      if ('reward' in event) reward += event.reward;
      if (event.type === 'move' || event.type === 'wait' || event.type === 'collision' || event.type === 'food') eventCounts[event.type]++;
      else if (event.type === 'encounter') eventCounts.encounter++;
      else if (event.type === 'battle-turn') {
        eventCounts.battleTurns++;
        if (event.result.outcome) {
          eventCounts.completedBattles++;
          if (event.result.outcome === 'won') eventCounts.wins++;
          else if (event.result.outcome === 'lost') eventCounts.losses++;
          else eventCounts.escaped++;
        }
      }
    }
    for (const entity of world.entities) actionCounts[entity.action]++;
    traceHasher.update(JSON.stringify({ step, entities: world.entities.map(entity => ({ id: entity.id, x: entity.x, z: entity.z, action: entity.action, reward: entity.reward, activity: entity.brain.activity })) }));
  }
  const finalUpdates = sum(world.entities.map(entity => entity.brain.updates));
  const isolation = world.entities.every((entity, index) => world.entities.every((other, otherIndex) => index === otherIndex
    || (entity.brain !== other.brain && entity.brain.activity !== other.brain.activity && entity.brain.readout !== other.brain.readout)));
  return {
    condition: condition.name,
    seed,
    startSha256,
    traceSha256: traceHasher.digest('hex'),
    reward,
    foods: eventCounts.food,
    collisions: eventCounts.collision,
    actionCounts,
    eventCounts,
    releasedCaptureOffers,
    captures: game.dex.caught.length - caughtBefore,
    roster: world.rosterStatus(),
    activity: activityEvidence(world),
    checks: { learningWasFalse: true, readoutUnchanged: !readoutChanged, updatesUnchanged: initialUpdates === 0 && finalUpdates === 0 && maxObservedUpdates === 0,
      initialUpdates, finalUpdates, maxObservedUpdates, brainsObserved: brainBaselines.size, isolatedBrainObjects: isolation },
  };
}

function replayEvidence(graph: Graph, policy: FieldPolicy) {
  const seed = HELD_OUT_SEEDS[0];
  const game = createGame(1, `kanto-replay-${seed}`), source = new OpenWorldSimulation(graph, game, seed, undefined, policy, 15);
  source.setAutoCapture(true);
  for (let tick = 0; tick < 40; tick++) { resolveCaptureDecision(source); source.step({ deltaSeconds: DELTA_SECONDS, learning: false, epsilon: 0 }); resolveCaptureDecision(source); }
  const checkpoint = serializeOpenWorld(game, source);
  const a = restoreOpenWorld(graph, checkpoint, policy), b = restoreOpenWorld(graph, checkpoint, policy);
  const traceA = [], traceB = [];
  for (let tick = 0; tick < 24; tick++) {
    resolveCaptureDecision(a.simulation); resolveCaptureDecision(b.simulation);
    const stepA = a.simulation.step({ deltaSeconds: DELTA_SECONDS, learning: false, epsilon: 0 }), snapshotA = a.simulation.snapshot();
    const stepB = b.simulation.step({ deltaSeconds: DELTA_SECONDS, learning: false, epsilon: 0 }), snapshotB = b.simulation.snapshot();
    traceA.push({ step: stepA, snapshotSha256: jsonHash(snapshotA), activitySha256: jsonHash(snapshotA.entities.map(entity => entity.brain.activity)) });
    traceB.push({ step: stepB, snapshotSha256: jsonHash(snapshotB), activitySha256: jsonHash(snapshotB.entities.map(entity => entity.brain.activity)) });
    resolveCaptureDecision(a.simulation); resolveCaptureDecision(b.simulation);
  }
  const finalA = serializeOpenWorld(a.game, a.simulation), finalB = serializeOpenWorld(b.game, b.simulation);
  return { seed, checkpoint, trace: traceA, checkpointSha256: hash(checkpoint), traceSha256: jsonHash(traceA), exactTrace: JSON.stringify(traceA) === JSON.stringify(traceB), exactFinalCheckpoint: finalA === finalB };
}

async function main() {
  const graphPath = resolve('public/data/connectome.json'), policyPath = resolve('public/data/openworld-policy.json');
  const graphBytes = await readFile(graphPath), policyBytes = await readFile(policyPath);
  const graph = JSON.parse(graphBytes.toString('utf8')) as Graph, deployedPolicy = JSON.parse(policyBytes.toString('utf8')) as FieldPolicy;
  const initialSource = new OpenWorldSimulation(graph, createGame(1, 'openworld-training'), INITIAL_POLICY_SEED, undefined, undefined, 12);
  const companion = initialSource.entities.find(entity => entity.kind === 'companion');
  if (!companion) throw new Error('Unable to reconstruct the initial companion readout.');
  const initialPolicy = policyFromBrain(graph, companion.brain);
  const edgeZero = structuredClone(graph); edgeZero.edges = edgeZero.edges.map(edge => ({ ...edge, weight: 0 }));
  const conditions: Condition[] = [
    { name: 'random-epsilon1', graph, policy: deployedPolicy, epsilon: 1 },
    { name: 'initial-readout', graph, policy: initialPolicy, epsilon: 0 },
    { name: 'deployed-readout', graph, policy: deployedPolicy, epsilon: 0 },
    { name: 'edgezero-ablation', graph: edgeZero, policy: deployedPolicy, epsilon: 0 },
  ];
  const runs = conditions.flatMap(condition => HELD_OUT_SEEDS.map(seed => run(condition, seed)));
  const startsPerSeed = HELD_OUT_SEEDS.map(seed => ({ seed, hashes: runs.filter(run => run.seed === seed).map(run => run.startSha256) }));
  const replay = replayEvidence(graph, deployedPolicy);
  const deployed = runs.filter(run => run.condition === 'deployed-readout'), ablated = runs.filter(run => run.condition === 'edgezero-ablation');
  const graphBytesAfter = await readFile(graphPath), policyBytesAfter = await readFile(policyPath);
  const checks = {
    sameStartAcrossConditions: startsPerSeed.every(row => new Set(row.hashes).size === 1),
    allEvaluationFrozen: runs.every(run => run.checks.learningWasFalse && run.checks.readoutUnchanged && run.checks.updatesUnchanged),
    allBrainsIsolated: runs.every(run => run.checks.isolatedBrainObjects && run.activity.distinctEntityActivityStates > 1),
    recurrentActivityNonZero: deployed.every(run => run.activity.maxAbsActivity > 1e-9 && run.activity.maxAbsRecurrentReadoutContribution > 1e-9),
    edgeAblationChangesActivityAndTrace: deployed.every((run, index) => run.activity.activitySha256 !== ablated[index].activity.activitySha256 && run.traceSha256 !== ablated[index].traceSha256),
    exactReplay: replay.exactTrace && replay.exactFinalCheckpoint,
    graphUsesStringNodeIds: graph.nodes.every(node => typeof node === 'string'),
    graphHasMeasuredEdges: graph.edges.length > 0 && graph.edges.some(edge => Math.abs(edge.weight) > 0),
    inputFilesUnchanged: graphBytes.equals(graphBytesAfter) && policyBytes.equals(policyBytesAfter),
  };
  const averages = Object.fromEntries(conditions.map(condition => {
    const rows = runs.filter(run => run.condition === condition.name);
    return [condition.name, { reward: sum(rows.map(row => row.reward)) / rows.length, foods: sum(rows.map(row => row.foods)) / rows.length,
      collisions: sum(rows.map(row => row.collisions)) / rows.length, encounters: sum(rows.map(row => row.eventCounts.encounter)) / rows.length,
      completedBattles: sum(rows.map(row => row.eventCounts.completedBattles)) / rows.length, captures: sum(rows.map(row => row.captures)) / rows.length }];
  }));
  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    graph: { id: graph.id, kind: graph.kind, nodes: graph.nodes.length, edges: graph.edges.length, fileSha256: hash(graphBytes), provenance: graph.provenance, sourceFiles: (graph as Graph & { sourceFiles?: unknown }).sourceFiles },
    deployedPolicy: { fileSha256: hash(policyBytes), trainingSeed: deployedPolicy.trainingSeed, note: deployedPolicy.note },
    protocol: { heldOutSeeds: HELD_OUT_SEEDS, ticksPerSeed: TICKS, deltaSeconds: DELTA_SECONDS, learning: false, sameMapAndStartPerSeed: true,
      conditions: { random: 'published input/readout with epsilon=1', initialReadout: `deterministic pre-learning policy reconstructed at training seed ${INITIAL_POLICY_SEED}`,
        deployedReadout: 'unchanged public/data/openworld-policy.json', edgeZero: 'published policy with every recurrent graph edge weight set to zero in memory' },
      captureDecision: 'setAutoCapture(true); if a captureOffer remains, deterministically call releaseVictory() before the next step',
      reward: '-0.005/tick, target progress * 0.05, -0.2 collision, +1.5 food; battle reward is handled by the game battle system',
    },
    averages,
    runs,
    replay: { seed: replay.seed, checkpointSha256: replay.checkpointSha256, traceSha256: replay.traceSha256, exactTrace: replay.exactTrace, exactFinalCheckpoint: replay.exactFinalCheckpoint },
    checks,
    interpretation: 'Descriptive bounded game evaluation only. The MaleCNS subset supplies recurrent topology and weights. Sensory projection, dynamics, action mapping, rewards, battle fallbacks and capture handling are engineered and do not establish biological learning or a biological sensorimotor mapping.',
  };
  const outputArgument = process.argv.indexOf('--out'), outputDirectory = resolve(outputArgument >= 0 ? process.argv[outputArgument + 1] : `artifacts/kanto-evidence-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(outputDirectory, { recursive: false });
  await writeFile(resolve(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(outputDirectory, 'checkpoint.json'), replay.checkpoint + '\n');
  await writeFile(resolve(outputDirectory, 'replay-trace.json'), JSON.stringify(replay.trace, null, 2) + '\n');
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  console.log(JSON.stringify({ outputDirectory, averages, checks }, null, 2));
  if (failed.length) throw new Error(`Kanto evidence checks failed: ${failed.join(', ')}`);
}

await main();
