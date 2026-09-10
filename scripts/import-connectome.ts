import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { importConnectome } from './connectome';
import { parseJson } from '../src/core/json';

const { values } = parseArgs({ options: { csv: { type: 'string' }, nodes: { type: 'string' }, source: { type: 'string' }, version: { type: 'string' }, license: { type: 'string' }, out: { type: 'string' } } });
for (const key of ['csv', 'nodes', 'source', 'version', 'license', 'out'] as const) if (!values[key]) throw new Error(`Missing --${key}. See docs/connectome.md`);
const graph = await importConnectome({ csv: values.csv!, nodes: parseJson(await readFile(values.nodes!, 'utf8')), source: values.source!, version: values.version!, license: values.license! });
const out = resolve(values.out!); await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(graph, null, 2) + '\n', { flag: 'wx' });
console.log(`Imported ${graph.nodes.length} neurons / ${graph.edges.length} connections to ${out}\nKind: ${graph.kind}\nSource SHA-256: ${graph.provenance.sha256}`);
