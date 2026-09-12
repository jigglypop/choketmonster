import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Brain, type Graph, type BrainState } from '../src/core/brain';
import { Random } from '../src/core/random';
import { createGame, createMonster, actBattle, type Monster } from '../src/game/engine';
import { getMove, getSpecies } from '../src/data/pokemon';
import { calculateDamage } from '../src/game/battle';
import { ConnectomeController } from '../src/game/connectome';
import { rewardBattleTurn } from '../src/game/rewards';

// Controlled fixtures test move-selection learning. They do not alter or grant anything to a user save.
const graph = JSON.parse(await readFile('public/data/connectome.json', 'utf8')) as Graph;
const controller = new ConnectomeController(graph);
const SEEDS = [43, 137, 281], TRAIN = 24, EVAL = 8, MAX_TURNS = 80;
type Policy = 'random' | 'heuristic' | 'frozen' | 'trained';
const FOES = [2, 5, 8, 20, 24, 25, 28, 44, 53, 57, 61, 76];
const MOVE_IDS = [53, 14, 105, 77] as const;
const CATEGORY = ['attack', 'buff', 'healing', 'status'] as const;
const combatant = (m: Monster) => ({ ...m, types: getSpecies(m.speciesId).types });

function episode(checkpoint: BrainState, seed: number, policy: Policy, learning = false, trace = false) {
  const game = createGame(1, seed), rng = new Random(seed);
  const self = createMonster(game, 2, 35), enemy = createMonster(game, FOES[rng.int(FOES.length)], 35);
  self.moves = MOVE_IDS.map(moveId => ({ moveId, pp: getMove(moveId).pp }));
  game.player.team = [self]; self.brain = structuredClone(checkpoint);
  controller.reset(self, seed ^ 8873); controller.reset(enemy, seed ^ 2933);
  game.dex.seen = [1, 2, enemy.speciesId]; game.dex.caught = [1, 2];
  game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
  let reward: number | null = null, totalReward = 0, outcome = 'timeout', steps = 0;
  const choices = [0, 0, 0, 0, 0], effective = [0, 0, 0, 0];
  const frames: unknown[] = [];
  for (; steps < MAX_TURNS && game.battle; steps++) {
    const battle = game.battle, beforeSelf = self.hp, beforeEnemy = enemy.hp;
    const enemyChoice = controller.choose(enemy, self, battle.turn, null, false, { selfStatStages: battle.statStages?.[enemy.instanceId], otherStatStages: battle.statStages?.[self.instanceId] }).action;
    let action: number;
    if (policy === 'random') action = rng.int(5);
    else if (policy === 'heuristic') action = calculateDamage(combatant(self), combatant(enemy), getMove(self.moves[0].moveId)).damage > 0 ? 0 : 4;
    else action = controller.choose(self, enemy, battle.turn, reward, learning, { selfStatStages: battle.statStages?.[self.instanceId], otherStatStages: battle.statStages?.[enemy.instanceId] }).action;
    choices[action]++;
    const result = actBattle(game, action === 4 ? { type: 'wait' } : { type: 'move', index: action }, enemyChoice);
    const move = result.executedMoves.find(entry => entry.actorInstanceId === self.instanceId);
    if (action < 4 && (move?.damage || move?.strategicEffect)) effective[action]++;
    const afterSelf = result.outcome === 'lost' ? 0 : self.hp;
    reward = rewardBattleTurn({ individualId: self.instanceId, decisionSource: 'connectome', learningEnabled: learning,
      selfHpBefore: beforeSelf, selfHpAfter: afterSelf, selfMaxHp: self.stats.hp, opponentHpBefore: beforeEnemy, opponentHpAfter: enemy.hp, opponentMaxHp: enemy.stats.hp,
      chosenAttackType: move?.moveType, defenderTypes: getSpecies(enemy.speciesId).types, damagingMove: move?.damagingMove, actionExecuted: move?.executed, attackHit: move?.hit,
      typeEffectiveness: move?.typeMultiplier, moveCategory: move?.category, hpRecovered: move?.hpRecovered, statStageDelta: move?.statStageDelta,
      ailmentApplied: move?.ailmentApplied, strategicEffect: move?.strategicEffect, outcome: result.outcome }).total;
    totalReward += reward; if (result.battleEnded) outcome = result.outcome!;
    if (trace) frames.push({ step: steps, action, enemyChoice, gameRng: game.rngState, selfHp: afterSelf, enemyHp: enemy.hp, reward, move, outcome: result.outcome ?? null, activity: self.brain!.activity, brainRng: self.brain!.rng });
  }
  controller.finish(self, reward ?? 0, learning);
  return { outcome, steps, totalReward, choices, effective, checkpoint: self.brain!, frames };
}

const samples: { seed: number; policy: Policy; wins: number; losses: number; timeouts: number; meanReward: number; meanTurns: number; choices: Record<string, number>; effective: Record<string, number> }[] = [];
let frozenChecks = 0; const brains: Record<string, BrainState> = {};
for (const seed of SEEDS) {
  const initial = new Brain(seed, graph); initial.state.sensoryBypass = false;
  const untrained = initial.snapshot(); let trained = initial.snapshot();
  for (let ep = 0; ep < TRAIN; ep++) trained = episode(trained, seed * 1000 + ep, 'trained', true).checkpoint;
  brains[String(seed)] = trained;
  for (const policy of ['random', 'heuristic', 'frozen', 'trained'] as const) {
    const checkpoint = policy === 'trained' ? trained : untrained, before = JSON.stringify(checkpoint.readout), updates = checkpoint.updates;
    const results = Array.from({ length: EVAL }, (_, i) => episode(checkpoint, 910_000 + i, policy));
    for (const result of results) { if (JSON.stringify(result.checkpoint.readout) !== before || result.checkpoint.updates !== updates) throw new Error('Evaluation mutated weights'); frozenChecks++; }
    const sum = (key: 'choices' | 'effective', index: number) => results.reduce((total, result) => total + result[key][index], 0);
    samples.push({ seed, policy, wins: results.filter(r => r.outcome === 'won').length, losses: results.filter(r => r.outcome === 'lost').length,
      timeouts: results.filter(r => r.outcome === 'timeout').length, meanReward: results.reduce((sum, r) => sum + r.totalReward, 0) / EVAL, meanTurns: results.reduce((sum, r) => sum + r.steps, 0) / EVAL,
      choices: Object.fromEntries([...CATEGORY, 'wait'].map((name, index) => [name, sum('choices', index)])), effective: Object.fromEntries(CATEGORY.map((name, index) => [name, sum('effective', index)])) });
  }
}
const replayInitial = new Brain(SEEDS[0], graph); replayInitial.state.sensoryBypass = false;
const a = episode(replayInitial.snapshot(), 910_000, 'frozen', false, true), b = episode(replayInitial.snapshot(), 910_000, 'frozen', false, true);
const exact = JSON.stringify(a) === JSON.stringify(b); if (!exact) throw new Error('Battle replay did not reproduce exactly');
const sha256 = createHash('sha256').update(JSON.stringify(a.frames)).digest('hex');
const report = { schema: 2, model: 'pokemon-recurrent-v1', graph: graph.id, protocol: { brainSeeds: SEEDS, trainingEpisodes: TRAIN, evaluationSeeds: Array.from({ length: EVAL }, (_, i) => 910_000 + i), maxTurns: MAX_TURNS,
  body: 'Ivysaur level 35 with fixed attack/buff/recovery/status slots versus 12 possible level-35 species; rebuilt each episode.', inputs: '12-column schema retained; four move columns combine PP, matchup/immunity, recovery need, stage headroom and ailment applicability.',
  reward: 'bounded engineered damage, received damage, type choice, successful strategic effect and terminal outcome; evaluated weights frozen', unit: 'brain initialization seed; episodes within a brain seed are not independent training replications' },
  samples, frozenChecks, replay: { exact, sha256, frames: a.frames.length }, limitation: 'Small controlled game benchmark. Move effects, senses and Q-learning are engineered; this is not biological learning evidence.' };
const stamp = new Date().toISOString().replace(/[:.]/g, '-'), output = `artifacts/battle-moves-${stamp}`;
await mkdir(output, { recursive: true });
await Promise.all([writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n'), writeFile(`${output}/replay.json`, JSON.stringify({ initial: replayInitial.snapshot(), seed: 910_000, policy: 'frozen', result: a }, null, 2) + '\n'), ...Object.entries(brains).map(([seed, brain]) => writeFile(`${output}/brain-${seed}.json`, JSON.stringify(brain, null, 2) + '\n'))]);
console.log(JSON.stringify({ output, ...report }, null, 2));
