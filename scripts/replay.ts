import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Brain } from '../src/core/brain';
import { runEpisode } from '../src/core/episode';
import type { World } from '../src/core/world';
import { parseJson } from '../src/core/json';

const path = process.argv[2];
if (!path) throw new Error('Usage: npm run replay -- <experiment-directory>/replay.json');
const saved = parseJson(await readFile(path, 'utf8'));
if (saved.schema !== 1) throw new Error('Unsupported replay version');
const brain = Brain.restore(saved.checkpoint);
const frames: World[] = [];
const result = runEpisode(brain, saved.seed, { steps: saved.steps, trace: frames });
const digest = createHash('sha256').update(JSON.stringify(frames)).digest('hex');
const storedDigest = createHash('sha256').update(JSON.stringify(saved.frames)).digest('hex');
if (digest !== saved.sha256 || storedDigest !== saved.sha256 || JSON.stringify(result) !== JSON.stringify(saved.result)) throw new Error('Replay mismatch: checkpoint, trajectory, or result changed');
console.log(`Replay verified: ${frames.length} frames, SHA-256 ${digest}`);
