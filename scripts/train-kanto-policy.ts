import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import type { BrainState, Graph } from '../src/core/brain.ts';
import { createGame, heal } from '../src/game/engine.ts';
import { FIELD_MODEL, type FieldPolicy } from '../src/game/field.ts';
import { OpenWorldSimulation, restoreOpenWorld, serializeOpenWorld } from '../src/openworld/simulation.ts';

const TRAINING = [{ seed: 7_319_003, ticks: 1_250 }, { seed: 7_319_107, ticks: 1_250 }];
const EVALUATION_SEEDS = [9_411_007, 9_411_109];
const EVALUATION_TICKS = 240;
const DELTA_SECONDS = .25;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value: unknown) => hash(JSON.stringify(value));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function policyFromBrain(graph: Graph, brain: Readonly<BrainState>, note: string): FieldPolicy {
  return { schema: 1, model: FIELD_MODEL, graphId: graph.id, trainingSeed: TRAINING[0].seed,
    inputWeights: structuredClone(brain.inputWeights), readout: structuredClone(brain.readout), note };
}

function resolveCaptureOffer(world: OpenWorldSimulation): number {
  if (!world.game.captureOffer) return 0;
  world.releaseVictory();
  return 1;
}

function runStep(world: OpenWorldSimulation, learning: boolean, epsilon: number) {
  const releasedBefore = resolveCaptureOffer(world);
  const step = world.step({ deltaSeconds: DELTA_SECONDS, learning, epsilon });
  const releasedAfter = resolveCaptureOffer(world);
  let completedBattles = 0, wins = 0, losses = 0;
  for (const event of step.events) if (event.type === 'battle-turn' && event.result.outcome) {
    completedBattles++;
    if (event.result.outcome === 'won') wins++;
    if (event.result.outcome === 'lost') losses++;
  }
  if (completedBattles && !world.game.battle) heal(world.game);
  return { step, completedBattles, wins, losses, releasedOffers: releasedBefore + releasedAfter };
}

function trainSegment(graph: Graph, startingPolicy: FieldPolicy, seed: number, ticks: number) {
  const game = createGame(1, `kanto-training-${seed}`), world = new OpenWorldSimulation(graph, game, seed, undefined, startingPolicy, 15);
  world.setAutoCapture(true);
  let reward = 0, collisions = 0, foods = 0, encounters = 0, completedBattles = 0, wins = 0, losses = 0, releasedOffers = 0;
  const start = performance.now();
  for (let tick = 0; tick < ticks; tick++) {
    const result = runStep(world, true, .12);
    completedBattles += result.completedBattles; wins += result.wins; losses += result.losses; releasedOffers += result.releasedOffers;
    for (const event of result.step.events) {
      if ('reward' in event) reward += event.reward;
      if (event.type === 'collision') collisions++;
      if (event.type === 'food') foods++;
      if (event.type === 'encounter') encounters++;
    }
  }
  const companion = world.entities.find(entity => entity.kind === 'companion');
  if (!companion || companion.brain.updates <= 0) throw new Error(`Training seed ${seed} produced no companion readout updates.`);
  const policy = policyFromBrain(graph, companion.brain,
    `Candidate engineering Q-learning readout continued from the deployed policy for ${TRAINING.reduce((total, row) => total + row.ticks, 0)} Kanto auto-hunt ticks. Training seeds ${TRAINING.map(row => row.seed).join(', ')}; epsilon 0.12; deterministic post-battle heal and capture-offer resolution.`);
  return { policy, profile: { seed, ticks, elapsedMs: performance.now() - start, companionUpdates: companion.brain.updates, reward, collisions, foods, encounters, completedBattles, wins, losses, releasedOffers } };
}

function comparableStart(world: OpenWorldSimulation) {
  const snapshot = world.snapshot();
  return jsonHash({ player: snapshot.player, foods: snapshot.foods, entities: snapshot.entities.map(({ brain: _brain, ...entity }) => entity), spawnSerial: snapshot.spawnSerial, mapVersion: snapshot.mapVersion });
}

function evaluate(graph: Graph, policy: FieldPolicy, label: 'deployed' | 'candidate', seed: number) {
  const game = createGame(1, `kanto-candidate-eval-${seed}`), world = new OpenWorldSimulation(graph, game, seed, undefined, policy, 15);
  world.setAutoCapture(true);
  const caughtBefore = game.dex.caught.length;
  const startSha256 = comparableStart(world), baselines = new Map<string, string>();
  let changed = false, maxUpdates = 0, reward = 0, collisions = 0, foods = 0, encounters = 0, completedBattles = 0, wins = 0, losses = 0, releasedOffers = 0;
  const traceHasher = createHash('sha256');
  const observe = () => world.entities.forEach(entity => {
    const digest = jsonHash({ inputWeights: entity.brain.inputWeights, readout: entity.brain.readout });
    const previous = baselines.get(entity.id); if (previous === undefined) baselines.set(entity.id, digest); else if (previous !== digest) changed = true;
    maxUpdates = Math.max(maxUpdates, entity.brain.updates);
  });
  observe();
  for (let tick = 0; tick < EVALUATION_TICKS; tick++) {
    const result = runStep(world, false, 0); observe();
    completedBattles += result.completedBattles; wins += result.wins; losses += result.losses; releasedOffers += result.releasedOffers;
    for (const event of result.step.events) {
      if ('reward' in event) reward += event.reward;
      if (event.type === 'collision') collisions++;
      if (event.type === 'food') foods++;
      if (event.type === 'encounter') encounters++;
    }
    traceHasher.update(JSON.stringify({ step: result.step, entities: world.entities.map(entity => ({ id: entity.id, x: entity.x, z: entity.z, action: entity.action, activity: entity.brain.activity })) }));
  }
  return { label, seed, startSha256, traceSha256: traceHasher.digest('hex'), reward, collisions, foods, encounters, completedBattles, wins, losses,
    captures: game.dex.caught.length - caughtBefore, releasedOffers, checks: { readoutUnchanged: !changed, updatesRemainZero: maxUpdates === 0, maxUpdates, brainsObserved: baselines.size } };
}

function replay(graph: Graph, policy: FieldPolicy) {
  const seed = EVALUATION_SEEDS[0], game = createGame(1, `kanto-candidate-replay-${seed}`), source = new OpenWorldSimulation(graph, game, seed, undefined, policy, 15);
  source.setAutoCapture(true);
  for (let tick = 0; tick < 60; tick++) runStep(source, false, 0);
  const checkpoint = serializeOpenWorld(game, source), a = restoreOpenWorld(graph, checkpoint, policy), b = restoreOpenWorld(graph, checkpoint, policy);
  const traceA = [], traceB = [];
  for (let tick = 0; tick < 30; tick++) {
    const resultA = runStep(a.simulation, false, 0), resultB = runStep(b.simulation, false, 0);
    traceA.push({ step: resultA.step, snapshotSha256: jsonHash(a.simulation.snapshot()) });
    traceB.push({ step: resultB.step, snapshotSha256: jsonHash(b.simulation.snapshot()) });
  }
  return { checkpoint, trace: traceA, checkpointSha256: hash(checkpoint), traceSha256: jsonHash(traceA), exactTrace: JSON.stringify(traceA) === JSON.stringify(traceB), exactFinalCheckpoint: serializeOpenWorld(a.game, a.simulation) === serializeOpenWorld(b.game, b.simulation) };
}

async function main() {
  const started = performance.now(), graphPath = resolve('public/data/connectome.json'), policyPath = resolve('public/data/openworld-policy.json');
  const graphBytes = await readFile(graphPath), policyBytes = await readFile(policyPath), graph = JSON.parse(graphBytes.toString('utf8')) as Graph;
  const deployedPolicy = JSON.parse(policyBytes.toString('utf8')) as FieldPolicy;
  let candidate = structuredClone(deployedPolicy); const trainingProfiles = [];
  for (const segment of TRAINING) { const trained = trainSegment(graph, candidate, segment.seed, segment.ticks); candidate = trained.policy; trainingProfiles.push(trained.profile); }
  const evaluations = EVALUATION_SEEDS.flatMap(seed => [evaluate(graph, deployedPolicy, 'deployed', seed), evaluate(graph, candidate, 'candidate', seed)]);
  const aggregate = (label: 'deployed' | 'candidate') => {
    const rows = evaluations.filter(row => row.label === label), average = (key: 'reward' | 'collisions' | 'foods' | 'encounters' | 'completedBattles' | 'wins' | 'losses' | 'captures') => sum(rows.map(row => row[key])) / rows.length;
    return { reward: average('reward'), collisions: average('collisions'), foods: average('foods'), encounters: average('encounters'), completedBattles: average('completedBattles'), wins: average('wins'), losses: average('losses'), captures: average('captures') };
  };
  const averages = { deployed: aggregate('deployed'), candidate: aggregate('candidate') };
  const replayResult = replay(graph, candidate);
  const graphAfter = await readFile(graphPath), policyAfter = await readFile(policyPath);
  const checks = {
    trainingSeedsDisjointFromEvaluation: !TRAINING.some(row => EVALUATION_SEEDS.includes(row.seed)),
    sameStartPerEvaluationSeed: EVALUATION_SEEDS.every(seed => new Set(evaluations.filter(row => row.seed === seed).map(row => row.startSha256)).size === 1),
    frozenEvaluation: evaluations.every(row => row.checks.readoutUnchanged && row.checks.updatesRemainZero),
    candidateChangedFromDeployed: jsonHash(candidate.readout) !== jsonHash(deployedPolicy.readout),
    exactCandidateReplay: replayResult.exactTrace && replayResult.exactFinalCheckpoint,
    sourceFilesUnchanged: graphBytes.equals(graphAfter) && policyBytes.equals(policyAfter),
  };
  const recommendation = {
    improvesCollisionAverage: averages.candidate.collisions < averages.deployed.collisions,
    improvesEncounterAverage: averages.candidate.encounters > averages.deployed.encounters,
    improvesWinAverage: averages.candidate.wins > averages.deployed.wins,
    candidateForVisualReview: averages.candidate.collisions < averages.deployed.collisions && averages.candidate.encounters >= averages.deployed.encounters,
  };
  const outputArgument = process.argv.indexOf('--out'), outputDirectory = resolve(outputArgument >= 0 ? process.argv[outputArgument + 1] : `artifacts/kanto-policy-candidate-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(outputDirectory, { recursive: false });
  const candidatePayload = JSON.stringify(candidate, null, 2) + '\n';
  const report = { schema: 1, generatedAt: new Date().toISOString(), graph: { id: graph.id, nodes: graph.nodes.length, edges: graph.edges.length, fileSha256: hash(graphBytes), provenance: graph.provenance },
    sourcePolicySha256: hash(policyBytes), candidatePolicySha256: hash(candidatePayload), protocol: { training: TRAINING, evaluationSeeds: EVALUATION_SEEDS, evaluationTicks: EVALUATION_TICKS,
      deltaSeconds: DELTA_SECONDS, trainingLearning: true, trainingEpsilon: .12, evaluationLearning: false, evaluationEpsilon: 0,
      automation: 'auto-hunt and auto-capture enabled; unresolved captureOffer released before the next step; heal after each completed battle in training and both evaluation conditions to prevent long-run team-faint stalls' },
    trainingProfiles, evaluations, averages, checks, recommendation, replay: { checkpointSha256: replayResult.checkpointSha256, traceSha256: replayResult.traceSha256, exactTrace: replayResult.exactTrace, exactFinalCheckpoint: replayResult.exactFinalCheckpoint },
    elapsedMs: performance.now() - started, interpretation: 'Engineering-policy candidate only. Reward and gameplay differences are not evidence of biological learning.' };
  await writeFile(resolve(outputDirectory, 'candidate-policy.json'), candidatePayload);
  await writeFile(resolve(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(outputDirectory, 'checkpoint.json'), replayResult.checkpoint + '\n');
  await writeFile(resolve(outputDirectory, 'replay-trace.json'), JSON.stringify(replayResult.trace, null, 2) + '\n');
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  console.log(JSON.stringify({ outputDirectory, elapsedMs: report.elapsedMs, trainingProfiles, averages, checks, recommendation }, null, 2));
  if (failed.length) throw new Error(`Kanto candidate integrity checks failed: ${failed.join(', ')}`);
}

await main();
