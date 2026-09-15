import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Brain, type BrainState, type Graph } from '../src/core/brain';
import { Random } from '../src/core/random';
import { getMove } from '../src/data/pokemon';
import { automatedMoveMask, ConnectomeController, mapToAvailableMove, type NeuralMonster } from '../src/game/connectome';

const baselineRef = '23b0a875dd32aa0eded10f688d84d10406b24092';
const output = process.argv[2] ?? `artifacts/unlimited-moves-${Date.now()}`;
await mkdir(output, { recursive: false });
const source = execFileSync('git', ['show', `${baselineRef}:src/game/connectome.ts`], { encoding: 'utf8' });
const baselinePath = resolve(output, 'baseline-connectome.ts');
await writeFile(baselinePath, source.replace(/from (['"])(\.[^'"]+)\1/g,
  (_all, quote, specifier) => `from ${quote}${pathToFileURL(resolve('src/game', specifier)).href}${quote}`));
const baseline = await import(pathToFileURL(baselinePath).href) as typeof import('../src/game/connectome');
const graph = JSON.parse(await readFile('public/data/connectome.json', 'utf8')) as Graph;
const current = new ConnectomeController(graph), previous = new baseline.ConnectomeController(graph);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Version = 'previous' | 'unlimited';
type Control = 'initialized-frozen' | 'zero-readout-frozen' | 'uniform-random';
type Checkpoint = { seed: number; control: Control; self: NeuralMonster; other: NeuralMonster; brain: BrainState };
function run(input: Checkpoint, version: Version) {
  const { self, other, seed, control } = structuredClone(input), brain = Brain.restore(input.brain), rng = new Random(seed);
  const frames: unknown[] = [], before = hash([brain.state.inputWeights, brain.state.readout, brain.state.updates]);
  for (let turn = 1; turn <= 32; turn++) {
    const mask = version === 'previous' ? baseline.automatedMoveMask(self, other, turn) : automatedMoveMask(self, other, turn);
    const observation = (version === 'previous' ? previous : current).observe(self, other, turn);
    const raw = brain.act(observation, null, false, 0, 4);
    const available = mask.map((allowed, index) => allowed ? index : -1).filter(index => index >= 0);
    const action = control === 'uniform-random' ? available[rng.int(available.length)] : mapToAvailableMove(raw, mask);
    frames.push({ turn, raw, action, mask, observation });
  }
  assert.equal(hash([brain.state.inputWeights, brain.state.readout, brain.state.updates]), before);
  return frames;
}
const trials = [];
for (const seed of [45101, 45102, 45103, 45104]) for (const control of ['initialized-frozen', 'zero-readout-frozen', 'uniform-random'] as const) {
  const self: NeuralMonster = { instanceId: `unlimited-${seed}`, speciesId: 7, level: 20, hp: 40,
    stats: { hp: 100, speed: 50 }, moves: [55, 33, 105, 45].map(moveId => ({ moveId, pp: getMove(moveId).pp })) };
  const other: NeuralMonster = { ...structuredClone(self), instanceId: `foe-${seed}`, speciesId: 4, hp: 100 };
  current.ensure(self);
  if (control === 'zero-readout-frozen') self.brain!.readout.forEach(row => row.fill(0));
  for (const legacyPp of ['full', 'zero'] as const) {
    const input: Checkpoint = { seed, control, self: structuredClone(self), other, brain: structuredClone(self.brain!) };
    if (legacyPp === 'zero') input.self.moves.forEach(slot => { slot.pp = 0; });
    const oldFrames = run(input, 'previous'), frames = run(input, 'unlimited');
    assert.deepEqual(run(input, 'unlimited'), frames);
    if (legacyPp === 'full') assert.deepEqual(frames, oldFrames);
    trials.push({ input, legacyPp, previous: oldFrames, current: frames });
  }
}
for (let index = 0; index < trials.length; index += 2) assert.deepEqual(trials[index].current, trials[index + 1].current);
await writeFile(`${output}/replay.json`, JSON.stringify(trials));
const saved = JSON.parse(await readFile(`${output}/replay.json`, 'utf8')) as typeof trials;
for (const trial of saved) assert.deepEqual(run(trial.input, 'unlimited'), trial.current);
const report = { baselineRef, baselineSourceSha256: createHash('sha256').update(source).digest('hex'), graphId: graph.id, trials: trials.length,
  turnsPerTrial: 32, learning: false, evaluationWeightsUnchanged: true, savedCheckpointReplayExact: true,
  fullPpBehaviorUnchanged: true, zeroPpMatchesFullPp: true, replaySha256: hash(saved),
  limitation: 'Bounded action-selection comparison with fixed HP and no battle outcomes; not evidence of learning or win-rate improvement.' };
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, ...report }, null, 2));
