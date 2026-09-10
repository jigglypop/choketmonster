import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Graph } from '../src/core/brain.ts';
import { createGame, createMonster } from '../src/game/engine.ts';
import { FIELD_MODEL, type FieldPolicy } from '../src/game/field.ts';
import { OpenWorldSimulation, movementSpeed, restoreOpenWorld, serializeOpenWorld } from '../src/openworld/simulation.ts';

const TRAINING_SEED = 7_711_003;
const TRAINING_TICKS = 2_000;
const EVALUATION_SEEDS = [8_211_001, 8_211_101];
const EVALUATION_TICKS = 100;

type Metrics = { foods: number; collisions: number; reward: number; actions: number[] };

function evaluate(graph: Graph, policy: FieldPolicy | undefined, epsilon = 0): Metrics & { perSeed: Array<Metrics & { seed: number }> } {
  const perSeed = EVALUATION_SEEDS.map(seed => {
    const world = new OpenWorldSimulation(graph, createGame(1, `openworld-eval-${seed}`), seed, undefined, policy, 12); world.setAutoHunt(false);
    let reward = 0; const actions = Array(5).fill(0);
    for (let tick = 0; tick < EVALUATION_TICKS; tick++) {
      const step = world.step({ deltaSeconds: .25, learning: false, epsilon });
      for (const event of step.events) if ('reward' in event) reward += event.reward;
      for (const entity of world.entities) actions[entity.action]++;
    }
    return { seed, foods: world.entities.reduce((sum, entity) => sum + entity.foods, 0), collisions: world.entities.reduce((sum, entity) => sum + entity.collisions, 0), reward, actions };
  });
  return {
    foods: perSeed.reduce((sum, row) => sum + row.foods, 0), collisions: perSeed.reduce((sum, row) => sum + row.collisions, 0),
    reward: perSeed.reduce((sum, row) => sum + row.reward, 0), actions: perSeed.reduce((sum, row) => sum.map((value, index) => value + row.actions[index]), Array(5).fill(0)), perSeed,
  };
}

async function main() {
  const graph = JSON.parse(await readFile(resolve('public/data/connectome.json'), 'utf8')) as Graph;
  const training = new OpenWorldSimulation(graph, createGame(1, 'openworld-training'), TRAINING_SEED, undefined, undefined, 12); training.setAutoHunt(false);
  for (let tick = 0; tick < TRAINING_TICKS; tick++) training.step({ deltaSeconds: .25, learning: true, epsilon: .12 });
  const learnedBrain = training.entities.find(entity => entity.kind === 'companion')!.brain;
  const learnedPolicy: FieldPolicy = { schema: 1, model: FIELD_MODEL, graphId: graph.id, trainingSeed: TRAINING_SEED,
    inputWeights: structuredClone(learnedBrain.inputWeights), readout: structuredClone(learnedBrain.readout),
    note: 'Engineering Q-learning readout trained for 2,000 open-world ticks with auto-hunt disabled. Inputs, actions, rewards and Speed mapping are game-designed.' };

  const frozen = new OpenWorldSimulation(graph, createGame(1, 'openworld-frozen'), EVALUATION_SEEDS[0], undefined, learnedPolicy, 12); frozen.setAutoHunt(false);
  const frozenBefore = frozen.entities.map(entity => ({ inputWeights: entity.brain.inputWeights, readout: entity.brain.readout, updates: entity.brain.updates }));
  for (let tick = 0; tick < 40; tick++) frozen.step({ deltaSeconds: .25, learning: false });
  const frozenWeights = JSON.stringify(frozenBefore) === JSON.stringify(frozen.entities.map(entity => ({ inputWeights: entity.brain.inputWeights, readout: entity.brain.readout, updates: entity.brain.updates })));

  const replaySource = new OpenWorldSimulation(graph, createGame(1, 'openworld-replay-evidence'), 9_911_001, undefined, learnedPolicy, 12); replaySource.setAutoHunt(false);
  for (let tick = 0; tick < 8; tick++) replaySource.step({ deltaSeconds: .25, learning: false });
  const checkpointJson = serializeOpenWorld(replaySource.game, replaySource);
  const replayA = restoreOpenWorld(graph, checkpointJson, learnedPolicy), replayB = restoreOpenWorld(graph, checkpointJson, learnedPolicy);
  const traceA = Array.from({ length: 20 }, () => replayA.simulation.step({ deltaSeconds: .25, learning: false }));
  const traceB = Array.from({ length: 20 }, () => replayB.simulation.step({ deltaSeconds: .25, learning: false }));
  const exactReplay = JSON.stringify(traceA) === JSON.stringify(traceB) && serializeOpenWorld(replayA.game, replayA.simulation) === serializeOpenWorld(replayB.game, replayB.simulation);

  const isolatedBrains = frozen.entities.every((entity, index) => frozen.entities.every((other, otherIndex) => index === otherIndex || (entity.brain !== other.brain && entity.brain.activity !== other.brain.activity && entity.brain.readout !== other.brain.readout)));
  const edgeZero = structuredClone(graph); edgeZero.edges = edgeZero.edges.map(edge => ({ ...edge, weight: 0 }));
  const results = { random: evaluate(graph, undefined, 1), preTraining: evaluate(graph, undefined), postTraining: evaluate(graph, learnedPolicy), postTrainingEdgeZero: evaluate(edgeZero, learnedPolicy) };

  const runAutoHunt = (seed: number) => {
    const huntGame = createGame(1, `openworld-default-auto-hunt-${seed}`), hunt = new OpenWorldSimulation(graph, huntGame, seed, undefined, learnedPolicy, 12);
    const moneyBefore = huntGame.player.money, xpBefore = huntGame.player.team[0].xp;
    let encounters = 0, completedBattles = 0, wins = 0, replacements = 0, moneyRewards = 0, previousPending = 0;
    for (let tick = 0; tick < 600; tick++) {
      const moneyBeforeStep = huntGame.player.money;
      const step = hunt.step({ deltaSeconds: .25, learning: false });
      moneyRewards += Math.max(0, huntGame.player.money - moneyBeforeStep);
      encounters += step.events.filter(event => event.type === 'encounter').length;
      for (const event of step.events) if (event.type === 'battle-turn' && event.result.outcome) { completedBattles++; if (event.result.outcome === 'won') wins++; }
      const pending = hunt.rosterStatus().pending; if (pending < previousPending) replacements += previousPending - pending; previousPending = pending;
    }
    return { seed, simulatedSeconds: 150, encounters, completedBattles, wins, replacements, moneyRewards, moneyDelta: huntGame.player.money - moneyBefore,
      xpDelta: huntGame.player.team[0].xp - xpBefore, roster: hunt.rosterStatus(), selectedWildId: hunt.selectedWildId, battleActive: !!huntGame.battle };
  };
  const autoHuntPerSeed = [6_012_044, 6_012_144, 6_012_244].map(runAutoHunt);
  const defaultAutoHunt = { policy: '2,000-tick open-world policy, frozen during held-out evaluation', perSeed: autoHuntPerSeed,
    totals: { encounters: autoHuntPerSeed.reduce((sum, row) => sum + row.encounters, 0), completedBattles: autoHuntPerSeed.reduce((sum, row) => sum + row.completedBattles, 0),
      wins: autoHuntPerSeed.reduce((sum, row) => sum + row.wins, 0), replacements: autoHuntPerSeed.reduce((sum, row) => sum + row.replacements, 0),
      moneyRewards: autoHuntPerSeed.reduce((sum, row) => sum + row.moneyRewards, 0), moneyDelta: autoHuntPerSeed.reduce((sum, row) => sum + row.moneyDelta, 0), xpDelta: autoHuntPerSeed.reduce((sum, row) => sum + row.xpDelta, 0) } };

  const battleGame = createGame(1, 'openworld-battle-evidence'); battleGame.player.team = [createMonster(battleGame, 1, 16)];
  const battleWorld = new OpenWorldSimulation(graph, battleGame, 9, undefined, learnedPolicy, 12), target = battleWorld.entities.find(entity => entity.kind === 'wild')!;
  const moneyBefore = battleGame.player.money, xpBefore = battleGame.player.team[0].xp;
  battleWorld.startEncounter(target.id); battleWorld.requestAction({ type: 'move', index: 0 });
  let battleOutcome: string | undefined, firstPlayerAction: unknown;
  for (let turn = 0; turn < 500 && battleGame.battle; turn++) for (const event of battleWorld.step({ deltaSeconds: 1 }).events) if (event.type === 'battle-turn') {
    firstPlayerAction ??= event.result.playerAction; battleOutcome = event.result.outcome ?? battleOutcome;
  }

  const report = {
    schema: 1, model: 'pokemon-open-world-recurrent-v1', generatedAt: new Date().toISOString(),
    graph: { id: graph.id, kind: graph.kind, nodes: graph.nodes.length, edges: graph.edges.length, provenance: graph.provenance },
    protocol: { trainingSeed: TRAINING_SEED, trainingTicks: TRAINING_TICKS, evaluationSeeds: EVALUATION_SEEDS, evaluationTicksPerSeed: EVALUATION_TICKS, evaluationLearning: false,
      randomPolicy: 'epsilon=1 during frozen evaluation; actions ignore readout argmax but still advance recurrent state',
      speedFormula: 'worldUnitsPerSecond = 1.2 + baseStats.speed * 0.018', reward: '-0.005/tick, target progress * 0.05, -0.2 collision, +1.5 food' },
    results, defaultAutoHunt,
    checks: { frozenWeights, exactReplay, isolatedBrains, checkpointContainsGraphEdges: checkpointJson.includes('"edges"'),
      edgeAblationChangesTrace: JSON.stringify(results.postTraining.perSeed.map(row => row.actions)) !== JSON.stringify(results.postTrainingEdgeZero.perSeed.map(row => row.actions)),
      beginnerRoster: replaySource.entities.filter(entity => entity.kind === 'wild').slice(0, 3).map(entity => ({ speciesId: entity.speciesId, level: entity.level, distance: Math.hypot(entity.x, entity.z) })),
      speedExamples: { species1: movementSpeed(1), species150: movementSpeed(150) },
      battle: { outcome: battleOutcome, firstPlayerAction, moneyDelta: battleGame.player.money - moneyBefore, xpDelta: battleGame.player.team[0].xp - xpBefore, speciesAfter: battleGame.player.team[0].speciesId, moveCount: battleGame.player.team[0].moves.length } },
    limitations: 'This is a bounded descriptive game experiment. Sensory projection, dynamics, Speed formula, action mapping, reward and Q-learning are engineered. MaleCNS subset edges supply recurrent topology and weights; results do not establish a biological sensorimotor mapping or biological learning.',
  };
  const outIndex = process.argv.indexOf('--out'), outPath = resolve(outIndex >= 0 ? process.argv[outIndex + 1] : 'artifacts/openworld-validation-2026-09-10/report.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(dirname(outPath), 'openworld-policy.json'), JSON.stringify(learnedPolicy, null, 2) + '\n');
  await writeFile(resolve('public/data/openworld-policy.json'), JSON.stringify(learnedPolicy, null, 2) + '\n');
  await writeFile(resolve(dirname(outPath), 'checkpoint.json'), checkpointJson + '\n');
  await writeFile(resolve(dirname(outPath), 'replay-trace.json'), JSON.stringify(traceA, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); console.log(`wrote ${outPath}`);
}

await main();
