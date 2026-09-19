import { Random, clamp } from './random';
import type { Action } from './world';

export const INPUTS = 12;
export const NEURONS = 32;
export const OUTPUTS = 5;
export type Edge = { source: number; target: number; weight: number };
export type Graph = {
  schema: 1; kind: 'synthetic' | 'connectome-subset'; id: string;
  nodes: string[]; edges: Edge[];
  provenance: { source: string; version: string; license: string; sha256: string; note: string };
};
export type BrainState = {
  schema: 1; seed: number; graph: Graph; inputWeights: number[][];
  readout: number[][]; activity: number[]; previous: number[] | null;
  action: Action; rng: number; updates: number;
  sensoryBypass?: boolean;
};
export function syntheticGraph(seed: number): Graph {
  const rng = new Random(seed);
  const edges: Edge[] = [];
  for (let target = 0; target < NEURONS; target++) for (let k = 0; k < 4; k++) {
    edges.push({ source: rng.int(NEURONS), target, weight: (rng.next() - 0.5) * 0.35 });
  }
  return { schema: 1, kind: 'synthetic', id: `synthetic-32-v1-${seed}`,
    nodes: Array.from({ length: NEURONS }, (_, i) => `synthetic-${i}`), edges,
    provenance: { source: 'procedural:mulberry32', version: '1', license: 'project-original', sha256: '', note: 'Random recurrent graph. No biological connectome data.' } };
}
export function validateGraph(value: unknown): asserts value is Graph {
  const g = value as Graph;
  if (!g || g.schema !== 1 || !['synthetic', 'connectome-subset'].includes(g.kind) || typeof g.id !== 'string' || !g.id || !Array.isArray(g.nodes) || g.nodes.length < 2 || g.nodes.length > 512 || !g.nodes.every(n => typeof n === 'string' && n.length > 0) || new Set(g.nodes).size !== g.nodes.length) throw new Error('Invalid graph nodes (2–512 unique string IDs required)');
  if (!Array.isArray(g.edges) || g.edges.length < 1 || g.edges.length > 50000 || !g.edges.every(e => Number.isInteger(e.source) && Number.isInteger(e.target) && e.source >= 0 && e.target >= 0 && e.source < g.nodes.length && e.target < g.nodes.length && Number.isFinite(e.weight) && Math.abs(e.weight) <= 10)) throw new Error('Invalid graph edges');
  const p = g.provenance;
  if (!p || !['source', 'version', 'license', 'sha256', 'note'].every(k => typeof p[k as keyof typeof p] === 'string')) throw new Error('Missing graph provenance');
  if (g.kind === 'connectome-subset' && (!/^https:\/\//.test(p.source) || !/^[a-f0-9]{64}$/.test(p.sha256) || !p.version || !p.license || !p.note)) throw new Error('Connectome subset needs source URL, version, license, SHA-256 and modeling note');
}
export class Brain {
  state: BrainState;
  constructor(seed: number, graph = syntheticGraph(seed)) {
    validateGraph(graph);
    const rng = new Random(seed ^ 0xabc123);
    const n = graph.nodes.length;
    this.state = { schema: 1, seed, graph: structuredClone(graph),
      inputWeights: Array.from({ length: n }, () => Array.from({ length: INPUTS }, () => (rng.next() - 0.5) * 1.2)),
      readout: Array.from({ length: OUTPUTS }, () => Array.from({ length: INPUTS + n }, () => (rng.next() - 0.5) * 0.02)),
      activity: Array(n).fill(0), previous: null, action: 4, rng: rng.state, updates: 0 };
  }
  resetEpisode(seed: number) {
    this.state.activity.fill(0);
    this.state.previous = null;
    this.state.action = 4;
    this.state.rng = seed >>> 0;
  }
  private features(input: number[]): number[] {
    if (input.length !== INPUTS || !input.every(Number.isFinite)) throw new Error('Invalid sensory input');
    const s = this.state;
    const sums = s.inputWeights.map(row => row.reduce((sum, w, i) => sum + w * input[i], 0));
    for (const e of s.graph.edges) sums[e.target] += s.activity[e.source] * e.weight;
    s.activity = sums.map((sum, i) => 0.35 * s.activity[i] + 0.65 * Math.tanh(sum));
    // Sensory skip features are engineered and documented; the graph is not the sole policy input.
    return [...input.map(v => s.sensoryBypass === false ? 0 : v), ...s.activity.map(v => v * 0.35)];
  }
  private values(features: number[]): number[] {
    return this.state.readout.map(row => row.reduce((sum, w, i) => sum + w * features[i], 0));
  }
  act(input: number[], reward: number | null = null, learning = false, epsilon = 0, recurrentSteps = 1): Action {
    if (!Number.isInteger(recurrentSteps) || recurrentSteps < 1 || recurrentSteps > 16) throw new Error('Recurrent steps must be 1–16');
    let features = this.features(input);
    for (let step = 1; step < recurrentSteps; step++) features = this.features(input);
    let current = this.values(features);
    // Re-evaluate only when a pending decision can change the readout weights.
    if (learning && reward !== null && this.state.previous !== null) {
      this.update(reward, Math.max(...current));
      current = this.values(features);
    }
    const rng = new Random(this.state.rng);
    let action = current.indexOf(Math.max(...current)) as Action;
    if (epsilon > 0 && rng.next() < epsilon) action = rng.int(OUTPUTS) as Action;
    this.state.rng = rng.state;
    this.state.previous = features;
    this.state.action = action;
    return action;
  }
  finish(reward: number, learning: boolean) {
    if (learning) this.update(reward, 0);
    this.state.previous = null;
  }
  private update(reward: number, bootstrap: number) {
    const s = this.state;
    if (!s.previous) return;
    const row = s.readout[s.action];
    const estimate = row.reduce((sum, w, i) => sum + w * s.previous![i], 0);
    const delta = clamp(reward + 0.85 * bootstrap - estimate, -4, 4);
    const norm = 1 + s.previous.reduce((sum, x) => sum + x * x, 0);
    for (let i = 0; i < row.length; i++) row[i] = clamp(row[i] + 0.14 * delta * s.previous[i] / norm, -12, 12);
    s.updates++;
  }
  snapshot(): BrainState { return structuredClone(this.state); }
  static restore(value: unknown): Brain {
    const s = value as BrainState;
    if (!s || s.schema !== 1) throw new Error('Unsupported brain checkpoint');
    validateGraph(s.graph);
    if (s.sensoryBypass !== undefined && typeof s.sensoryBypass !== 'boolean') throw new Error('Invalid sensory bypass flag');
    const n = s.graph.nodes.length;
    const vector = (v: unknown, size: number) => Array.isArray(v) && v.length === size && v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 100);
    const matrix = (v: unknown, rows: number, cols: number) => Array.isArray(v) && v.length === rows && v.every(row => vector(row, cols));
    if (!matrix(s.inputWeights, n, INPUTS) || !matrix(s.readout, OUTPUTS, INPUTS + n) || !vector(s.activity, n) || (s.previous !== null && !vector(s.previous, INPUTS + n)) || !Number.isSafeInteger(s.seed) || s.seed < 0 || s.seed > 0xffffffff || !Number.isInteger(s.rng) || s.rng < 0 || s.rng > 0xffffffff || !Number.isInteger(s.action) || s.action < 0 || s.action >= OUTPUTS || !Number.isSafeInteger(s.updates) || s.updates < 0) throw new Error('Malformed brain checkpoint');
    const brain = new Brain(s.seed, s.graph);
    brain.state = structuredClone(s);
    return brain;
  }
}
