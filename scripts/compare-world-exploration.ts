import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Brain, type Graph } from '../src/core/brain';
import { createGame } from '../src/game/engine';
import type { FieldPolicy } from '../src/game/field';
import { OpenWorldSimulation, serializeOpenWorld, restoreOpenWorld } from '../src/openworld/simulation';

const baselineRef = '24aaa56297acd5069add4a3295b6a69335577319';
const output = process.argv[2] ?? `artifacts/world-speed/exploration-${Date.now()}`;
await mkdir(output, { recursive: true });
const graph = JSON.parse(await readFile('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(await readFile('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
const source = execFileSync('git', ['show', `${baselineRef}:src/openworld/simulation.ts`], { encoding: 'utf8' });
// Preserve the old simulation while using the unchanged shared engine/data.
const baselinePath = resolve(output, 'baseline-simulation.ts');
await writeFile(baselinePath, source.replace(/from (['"])(\.[^'"]+)\1/g,
  (_all, quote, specifier) => `from ${quote}${pathToFileURL(resolve('src/openworld', specifier)).href}${quote}`));
const baseline = await import(pathToFileURL(baselinePath).href) as { OpenWorldSimulation: typeof OpenWorldSimulation };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows: unknown[] = [], replays: unknown[] = [];

for (const species of [1, 152] as const) for (const seed of [35211, 35212, 35213]) {
  const game = createGame(species, `explore-${seed}`), initial = new OpenWorldSimulation(graph, game, seed, undefined, policy);
  initial.setAutoHunt(false); initial.setControlMode('auto');
  const checkpoint = initial.snapshot();
  for (const control of ['deployed-frozen', 'untrained-frozen', 'uniform-random']) {
    const input = structuredClone(checkpoint);
    if (control === 'untrained-frozen') for (const entity of input.entities) {
      entity.brain.readout = new Brain(seed, graph).snapshot().readout;
    }
    const epsilon = control === 'uniform-random' ? 1 : 0;
    for (const [version, Constructor] of [['baseline', baseline.OpenWorldSimulation], ['candidate', OpenWorldSimulation]] as const) {
      const currentGame = structuredClone(game), world = new Constructor(graph, currentGame, seed, structuredClone(input), policy);
      const before = serializeOpenWorld(currentGame, world);
      const weights = new Map(world.entities.map(entity => [entity.id, hash([entity.brain.inputWeights, entity.brain.readout, entity.brain.updates])]));
      const frames: unknown[] = [];
      let traveled = 0, radius = 0, reward = 0, collisions = 0, encounters = 0, foods = 0;
      const origin = { ...world.player }, visited = new Set<string>();
      for (let step = 0; step < 48; step++) {
        const previous = { ...world.player }, result = world.step({ deltaSeconds: .25, learning: false, epsilon });
        traveled += Math.hypot(world.player.x - previous.x, world.player.z - previous.z);
        radius = Math.max(radius, Math.hypot(world.player.x - origin.x, world.player.z - origin.z));
        visited.add(`${Math.floor(world.player.x / 4)},${Math.floor(world.player.z / 4)}`);
        for (const event of result.events) {
          if (event.type === 'collision') collisions++;
          if (event.type === 'encounter') encounters++;
          if (event.type === 'food') foods++;
          if ('reward' in event) reward += event.reward;
        }
        assert.equal(world.sampleWorld(world.player.x, world.player.z).blocked, false);
        frames.push({ result, player: { ...world.player } });
      }
      for (const entity of world.entities) if (weights.has(entity.id)) {
        assert.equal(hash([entity.brain.inputWeights, entity.brain.readout, entity.brain.updates]), weights.get(entity.id), `evaluation changed ${entity.id}`);
      }
      const row = { version, region: world.regionId, seed, control, seconds: 12, traveled, radius, visitedCells: visited.size, collisions, encounters, foods, reward, framesSha256: hash(frames) };
      rows.push(row);
      if (version === 'candidate') {
        const replay = restoreOpenWorld(graph, before, policy), actual = [];
        for (let step = 0; step < 48; step++) actual.push({ result: replay.simulation.step({ deltaSeconds: .25, learning: false, epsilon }), player: { ...replay.simulation.player } });
        assert.equal(hash(actual), hash(frames));
        assert.deepEqual(replay.simulation.snapshot(), world.snapshot());
        replays.push({ ...row, epsilon, checkpoint: JSON.parse(before), frames });
      }
    }
  }
}
await writeFile(`${output}/report.json`, JSON.stringify({ baselineRef, graph: graph.id, policy: policy.model, learning: false, rows }, null, 2));
await writeFile(`${output}/replay.json`, JSON.stringify(replays));
console.log(JSON.stringify({ output, replaySha256: hash(replays), rows }));
