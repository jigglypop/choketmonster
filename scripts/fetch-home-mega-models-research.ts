import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const REPOSITORY = 'https://github.com/Lilothestitch16/Pokemon-HOME-GLB-Models';
const COMMIT = '27703273836f38f0e185976d955b1fbfb15448af';
const TREE_URL = `https://api.github.com/repos/Lilothestitch16/Pokemon-HOME-GLB-Models/git/trees/${COMMIT}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/Lilothestitch16/Pokemon-HOME-GLB-Models/${COMMIT}`;
const CACHE = resolve('data/local/pokemon-models-research', COMMIT, 'mega-forms');
const OUTPUT = resolve('artifacts/research/region-expansion/home-mega-model-audit.json');

type TreeEntry = { path: string; type: 'blob' | 'tree'; sha: string; size?: number };

const exists = async (path: string) => stat(path).then(() => true).catch(() => false);
async function digest(path: string, algorithm: 'sha1' | 'sha256', gitSize?: number) {
  const hash = createHash(algorithm);
  if (gitSize !== undefined) hash.update(`blob ${gitSize}\0`);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
async function verified(path: string, entry: TreeEntry) {
  return entry.size !== undefined && await exists(path) && (await stat(path)).size === entry.size
    && await digest(path, 'sha1', entry.size) === entry.sha;
}
async function download(entry: TreeEntry) {
  const target = resolve(CACHE, basename(entry.path));
  const partial = `${target}.part`;
  await mkdir(dirname(target), { recursive: true });
  if (await verified(target, entry)) return target;
  if (await exists(target)) throw new Error(`refusing to replace invalid cache: ${target}`);
  const offset = await stat(partial).then(value => value.size).catch(() => 0);
  const response = await fetch(`${RAW_BASE}/${entry.path}`, { headers: {
    'User-Agent': 'choketmon-home-mega-research/1.0', ...(offset ? { Range: `bytes=${offset}-` } : {}),
  } });
  if (!response.ok || !response.body) throw new Error(`${entry.path}: HTTP ${response.status}`);
  if (offset && response.status !== 206) { await rm(partial, { force: true }); return download(entry); }
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(partial, { flags: offset ? 'a' : 'w' }));
  if (!await verified(partial, entry)) throw new Error(`${entry.path}: size or Git blob SHA-1 mismatch`);
  await rename(partial, target);
  return target;
}
async function inspect(entry: TreeEntry, path: string) {
  const bytes = await readFile(path);
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`${entry.path}: invalid GLB 2.0 header`);
  }
  let offset = 12, document: Record<string, unknown> | undefined;
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4); offset += 8;
    if (offset + length > bytes.length || length % 4) throw new Error(`${entry.path}: invalid GLB chunk`);
    const chunk = bytes.subarray(offset, offset + length); offset += length;
    if (type === 0x4e4f534a) document = JSON.parse(chunk.toString('utf8').replace(/[\u0000\u0020]+$/g, ''));
  }
  const list = (key: string): unknown[] => Array.isArray(document?.[key]) ? document[key] as unknown[] : [];
  const meshes = list('meshes') as Array<{ primitives?: unknown[] }>;
  if (!list('scenes').length || !list('nodes').length || !meshes.length || !meshes.some(mesh => mesh.primitives?.length)) {
    throw new Error(`${entry.path}: scene geometry missing`);
  }
  const match = basename(entry.path).match(/^pm(\d+)_(51|52)_00\.glb$/)!;
  return {
    speciesId: Number(match[1]), megaVariant: match[2] === '51' ? 1 : 2, sourcePath: entry.path,
    bytes: bytes.length, sourceGitBlobSha1: entry.sha, sha256: await digest(path, 'sha256'),
    scenes: list('scenes').length, nodes: list('nodes').length, meshes: meshes.length,
    skins: list('skins').length, animations: list('animations').length,
  };
}

const response = await fetch(TREE_URL, { headers: { 'User-Agent': 'choketmon-home-mega-research/1.0' } });
if (!response.ok) throw new Error(`tree HTTP ${response.status}`);
const tree = await response.json() as { sha: string; truncated: boolean; tree: TreeEntry[] };
if (tree.sha !== COMMIT || tree.truncated) throw new Error('pinned source tree mismatch or truncated');
const entries = tree.tree.filter(entry => entry.type === 'blob' && /pm\d+_(51|52)_00\.glb$/i.test(entry.path));
if (entries.length !== 50) throw new Error(`expected 50 established Mega models, found ${entries.length}`);
let cursor = 0;
const results = (await Promise.all(Array.from({ length: 6 }, async () => {
  const rows = [];
  while (cursor < entries.length) { const entry = entries[cursor++]; rows.push(await inspect(entry, await download(entry))); }
  return rows;
}))).flat().sort((a, b) => a.speciesId - b.speciesId || a.megaVariant - b.megaVariant);
await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, JSON.stringify({
  schema: 1, generatedAt: new Date().toISOString(), researchOnly: true,
  source: { repository: REPOSITORY, commit: COMMIT },
  rights: { status: 'unverified-do-not-redistribute', evidence: 'Pinned repository tree contains no license or README.' },
  scope: { models: results.length, species: new Set(results.map(row => row.speciesId)).size, bytes: results.reduce((sum, row) => sum + row.bytes, 0) },
  results,
}, null, 2) + '\n');
console.log(JSON.stringify({ models: results.length, species: new Set(results.map(row => row.speciesId)).size, bytes: results.reduce((sum, row) => sum + row.bytes, 0), output: OUTPUT }));
