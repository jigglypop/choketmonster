import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Brain, validateGraph, type Graph } from '../src/core/brain';
import { runEpisode, train, type EpisodeResult } from '../src/core/episode';
import type { World } from '../src/core/world';
import { parseJson } from '../src/core/json';

const { values } = parseArgs({ options: {
  seeds: { type: 'string', default: '5' }, train: { type: 'string', default: '100' },
  eval: { type: 'string', default: '20' }, out: { type: 'string' }, graph: { type: 'string' },
} });
function count(value: string, name: string, max: number) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${name} must be 1–${max}`);
  return n;
}
const seedCount = count(values.seeds!, 'seeds', 30);
const trainCount = count(values.train!, 'train', 1000);
const evalCount = count(values.eval!, 'eval', 100);
if (seedCount * (trainCount + 4 * evalCount) > 30000) throw new Error('Run exceeds 30,000 episode local budget');
let graph: Graph | undefined;
if (values.graph) { graph = parseJson(await readFile(values.graph, 'utf8')); validateGraph(graph); }
const out = resolve(values.out ?? `artifacts/experiment-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(out, { recursive: true });
const conditions = ['random', 'heuristic', 'frozen', 'trained'] as const;
type Condition = typeof conditions[number];
const rows: (EpisodeResult & { condition: Condition; brainSeed: number })[] = [];
const pairs: { brainSeed: number; deltaFood: number; deltaReward: number }[] = [];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const start = performance.now();
for (let i = 0; i < seedCount; i++) {
  const brainSeed = 42 + i * 97;
  const initial = new Brain(brainSeed, graph);
  const trained = Brain.restore(initial.snapshot());
  const training = train(trained, trainCount, 10000 + i * 2000);
  const perSeed: Record<Condition, EpisodeResult[]> = { random: [], heuristic: [], frozen: [], trained: [] };
  for (const condition of conditions) {
    const brain = Brain.restore((condition === 'trained' ? trained : initial).snapshot());
    const locked = JSON.stringify(brain.state.readout);
    for (let j = 0; j < evalCount; j++) {
      const seed = 1000000 + j;
      const result = runEpisode(brain, seed, { policy: condition === 'random' || condition === 'heuristic' ? condition : 'brain' });
      perSeed[condition].push(result);
      rows.push({ condition, brainSeed, ...result });
    }
    if (JSON.stringify(brain.state.readout) !== locked) throw new Error('Evaluation modified the policy');
  }
  pairs.push({ brainSeed, deltaFood: mean(perSeed.trained.map(x => x.food)) - mean(perSeed.frozen.map(x => x.food)), deltaReward: mean(perSeed.trained.map(x => x.reward)) - mean(perSeed.frozen.map(x => x.reward)) });
  await writeFile(resolve(out, `brain-${brainSeed}.json`), JSON.stringify(trained.snapshot(), null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(out, `training-${brainSeed}.json`), JSON.stringify(training, null, 2) + '\n', { flag: 'wx' });
  if (i === 0) {
    const checkpoint = trained.snapshot();
    const frames: World[] = [];
    const result = runEpisode(trained, 1000000, { trace: frames });
    const digest = createHash('sha256').update(JSON.stringify(frames)).digest('hex');
    await writeFile(resolve(out, 'replay.json'), JSON.stringify({ schema: 1, checkpoint, seed: 1000000, steps: 240, result, frames, sha256: digest }, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(`Seed ${brainSeed}: trained ${trainCount} episodes; held-out food ${mean(perSeed.trained.map(x => x.food)).toFixed(2)}, frozen ${mean(perSeed.frozen.map(x => x.food)).toFixed(2)}`);
}
const delta = mean(pairs.map(p => p.deltaFood));
const sampleSd = pairs.length > 1 ? Math.sqrt(pairs.reduce((sum, p) => sum + (p.deltaFood - delta) ** 2, 0) / (pairs.length - 1)) : null;
const summary = Object.fromEntries(conditions.map(condition => {
  const r = rows.filter(row => row.condition === condition);
  return [condition, { episodes: r.length, food: mean(r.map(x => x.food)), hits: mean(r.map(x => x.hits)), reward: mean(r.map(x => x.reward)), steps: mean(r.map(x => x.steps)) }];
}));
const report = { schema: 1, createdAt: new Date().toISOString(), model: graph?.kind ?? 'synthetic',
  protocol: { brainSeeds: pairs.map(x => x.brainSeed), trainEpisodes: trainCount, trainSeedRanges: pairs.map((_, i) => [10000 + i * 2000, 10000 + i * 2000 + trainCount - 1]), evalSeeds: Array.from({ length: evalCount }, (_, i) => 1000000 + i), steps: 240, evalLearning: false, epsilon: { train: 0.15, eval: 0 }, reward: 'step -0.04; distance reduction × 0.12; food +3; hazard -1.5; wall -0.25' },
  summary, pairedFoodImprovement: { mean: delta, sdAcrossBrainSeeds: sampleSd, positiveSeeds: pairs.filter(p => p.deltaFood > 0).length, totalSeeds: pairs.length, pairs },
  interpretation: 'Descriptive toy-task comparison only. No biological learning claim, no unshaped-task or generalization-to-battle claim. Seeds share evaluation maps; episode rows are not independent replicates.',
  durationSeconds: (performance.now() - start) / 1000, rows };
await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const table = conditions.map(c => `| ${c} | ${summary[c].food.toFixed(2)} | ${summary[c].hits.toFixed(2)} | ${summary[c].reward.toFixed(2)} |`).join('\n');
await writeFile(resolve(out, 'report.md'), `# 초켓몬스터 실험\n\n모델: ${report.model}. ${seedCount}개 뇌 시드 × 학습 ${trainCount}회 × 별도 평가 맵 ${evalCount}개. 평가 중 가중치 고정.\n\n| 조건 | 평균 먹이 | 평균 위험 접촉 | 평균 보상 |\n|---|---:|---:|---:|\n${table}\n\n학습 전 대비 먹이 차이: ${delta.toFixed(2)}. 양의 차이를 보인 뇌 시드: ${report.pairedFoodImprovement.positiveSeeds}/${seedCount}.\n\n${report.interpretation}\n`, { flag: 'wx' });
console.log(`Saved ${out}`);
