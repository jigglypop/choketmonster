import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Brain, type BrainState, type Graph } from '../src/core/brain';
import { Random } from '../src/core/random';
import { getMove, getSpecies } from '../src/data/pokemon';
import { typeMultiplier } from '../src/game/battle';
import {
  automatedMoveMask, availableMoveMask, ConnectomeController, mapToAvailableMove,
  type BattleSenseContext, type NeuralMonster,
} from '../src/game/connectome';

type Mask = [boolean, boolean, boolean, boolean, boolean];
type Frame = { turn: number; rawAction: number; action: number; mask: Mask };
type Trial = { seed: number; policy: 'legacy' | 'attack-every-turn'; attacks: number; turns: number; frames: Frame[]; weightsUnchanged: boolean };
type ReplayFile = { schema: 2; graphId: string; turns: number; checkpoints: Array<{ seed: number; brain: BrainState }>; trials: Trial[]; frameSha256: string };

const FIXED_DAMAGE_MOVES = new Set([12, 32, 49, 69, 82, 90, 101, 149, 162]);
const SELF_TARGETS = new Set([4, 7, 13, 15]);
const SEEDS = [101, 202, 303, 404, 505, 606, 707, 808];
const TURNS = 48;
const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const controller = new ConnectomeController(graph);

function ailmentImmune(ailment: string | undefined, types: readonly string[]) {
  return (ailment === 'poison' && (types.includes('poison') || types.includes('steel')))
    || (ailment === 'burn' && types.includes('fire')) || (ailment === 'freeze' && types.includes('ice'))
    || (ailment === 'paralysis' && types.includes('electric'));
}

/** Frozen copy of the policy shipped before the every-turn attack guard. */
function legacyAutomatedMoveMask(self: NeuralMonster, other: NeuralMonster, turn: number, context: BattleSenseContext = {}): Mask {
  const ppMask = availableMoveMask(self), defenderTypes = getSpecies(other.speciesId).types;
  if (!ppMask.slice(0, 4).some(Boolean)) return [true, false, false, false, false];
  const attacks = [0, 1, 2, 3].map(index => {
    const slot = self.moves[index]; if (!slot || slot.pp <= 0 || slot.moveId === undefined) return false;
    const move = getMove(slot.moveId);
    return move.damageClass !== 'status' && (move.power > 0 || FIXED_DAMAGE_MOVES.has(move.id)) && typeMultiplier(move.type, defenderTypes) > 0;
  });
  const strategic = [0, 1, 2, 3].map(index => {
    const slot = self.moves[index]; if (!slot || slot.pp <= 0 || slot.moveId === undefined) return false;
    const move = getMove(slot.moveId);
    const healing = ((move.healing ?? 0) > 0 || move.id === 156) && self.hp < self.stats.hp;
    const selfTarget = move.metaCategory === 8 || (move.metaCategory !== 7 && SELF_TARGETS.has(move.targetId ?? 10));
    const stages = selfTarget ? context.selfStatStages : context.otherStatStages;
    const stageChange = move.statChanges?.some(change => {
      const key = ({ 'special-attack': 'specialAttack', 'special-defense': 'specialDefense' } as Record<string, string>)[change.stat] ?? change.stat;
      const stage = stages?.[key] ?? 0;
      return change.change > 0 ? stage < 6 : stage > -6;
    }) ?? false;
    const statusTarget = SELF_TARGETS.has(move.targetId ?? 10) ? self : other;
    const ailment = !!move.ailment && move.ailment !== 'none' && !statusTarget.status
      && !ailmentImmune(move.ailment, getSpecies(statusTarget.speciesId).types);
    return healing || stageChange || ailment;
  });
  const forceAttack = turn % 3 === 0 && attacks.some(Boolean);
  let allowed = ppMask.slice(0, 4).map((hasPp, index) => hasPp && (forceAttack ? attacks[index] : attacks[index] || strategic[index]));
  if (!allowed.some(Boolean)) allowed = ppMask.slice(0, 4);
  return allowed.concat(false) as Mask;
}

function fixture(seed: number) {
  const self: NeuralMonster = { instanceId: `auto-attack-${seed}`, speciesId: 1, level: 20, hp: 40, stats: { hp: 100, speed: 50 }, moves: [
    { moveId: 33, pp: getMove(33).pp }, { moveId: 14, pp: getMove(14).pp }, { moveId: 105, pp: getMove(105).pp }, { moveId: 77, pp: getMove(77).pp },
  ] };
  const foe: NeuralMonster = { instanceId: `foe-${seed}`, speciesId: 4, level: 20, hp: 100, stats: { hp: 100, speed: 50 }, moves: [{ moveId: 33, pp: getMove(33).pp }] };
  controller.ensure(self);
  return { self, foe, checkpoint: structuredClone(self.brain!) };
}

const weights = (state: BrainState) => JSON.stringify([state.inputWeights, state.readout]);
function run(seed: number, policy: Trial['policy'], checkpoint?: BrainState): Trial {
  const { self, foe, checkpoint: initial } = fixture(seed), saved = structuredClone(checkpoint ?? initial);
  const brain = Brain.restore(saved), before = weights(saved), context = { selfStatStages: { attack: 0 }, otherStatStages: { attack: 0 } };
  const frames: Frame[] = [];
  for (let turn = 1; turn <= TURNS; turn++) {
    const rawAction = brain.act(controller.observe(self, foe, turn, context), null, false, 0, 4);
    const mask = policy === 'legacy' ? legacyAutomatedMoveMask(self, foe, turn, context) : automatedMoveMask(self, foe, turn, context);
    const action = mapToAvailableMove(rawAction, mask);
    brain.state.action = action as 0 | 1 | 2 | 3 | 4;
    if (action !== rawAction) brain.state.previous = null;
    frames.push({ turn, rawAction, action, mask });
  }
  return { seed, policy, attacks: frames.filter(frame => frame.action === 0).length, turns: TURNS, frames, weightsUnchanged: before === weights(brain.state) };
}

function randomAttackRate(mask: (self: NeuralMonster, foe: NeuralMonster, turn: number, context: BattleSenseContext) => Mask) {
  let attacks = 0, decisions = 0;
  for (const seed of SEEDS) {
    const { self, foe } = fixture(seed), rng = new Random(seed), context = { selfStatStages: { attack: 0 }, otherStatStages: { attack: 0 } };
    for (let turn = 1; turn <= TURNS; turn++) {
      const allowed = mask(self, foe, turn, context).map((yes, index) => yes ? index : -1).filter(index => index >= 0);
      if (allowed[rng.int(allowed.length)] === 0) attacks++;
      decisions++;
    }
  }
  return { attacks, decisions, rate: attacks / decisions };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const frameHash = (trials: Trial[]) => sha256(JSON.stringify(trials.map(({ seed, policy, frames }) => ({ seed, policy, frames }))));
const replayFlag = process.argv.indexOf('--replay');
if (replayFlag >= 0) {
  const path = process.argv[replayFlag + 1];
  if (!path) throw new Error('--replay requires a replay.json path');
  const saved = JSON.parse(readFileSync(path, 'utf8')) as ReplayFile;
  if (saved.schema !== 2 || saved.graphId !== graph.id || saved.turns !== TURNS || !Array.isArray(saved.checkpoints) || !Array.isArray(saved.trials)) throw new Error('Replay artifact does not match this experiment');
  const checkpoints = new Map(saved.checkpoints.map(row => [row.seed, row.brain]));
  const replayed = saved.trials.map(trial => {
    const checkpoint = checkpoints.get(trial.seed); if (!checkpoint) throw new Error(`Missing checkpoint for seed ${trial.seed}`);
    return run(trial.seed, trial.policy, checkpoint);
  });
  const actualFrameSha256 = frameHash(replayed), exact = actualFrameSha256 === saved.frameSha256 && JSON.stringify(replayed) === JSON.stringify(saved.trials);
  console.log(JSON.stringify({ replay: path, exact, expectedFrameSha256: saved.frameSha256, actualFrameSha256 }, null, 2));
  if (!exact) throw new Error('Saved checkpoint replay does not reproduce the recorded frames');
  process.exit(0);
}

const checkpoints = SEEDS.map(seed => ({ seed, brain: fixture(seed).checkpoint }));
const bySeed = new Map(checkpoints.map(row => [row.seed, row.brain]));
const trials = SEEDS.flatMap(seed => [run(seed, 'legacy', bySeed.get(seed)), run(seed, 'attack-every-turn', bySeed.get(seed))]);
const replayed = trials.map(trial => run(trial.seed, trial.policy, bySeed.get(trial.seed)));
const exactReplay = JSON.stringify(trials) === JSON.stringify(replayed);
const summary = (policy: Trial['policy']) => {
  const rows = trials.filter(trial => trial.policy === policy), attacks = rows.reduce((sum, row) => sum + row.attacks, 0), turns = rows.reduce((sum, row) => sum + row.turns, 0);
  return { attacks, turns, attackRate: attacks / turns, everyTrialWeightsUnchanged: rows.every(row => row.weightsUnchanged) };
};
const recordedFrameSha256 = frameHash(trials);
const replay: ReplayFile = { schema: 2, graphId: graph.id, turns: TURNS, checkpoints, trials, frameSha256: recordedFrameSha256 };
const replayJson = JSON.stringify(replay, null, 2), replayArtifactSha256 = sha256(replayJson);
const report = {
  schema: 1, model: 'automatic-battle-attack-mask-v2', graph: { id: graph.id, nodes: graph.nodes.length, edges: graph.edges.length },
  protocol: { seeds: SEEDS, turnsPerSeed: TURNS, sameInitialCheckpointPerPair: true, learning: false, fixtureMoves: [33, 14, 105, 77], attackSlot: 0 },
  comparison: { legacy: summary('legacy'), attackEveryTurn: summary('attack-every-turn') },
  randomBaseline: { legacy: randomAttackRate(legacyAutomatedMoveMask), attackEveryTurn: randomAttackRate(automatedMoveMask) },
  replay: { exact: exactReplay, frameSha256: recordedFrameSha256, artifactSha256: replayArtifactSha256 },
  limitation: 'HP and each move PP stay fixed while this checks mask selection only. It does not execute battle outcomes or measure win rate, and it is not evidence of biological learning.',
};
if (!report.comparison.attackEveryTurn.everyTrialWeightsUnchanged || report.comparison.attackEveryTurn.attackRate !== 1 || !exactReplay) throw new Error('Automatic attack policy invariants failed');
const outFlag = process.argv.indexOf('--out'), output = outFlag >= 0 ? process.argv[outFlag + 1] : `artifacts/auto-attack-${new Date().toISOString().replace(/[:.]/g, '-')}`;
if (!output || existsSync(output)) throw new Error(`Output directory already exists or is invalid: ${output}`);
mkdirSync(output, { recursive: true });
writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${output}/replay.json`, replayJson);
writeFileSync(`${output}/report.md`, `# 자동 전투 공격 마스크 비교\n\n- 동일 초기 체크포인트: ${SEEDS.length}개\n- 시드별 평가 턴: ${TURNS}\n- 기존 공격률: ${(report.comparison.legacy.attackRate * 100).toFixed(1)}%\n- 새 공격률: ${(report.comparison.attackEveryTurn.attackRate * 100).toFixed(1)}%\n- 평가 가중치 불변: ${report.comparison.attackEveryTurn.everyTrialWeightsUnchanged ? '확인' : '실패'}\n- 저장 체크포인트 리플레이 일치: ${exactReplay ? '확인' : '실패'}\n- 프레임 SHA-256: ${recordedFrameSha256}\n\nHP와 기술별 PP를 실제 최대값으로 고정한 선택 검사입니다. 실제 전투 결과와 승률을 측정하지 않으며 생물학적 학습의 증거가 아닙니다.\n`);
console.log(JSON.stringify({ output, comparison: report.comparison, randomBaseline: report.randomBaseline, replay: report.replay }, null, 2));
