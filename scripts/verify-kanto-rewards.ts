import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { Graph, BrainState } from '../src/core/brain';
import { Random } from '../src/core/random';
import { createGame, createMonster } from '../src/game/engine';
import { ConnectomeController } from '../src/game/connectome';
import type { FieldPolicy } from '../src/game/field';
import { OpenWorldSimulation, serializeOpenWorld, restoreOpenWorld } from '../src/openworld/simulation';

const graphBytes = readFileSync('public/data/connectome.json'), graph = JSON.parse(graphBytes.toString()) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const weights = (brain: BrainState | undefined) => brain ? hash({ input: brain.inputWeights, readout: brain.readout, updates: brain.updates }) : '';
const baseGame = createGame(4, 'reward-comparison');
const base = createMonster(baseGame, 4, 15); base.instanceId = 'mon-1';
base.moves = [{ moveId: 52, pp: 25 }, { moveId: 55, pp: 25 }, { moveId: 33, pp: 35 }, { moveId: 45, pp: 40 }];
new ConnectomeController(graph).ensure(base);
const initial = structuredClone(base.brain!);

function episode(seed: number, source: BrainState, learning: boolean, random = false, edgeZero = false) {
  const activeGraph = structuredClone(graph);
  if (edgeZero) activeGraph.edges.forEach(edge => edge.weight = 0);
  const game = createGame(4, 'reward-comparison'); game.player.team = [structuredClone(base)];
  const lead = game.player.team[0]; lead.brain = structuredClone(source); lead.brain.graph = activeGraph;
  const controller = new ConnectomeController(activeGraph); controller.reset(lead, seed);
  const world = new OpenWorldSimulation(activeGraph, game, seed, undefined, policy, 12);
  // Force a bounded, balanced matchup. No heal, level reset or enemy replacement inside a battle.
  world.startEncounter(world.entities.find(entity => entity.kind === 'wild')!.id);
  const enemy = createMonster(game, seed % 2 ? 43 : 74, 12);
  enemy.moves = [{ moveId: 33, pp: 35 }]; game.battle!.enemy.team = [enemy];
  if (!game.dex.seen.includes(enemy.speciesId)) game.dex.seen.push(enemy.speciesId);
  world.setAutoHunt(false); world.setControlMode(random ? 'manual' : 'auto');
  const before = weights(lead.brain), enemyBefore = weights(controller.ensure(enemy).snapshot());
  const rng = new Random(seed), trace = []; let outcome: string | undefined, replayCheckpoint: string | undefined;
  for (let turn = 0; turn < 40 && game.battle; turn++) {
    if (random) world.requestAction({ type: 'move', index: rng.int(4) });
    const step = world.step({ deltaSeconds: 1, learning });
    trace.push(step);
    if (turn === 0) replayCheckpoint = serializeOpenWorld(game, world);
    outcome = step.events.find(event => event.type === 'battle-turn')?.result.outcome ?? outcome;
  }
  const ledger = world.rewardLedgers[lead.instanceId];
  const row = { seed, reward: ledger?.lifetime.total ?? 0, typeReward: ledger?.lifetime.componentTotals.typeChoice ?? 0,
    growth: ledger?.lifetime.componentTotals.growth ?? 0, turns: trace.length, outcome: outcome ?? 'timeout',
    frozen: before === weights(lead.brain) && enemyBefore === weights(enemy.brain), traceSha256: hash(trace),
    isolated: lead.brain !== enemy.brain && lead.brain!.readout !== enemy.brain!.readout,
    activity: Math.max(...lead.brain!.activity.map(Math.abs)), activitySha256: hash(lead.brain!.activity), updates: lead.brain!.updates - source.updates };
  return { row, brain: structuredClone(lead.brain!), world, replayCheckpoint };
}

const trainingSeeds = [921001, 921100], heldoutSeeds = [923001, 923100];
const candidates = trainingSeeds.map(seed => {
  let brain = structuredClone(initial); const rows = [];
  for (let battle = 0; battle < 24; battle++) { const result = episode(seed + battle, brain, true); brain = result.brain; rows.push(result.row); }
  return { seed, brain, rows };
});
const conditions = ['random', 'initial', 'learned', 'edgezero'] as const;
const runs = candidates.flatMap(candidate => conditions.flatMap(condition => heldoutSeeds.map(seed => ({ trainingSeed: candidate.seed, condition,
  ...episode(seed, condition === 'learned' || condition === 'edgezero' ? candidate.brain : initial, false, condition === 'random', condition === 'edgezero').row }))));
const summaries = Object.fromEntries(conditions.map(condition => {
  const rows = runs.filter(row => row.condition === condition);
  return [condition, { meanReward: rows.reduce((sum, row) => sum + row.reward, 0) / rows.length,
    meanTypeReward: rows.reduce((sum, row) => sum + row.typeReward, 0) / rows.length,
    wins: rows.filter(row => row.outcome === 'won').length, losses: rows.filter(row => row.outcome === 'lost').length, timeouts: rows.filter(row => row.outcome === 'timeout').length }];
}));
const checkpoint = episode(923001, candidates[0].brain, false).replayCheckpoint!;
const a = restoreOpenWorld(graph, checkpoint, policy), b = restoreOpenWorld(graph, checkpoint, policy), trace = [];
a.simulation.releaseVictory(); b.simulation.releaseVictory();
for (let tick = 0; tick < 12; tick++) {
  const left = a.simulation.step({ deltaSeconds: .25, learning: false }), right = b.simulation.step({ deltaSeconds: .25, learning: false });
  assert.deepEqual(left, right); trace.push(left);
}
assert.equal(serializeOpenWorld(a.game, a.simulation), serializeOpenWorld(b.game, b.simulation));
const checks = { evaluationFrozen: runs.every(row => row.frozen), isolatedBrains: runs.every(row => row.isolated),
  trainingUpdates: candidates.every(candidate => candidate.brain.updates > initial.updates),
  recurrentActivity: runs.filter(row => row.condition === 'learned').every(row => row.activity > 0),
  edgeAblationChangesActivity: candidates.every(candidate => heldoutSeeds.every(seed => runs.find(row => row.trainingSeed === candidate.seed && row.seed === seed && row.condition === 'learned')!.activitySha256 !== runs.find(row => row.trainingSeed === candidate.seed && row.seed === seed && row.condition === 'edgezero')!.activitySha256)),
  edgeAblationChangesSomeActions: runs.some(row => row.condition === 'learned' && row.traceSha256 !== runs.find(other => other.trainingSeed === row.trainingSeed && other.seed === row.seed && other.condition === 'edgezero')!.traceSha256),
  exactSavedReplay: true, graphUnchanged: hash(readFileSync('public/data/connectome.json').toString()) === hash(graphBytes.toString()) };
const directory = resolve(`artifacts/kanto-rewards-${new Date().toISOString().replace(/[:.]/g, '-')}`); mkdirSync(directory, { recursive: false });
const report = { generatedAt: new Date().toISOString(), graphSha256: hash(graphBytes.toString()), trainingSeeds, heldoutSeeds,
  protocol: { trainingBattlesPerSeed: 24, maxTurnsPerBattle: 40, player: 'Charmander Lv15; ember/water-gun/tackle/growl', enemies: 'alternating Oddish/Geodude Lv12, tackle',
    reset: 'HP, PP, level and episode activity reset between battles; only this individual combat brain transfers; no within-battle healing',
    random: 'uniform four move slots, manual source, frozen; same HP/PP/level/enemy/seed as initial and learned',
    evaluation: 'learning=false; weights and update counters checked for both combatants; movement policy unchanged',
    interpretation: 'Bounded engineered battle task. No claim of general superiority or biological dopamine. Learned candidates remain evidence artifacts; live individuals learn from their own play.' }, summaries, checks, runs, training: candidates.map(({ seed, rows, brain }) => ({ seed, rows, finalUpdates: brain.updates })), checkpointSha256: hash(checkpoint), replayTraceSha256: hash(trace) };
writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${directory}/checkpoint.json`, checkpoint);
writeFileSync(`${directory}/replay.json`, JSON.stringify(trace));
candidates.forEach(candidate => writeFileSync(`${directory}/candidate-${candidate.seed}.json`, JSON.stringify(candidate.brain)));
console.log(JSON.stringify({ directory, summaries, checks }, null, 2));
assert(Object.values(checks).every(Boolean), 'Reward evidence check failed');
