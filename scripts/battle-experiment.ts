import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Brain, type Graph, type BrainState } from '../src/core/brain';
import { Random } from '../src/core/random';
import { createGame, createMonster, actBattle, type Monster } from '../src/game/engine';
import { getMove, getSpecies } from '../src/data/pokemon';
import { calculateDamage } from '../src/game/battle';
import { ConnectomeController } from '../src/game/connectome';

// Controlled level-35 fixtures are benchmark inputs, not rewards added to a save.
const graph = JSON.parse(await readFile('public/data/connectome.json', 'utf8')) as Graph;
const controller = new ConnectomeController(graph);
const SEEDS = [43, 137, 281], TRAIN = 18, EVAL = 6, MAX_TURNS = 100;
type Policy = 'random' | 'heuristic' | 'frozen' | 'trained';
const FOES = [2, 5, 8, 17, 20, 24, 25, 28, 44, 53, 57, 61];
const combatant = (m: Monster) => ({ ...m, types: getSpecies(m.speciesId).types });

function episode(checkpoint: BrainState, seed: number, policy: Policy, learning = false, trace = false) {
  const game = createGame(1, seed), rng = new Random(seed);
  const self = createMonster(game, 2, 35), enemy = createMonster(game, FOES[rng.int(FOES.length)], 35);
  game.player.team = [self]; self.brain = structuredClone(checkpoint);
  controller.reset(self, seed ^ 8873); controller.reset(enemy, seed ^ 2933);
  game.dex.seen = [1, 2, enemy.speciesId]; game.dex.caught = [1, 2];
  game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
  let reward: number | null = null, totalReward = 0, outcome = 'timeout', steps = 0;
  const frames: unknown[] = [];
  for (; steps < MAX_TURNS && game.battle; steps++) {
    const beforeSelf = self.hp, beforeEnemy = enemy.hp;
    const enemyChoice = controller.choose(enemy, self, game.battle.turn).action;
    const available = self.moves.map((m, i) => m.pp > 0 ? i : -1).filter(i => i >= 0);
    let action: number;
    if (policy === 'random') action = rng.int(5);
    else if (policy === 'heuristic') action = available.reduce((best, i) => calculateDamage(combatant(self), combatant(enemy), getMove(self.moves[i].moveId)).damage > calculateDamage(combatant(self), combatant(enemy), getMove(self.moves[best]?.moveId ?? self.moves[0].moveId)).damage ? i : best, available[0] ?? 0);
    else action = controller.choose(self, enemy, game.battle.turn, reward, learning).action;
    // Same declared legal-slot mapping for every policy.
    if (action < 4 && !(self.moves[action]?.pp > 0)) action = available.find(i => i >= action) ?? available[0] ?? 0;
    const result = actBattle(game, action === 4 ? { type: 'wait' } : { type: 'move', index: action }, enemyChoice);
    const afterHp = result.outcome === 'lost' ? 0 : self.hp;
    reward = (beforeEnemy - enemy.hp) / enemy.stats.hp - (beforeSelf - afterHp) / self.stats.hp - .015;
    if (result.battleEnded) { outcome = result.outcome!; reward += outcome === 'won' ? 1 : outcome === 'lost' ? -1 : 0; }
    totalReward += reward;
    if (trace) frames.push({ step: steps, action, enemyChoice, rng: game.rngState, selfHp: afterHp, enemyHp: enemy.hp, reward, outcome: result.outcome ?? null, activity: self.brain!.activity, brainRng: self.brain!.rng });
  }
  controller.finish(self, reward ?? 0, learning);
  return { outcome, steps, totalReward, checkpoint: self.brain!, frames };
}

const samples: { seed: number; policy: Policy; wins: number; losses: number; timeouts: number; meanReward: number; meanTurns: number }[] = [];
let frozenChecks = 0;
for (const seed of SEEDS) {
  const initial = new Brain(seed, graph); initial.state.sensoryBypass = false;
  const untrained = initial.snapshot(); let trained = initial.snapshot();
  for (let ep = 0; ep < TRAIN; ep++) trained = episode(trained, seed * 1000 + ep, 'trained', true).checkpoint;
  for (const policy of ['random', 'heuristic', 'frozen', 'trained'] as const) {
    const checkpoint = policy === 'trained' ? trained : untrained;
    const before = JSON.stringify(checkpoint.readout), updates = checkpoint.updates;
    const results = Array.from({ length: EVAL }, (_, i) => episode(checkpoint, 900_000 + i, policy));
    for (const result of results) {
      if (JSON.stringify(result.checkpoint.readout) !== before || result.checkpoint.updates !== updates) throw new Error('Evaluation mutated weights');
      frozenChecks++;
    }
    samples.push({ seed, policy, wins: results.filter(r => r.outcome === 'won').length, losses: results.filter(r => r.outcome === 'lost').length,
      timeouts: results.filter(r => r.outcome === 'timeout').length, meanReward: results.reduce((sum, r) => sum + r.totalReward, 0) / EVAL, meanTurns: results.reduce((sum, r) => sum + r.steps, 0) / EVAL });
  }
}
const replayInitial = new Brain(SEEDS[0], graph); replayInitial.state.sensoryBypass = false;
const a = episode(replayInitial.snapshot(), 900_000, 'frozen', false, true), b = episode(replayInitial.snapshot(), 900_000, 'frozen', false, true);
const exact = JSON.stringify(a) === JSON.stringify(b);
if (!exact) throw new Error('Battle replay did not reproduce exactly');
const sha256 = createHash('sha256').update(JSON.stringify(a.frames)).digest('hex');
const report = { schema: 1, model: 'pokemon-recurrent-v1', graph: graph.id,
  protocol: { brainSeeds: SEEDS, trainingEpisodes: TRAIN, evaluationSeeds: Array.from({ length: EVAL }, (_, i) => 900_000 + i), maxTurns: MAX_TURNS,
    body: 'Ivysaur level 35 vs 12 possible level-35 species; controlled fixtures are rebuilt for each episode.',
    reward: 'fractional damage dealt minus damage received minus 0.015 per turn, terminal win +1/loss -1; evaluated weights frozen',
    opponent: 'fresh frozen real-connectome controller, identical initialization per matchup',
    unit: 'brain initialization seed; episodes within a brain seed are not independent training replications' },
  samples, frozenChecks, replay: { exact, sha256, frames: a.frames.length },
  limitation: 'Small bounded game benchmark, no confidence interval or general learning claim. This is not a biological model validation.' };
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/battle-experiment.json', JSON.stringify(report, null, 2) + '\n');
await writeFile('artifacts/battle-replay.json', JSON.stringify({ initial: replayInitial.snapshot(), seed: 900_000, policy: 'frozen', result: a }, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
