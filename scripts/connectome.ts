import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { parse } from 'csv-parse';
import { validateGraph, type Graph } from '../src/core/brain';

export type ImportOptions = { csv: string; nodes: string[]; source: string; version: string; license: string; maxRows?: number };
/** Stream a user-selected induced subgraph. Never silently crop or label a subset whole-brain. */
export async function importConnectome(options: ImportOptions): Promise<Graph> {
  const { csv, nodes, source, version, license } = options;
  if (!Array.isArray(nodes) || nodes.length < 2 || nodes.length > 512 || new Set(nodes).size !== nodes.length || !nodes.every(n => typeof n === 'string' && /^\d+$/.test(n))) throw new Error('Select 2–512 unique string root IDs');
  if (!/^https:\/\//.test(source) || !version.trim() || !license.trim()) throw new Error('Source URL, dataset version and license required');
  const indices = new Map(nodes.map((id, i) => [id, i]));
  const weights = new Map<string, { source: number; target: number; signedCount: number; synapses: number }>();
  const hash = createHash('sha256');
  const hasher = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  const started = performance.now();
  let count = 0;
  const consume = async (rows: AsyncIterable<Record<string, string>>) => {
    for await (const row of rows) {
      count++;
      if (count > (options.maxRows ?? 30_000_000) || performance.now() - started > 60000) throw new Error('Import budget exceeded (30M rows / 60 seconds); prepare a smaller source CSV');
      if (!('pre_root_id' in row) || !('post_root_id' in row) || !('syn_count' in row) || !('nt_type' in row)) throw new Error('Expected pre_root_id,post_root_id,syn_count,nt_type columns');
      const pre = indices.get(row.pre_root_id), post = indices.get(row.post_root_id);
      if (pre === undefined || post === undefined) continue;
      const synapses = Number(row.syn_count);
      if (!Number.isSafeInteger(synapses) || synapses < 1) throw new Error('Invalid syn_count on a selected edge');
      // These coarse neurotransmitter signs are modeling assumptions, not receptor-level evidence.
      const nt = row.nt_type.trim().toUpperCase();
      const sign = nt === 'ACH' ? 1 : nt === 'GABA' || nt === 'GLUT' || nt === 'GLU' ? -1 : null;
      if (sign === null) throw new Error(`Selected edge has unsupported neurotransmitter ${nt}; supply an explicitly modeled circuit instead`);
      const key = `${pre}:${post}`;
      const current = weights.get(key) ?? { source: pre, target: post, signedCount: 0, synapses: 0 };
      current.signedCount += sign * synapses; current.synapses += synapses; weights.set(key, current);
      if (weights.size > 50000) throw new Error('Subset exceeds 50,000 connections');
    }
  };
  const parser = parse({ columns: true, bom: true, skip_empty_lines: true, trim: true, max_record_size: 1_000_000 });
  if (csv.endsWith('.gz')) await pipeline(createReadStream(csv), hasher, createGunzip(), parser, consume);
  else await pipeline(createReadStream(csv), hasher, parser, consume);
  if (!count || !weights.size) throw new Error('No connections between the selected neurons');
  const incoming = Array(nodes.length).fill(0);
  for (const e of weights.values()) incoming[e.target] += Math.abs(e.signedCount);
  const graph: Graph = { schema: 1, kind: 'connectome-subset', id: `imported-${version}`,
    nodes: [...nodes], edges: [...weights.values()].map(e => ({ source: e.source, target: e.target, weight: incoming[e.target] ? e.signedCount / incoming[e.target] * 0.8 : 0, synapses: e.synapses })),
    provenance: { source, version, license, sha256: hash.digest('hex'), note: `User-selected induced subgraph; ${count} source rows scanned. SHA-256 covers original file bytes (compressed when .gz). ACH positive; GABA/GLUT/GLU negative; unknown/modulatory types rejected. Incoming absolute signed weights normalized to 0.8. Engineered random sensory projection, sensory skip features and learned readout; no anatomical sensory/motor mapping. User-supplied provenance, not independently authenticated. Not a whole-brain model.` } };
  validateGraph(graph); return graph;
}
