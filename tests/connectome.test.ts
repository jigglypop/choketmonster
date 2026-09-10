import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { importConnectome } from '../scripts/connectome';
import { Brain } from '../src/core/brain';
import { runEpisode } from '../src/core/episode';

it('streams gzipped CSV, preserves 64-bit IDs and fingerprints source bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'choketmon-import-'));
  try {
    const nodes = ['720575940123456789', '720575940123456790'];
    const data = gzipSync(`pre_root_id,post_root_id,syn_count,nt_type\n${nodes[0]},${nodes[1]},4,ACH\n${nodes[0]},${nodes[1]},6,ACH\n${nodes[1]},${nodes[0]},3,GABA\n999,888,2,DA\n`);
    const csv = join(dir, 'fixture.csv.gz'); await writeFile(csv, data);
    const graph = await importConnectome({ csv, nodes, source: 'https://example.org/synthetic-test-only', version: 'fixture-v1', license: 'test-fixture' });
    expect(graph.nodes).toEqual(nodes); expect(graph.edges).toHaveLength(2);
    expect(graph.edges[0].weight).toBeCloseTo(0.8); expect(graph.edges[1].weight).toBeCloseTo(-0.8);
    expect(graph.provenance.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect(runEpisode(new Brain(42, graph), 1000000).steps).toBeGreaterThan(0);
    await expect(importConnectome({ csv, nodes, source: 'https://example.org/test', version: '1', license: 'test', maxRows: 1 })).rejects.toThrow('budget');
    await writeFile(join(dir, 'bad.csv'), `pre_root_id,post_root_id,syn_count,nt_type\n${nodes[0]},${nodes[1]},3,DA\n`);
    await expect(importConnectome({ csv: join(dir, 'bad.csv'), nodes, source: 'https://example.org/test', version: '1', license: 'test' })).rejects.toThrow('unsupported');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
