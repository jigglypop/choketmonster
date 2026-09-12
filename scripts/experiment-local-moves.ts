import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Random } from '../src/core/random.ts';
import type { Graph } from '../src/core/brain.ts';
import { calculateDamage } from '../src/game/battle.ts';
import { automatedMoveMask, ConnectomeController } from '../src/game/connectome.ts';
import { actBattle, createGame, createMonster, type Monster } from '../src/game/engine.ts';
import { getMove, getSpecies } from '../src/data/pokemon.ts';
import { rewardBattleTurn } from '../src/game/rewards.ts';

type Step = { creatureId: string; requestId: string; episodeId: string; inputs: number[]; available: boolean[]; reward: number | null; learning: boolean; terminal: boolean; checkpoint?: string; checkpointId?: string; returnCheckpoint: boolean };
type Decision = { decision: { action: number; updates: number; activity: number; elapsedMs: number; graphId: string; nodes: number; edges: number }; checkpoint?: string };
type Policy = 'random' | 'frozen' | 'trained';
const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const ORIGIN = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const BRAIN_SEEDS = [43, 137], TRAIN_EPISODES = 6, EVAL_SEEDS = [920001, 920002, 920003, 920004], MAX_TURNS = 24;
const MOVES = [53, 14, 105, 77] as const, CATEGORIES = ['attack', 'buff', 'healing', 'status'] as const;
const FOES = [5, 8, 20, 24, 28, 44, 53, 57];
const graph = JSON.parse(await readFile('public/data/connectome.json', 'utf8')) as Graph;
const controller = new ConnectomeController(graph);
let calls = 0, serverElapsedMs = 0, warmCheckpointOnlyRequests = 0, cacheMisses = 0;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function post(clientId: string, step: Step, recoveryCheckpoint?: string): Promise<Decision> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const request = attempt === 0 ? step : { ...step, checkpoint: recoveryCheckpoint };
    const started = performance.now();
    const response = await fetch(`${BASE}/api/local-brains/step-batch`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ clientId, steps: [request] }), signal: AbortSignal.timeout(120_000) });
    serverElapsedMs += performance.now() - started; calls++;
    const body = await response.json().catch(() => ({}));
    if (response.status === 428 && attempt === 0 && !step.checkpoint && recoveryCheckpoint) { cacheMisses++; continue; }
    if (!response.ok) throw new Error(`local brain ${response.status}: ${body.message ?? body.code ?? 'unknown error'}`);
    return body.decisions[0] as Decision;
  }
  throw new Error('Checkpoint recovery failed');
}

function fixture(seed: number) {
  const game = createGame(1, seed), rng = new Random(seed), self = createMonster(game, 2, 35), enemy = createMonster(game, FOES[rng.int(FOES.length)], 35);
  self.moves = MOVES.map(moveId => ({ moveId, pp: getMove(moveId).pp })); game.player.team = [self];
  game.battle = { kind: 'wild', regionId: game.regionId, player: { team: [self], activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
  return { game, self, enemy, rng };
}
const combatant = (monster: Monster) => ({ ...monster, types: getSpecies(monster.speciesId).types });
function enemyAction(self: Monster, enemy: Monster, turn: number, stages: NonNullable<ReturnType<typeof fixture>['game']['battle']>['statStages']) {
  const mask = automatedMoveMask(enemy, self, turn, { automatic: true, selfStatStages: stages?.[enemy.instanceId], otherStatStages: stages?.[self.instanceId] });
  const choices = enemy.moves.map((slot, index) => ({ index, allowed: mask[index], damage: slot ? calculateDamage(combatant(enemy), combatant(self), getMove(slot.moveId)).damage : 0 })).filter(row => row.allowed).sort((a, b) => b.damage - a.damage || a.index - b.index);
  return choices[0]?.index ?? mask.findIndex(Boolean);
}
function battleReward(self: Monster, enemy: Monster, beforeSelf: number, beforeEnemy: number, result: ReturnType<typeof actBattle>, learning: boolean) {
  const move = result.executedMoves.find(entry => entry.actorInstanceId === self.instanceId), afterSelf = result.outcome === 'lost' ? 0 : self.hp;
  return rewardBattleTurn({ individualId: self.instanceId, decisionSource: 'connectome', learningEnabled: learning,
    selfHpBefore: beforeSelf, selfHpAfter: afterSelf, selfMaxHp: self.stats.hp, opponentHpBefore: beforeEnemy, opponentHpAfter: enemy.hp, opponentMaxHp: enemy.stats.hp,
    chosenAttackType: move?.moveType, defenderTypes: getSpecies(enemy.speciesId).types, damagingMove: move?.damagingMove, actionExecuted: move?.executed,
    attackHit: move?.hit, typeEffectiveness: move?.typeMultiplier, moveCategory: move?.category, hpRecovered: move?.hpRecovered,
    statStageDelta: move?.statStageDelta, ailmentApplied: move?.ailmentApplied, strategicEffect: move?.strategicEffect, outcome: result.outcome }).total;
}

async function bootstrap(brainSeed: number) {
  const creatureId = `brain-${brainSeed}`, episodeId = `bootstrap-${brainSeed}`, requestId = `bootstrap-${brainSeed}`;
  const decision = await post(hash(`bootstrap-client-${brainSeed}`), { creatureId, requestId, episodeId, inputs: Array(12).fill(0), available: [true, true, true, true, false], reward: null, learning: false, terminal: true, checkpointId: undefined, returnCheckpoint: true });
  if (!decision.checkpoint || decision.decision.nodes < 100_000) throw new Error('Full-connectome bootstrap failed');
  return { checkpoint: decision.checkpoint, checkpointId: requestId, updates: decision.decision.updates, graphId: decision.decision.graphId, nodes: decision.decision.nodes, edges: decision.decision.edges };
}

async function serverEpisode(checkpoint: string, checkpointId: string, brainSeed: number, seed: number, policy: Exclude<Policy, 'random'>, learning: boolean, trace = false) {
  const { game, self, enemy } = fixture(seed), clientId = hash(`${policy}-${brainSeed}-${seed}-${randomUUID()}`), episodeId = `${policy}-${brainSeed}-${seed}`;
  let priorReward: number | null = null, head = checkpointId, recoveryCheckpoint = checkpoint, totalReward = 0, outcome = 'timeout', steps = 0, lastUpdates = -1;
  const choices = [0, 0, 0, 0], effective = [0, 0, 0, 0], frames: unknown[] = [];
  for (; steps < MAX_TURNS && game.battle; steps++) {
    const battle = game.battle, context = { automatic: true, selfStatStages: battle.statStages?.[self.instanceId], otherStatStages: battle.statStages?.[enemy.instanceId] };
    const mask = automatedMoveMask(self, enemy, battle.turn, context), requestId = `r-${brainSeed}-${seed}-${steps}-${randomUUID().slice(0, 8)}`;
    const request: Step = { creatureId: `brain-${brainSeed}`, requestId, episodeId, inputs: controller.observe(self, enemy, battle.turn, context), available: mask, reward: priorReward, learning, terminal: false, checkpointId: head, returnCheckpoint: true };
    if (steps === 0) request.checkpoint = checkpoint;
    else warmCheckpointOnlyRequests++;
    const remote = await post(clientId, request, recoveryCheckpoint); head = requestId; lastUpdates = remote.decision.updates;
    if (!remote.checkpoint) throw new Error('Recovery checkpoint missing');
    recoveryCheckpoint = remote.checkpoint;
    const action = remote.decision.action; if (action >= 4 || !mask[action]) throw new Error('Server selected a masked move'); choices[action]++;
    const beforeSelf = self.hp, beforeEnemy = enemy.hp, result = actBattle(game, { type: 'move', index: action }, enemyAction(self, enemy, battle.turn, battle.statStages));
    const move = result.executedMoves.find(entry => entry.actorInstanceId === self.instanceId); if (move?.damage || move?.strategicEffect) effective[action]++;
    priorReward = battleReward(self, enemy, beforeSelf, beforeEnemy, result, learning); totalReward += priorReward; if (result.battleEnded) outcome = result.outcome!;
    if (trace) frames.push({ turn: steps + 1, action, enemyAction: result.enemyAction, selfHp: self.hp, enemyHp: enemy.hp, reward: priorReward, outcome: result.outcome ?? null, updates: remote.decision.updates, activity: remote.decision.activity });
  }
  const terminalId = `terminal-${brainSeed}-${seed}-${randomUUID().slice(0, 8)}`;
  warmCheckpointOnlyRequests++;
  const terminal = await post(clientId, { creatureId: `brain-${brainSeed}`, requestId: terminalId, episodeId, inputs: Array(12).fill(0), available: [true, true, true, true, false], reward: priorReward, learning, terminal: true, checkpointId: head, returnCheckpoint: true }, recoveryCheckpoint);
  if (!terminal.checkpoint) throw new Error('Terminal checkpoint missing');
  return { outcome, steps, totalReward, choices, effective, checkpoint: terminal.checkpoint, checkpointId: terminalId, updates: terminal.decision.updates, initialObservedUpdates: lastUpdates, frames };
}

function randomEpisode(seed: number) {
  const { game, self, enemy, rng } = fixture(seed); let totalReward = 0, outcome = 'timeout', steps = 0; const choices = [0, 0, 0, 0], effective = [0, 0, 0, 0];
  for (; steps < MAX_TURNS && game.battle; steps++) {
    const battle = game.battle, mask = automatedMoveMask(self, enemy, battle.turn, { automatic: true, selfStatStages: battle.statStages?.[self.instanceId], otherStatStages: battle.statStages?.[enemy.instanceId] });
    const allowed = mask.map((value, index) => value ? index : -1).filter(index => index >= 0), action = allowed[rng.int(allowed.length)]; choices[action]++;
    const beforeSelf = self.hp, beforeEnemy = enemy.hp, result = actBattle(game, { type: 'move', index: action }, enemyAction(self, enemy, battle.turn, battle.statStages));
    const move = result.executedMoves.find(entry => entry.actorInstanceId === self.instanceId); if (move?.damage || move?.strategicEffect) effective[action]++;
    const reward = battleReward(self, enemy, beforeSelf, beforeEnemy, result, false); totalReward += reward; if (result.battleEnded) outcome = result.outcome!;
  }
  return { outcome, steps, totalReward, choices, effective };
}

function summary(seed: number | null, policy: Policy, rows: Array<ReturnType<typeof randomEpisode>>) {
  const sum = (index: number, key: 'choices' | 'effective') => rows.reduce((total, row) => total + row[key][index], 0);
  return { seed, policy, wins: rows.filter(row => row.outcome === 'won').length, losses: rows.filter(row => row.outcome === 'lost').length, timeouts: rows.filter(row => row.outcome === 'timeout').length,
    meanReward: rows.reduce((total, row) => total + row.totalReward, 0) / rows.length, meanTurns: rows.reduce((total, row) => total + row.steps, 0) / rows.length,
    choices: Object.fromEntries(CATEGORIES.map((name, index) => [name, sum(index, 'choices')])), effective: Object.fromEntries(CATEGORIES.map((name, index) => [name, sum(index, 'effective')])) };
}

async function main() {
  const started = performance.now(), stamp = new Date().toISOString().replace(/[:.]/g, '-'), output = resolve(`artifacts/local-moves-${stamp}`), checkpoints: Record<string, unknown> = {}, samples: Array<ReturnType<typeof summary>> = [];
  const randomRows = EVAL_SEEDS.map(randomEpisode); samples.push(summary(null, 'random', randomRows));
  let frozenChecks = 0, replayExact = true, replayFrames: unknown[] = [], replaySha256 = '';
  const training: Array<{ brainSeed: number; episode: number; battleSeed: number; outcome: string; turns: number; reward: number; updates: number }> = [];
  let graphMetadata: { id: string; nodes: number; edges: number } | undefined;
  for (const brainSeed of BRAIN_SEEDS) {
    const initial = await bootstrap(brainSeed);
    graphMetadata ??= { id: initial.graphId, nodes: initial.nodes, edges: initial.edges };
    let current = { checkpoint: initial.checkpoint, checkpointId: initial.checkpointId, updates: initial.updates };
    let trained: Awaited<ReturnType<typeof serverEpisode>> | undefined;
    for (let episode = 0; episode < TRAIN_EPISODES; episode++) {
      const battleSeed = brainSeed * 10_000 + episode;
      trained = await serverEpisode(current.checkpoint, current.checkpointId, brainSeed, battleSeed, 'trained', true);
      current = trained;
      training.push({ brainSeed, episode: episode + 1, battleSeed, outcome: trained.outcome, turns: trained.steps, reward: trained.totalReward, updates: trained.updates });
    }
    if (!trained) throw new Error('Training did not produce a checkpoint');
    checkpoints[String(brainSeed)] = { initial: { checkpoint: initial.checkpoint, checkpointId: initial.checkpointId, updates: initial.updates }, trained: { checkpoint: trained.checkpoint, checkpointId: trained.checkpointId, updates: trained.updates } };
    for (const policy of ['frozen', 'trained'] as const) {
      const base = policy === 'frozen' ? initial : trained, rows = [];
      for (const evalSeed of EVAL_SEEDS) {
        const result = await serverEpisode(base.checkpoint, base.checkpointId, brainSeed, evalSeed, policy, false); if (result.updates !== base.updates || result.initialObservedUpdates !== base.updates) throw new Error('Evaluation mutated updates'); frozenChecks++; rows.push(result);
      }
      samples.push(summary(brainSeed, policy, rows));
    }
    if (brainSeed === BRAIN_SEEDS[0]) {
      const left = await serverEpisode(initial.checkpoint, initial.checkpointId, brainSeed, EVAL_SEEDS[0], 'frozen', false, true), right = await serverEpisode(initial.checkpoint, initial.checkpointId, brainSeed, EVAL_SEEDS[0], 'frozen', false, true);
      replayExact = JSON.stringify(left.frames) === JSON.stringify(right.frames) && left.outcome === right.outcome && left.totalReward === right.totalReward; replayFrames = left.frames; replaySha256 = hash(JSON.stringify(left.frames));
    }
  }
  const frozen = samples.filter(row => row.policy === 'frozen'), trained = samples.filter(row => row.policy === 'trained');
  const totals = (rows: typeof samples) => ({ wins: rows.reduce((sum, row) => sum + row.wins, 0), meanReward: rows.reduce((sum, row) => sum + row.meanReward, 0) / rows.length });
  const frozenTotal = totals(frozen), trainedTotal = totals(trained), improved = trainedTotal.wins > frozenTotal.wins || (trainedTotal.wins === frozenTotal.wins && trainedTotal.meanReward > frozenTotal.meanReward);
  if (!graphMetadata) throw new Error('No graph metadata was observed');
  const report = { schema: 1, model: 'local-full-connectome-move-selection-v1', graph: graphMetadata, protocol: { brainSeeds: BRAIN_SEEDS, trainingEpisodesPerSeed: TRAIN_EPISODES, evaluationSeeds: EVAL_SEEDS, maxTurns: MAX_TURNS, moves: MOVES.map((id, index) => ({ id, name: getMove(id).name, category: CATEGORIES[index] })), commonMask: 'automatedMoveMask for random, frozen, and trained', evaluationLearning: false, independentUnit: 'brain initialization seed' },
    training, samples, invariants: { frozenEvaluationChecks: frozenChecks, warmCheckpointOnlyRequests, cacheMisses }, replay: { exact: replayExact, frames: replayFrames.length, sha256: replaySha256 }, comparison: { frozen: frozenTotal, trained: trainedTotal, improved, claim: improved ? 'This bounded fixture improved by the declared win/reward rule.' : 'This bounded fixture did not improve; no combat-learning improvement is claimed.' }, performance: { apiCalls: calls, apiElapsedMs: Number(serverElapsedMs.toFixed(1)), wallElapsedMs: Number((performance.now() - started).toFixed(1)) }, limitation: 'Game-engineered senses, mask, reward and output learning over a measured connectome. This is not biological learning evidence.' };
  if (!replayExact) throw new Error('Frozen checkpoint replay diverged');
  await mkdir(output, { recursive: true }); await Promise.all([writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n'), writeFile(`${output}/replay.json`, JSON.stringify({ checkpoint: (checkpoints[String(BRAIN_SEEDS[0])] as any).initial, evaluationSeed: EVAL_SEEDS[0], frames: replayFrames, sha256: replaySha256 }, null, 2) + '\n'), writeFile(`${output}/checkpoints.json`, JSON.stringify(checkpoints, null, 2) + '\n')]);
  console.log(JSON.stringify({ output, comparison: report.comparison, replay: report.replay, performance: report.performance }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
