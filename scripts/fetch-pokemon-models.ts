import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const REPOSITORY = 'https://github.com/06wj/pokemon';
const COMMIT = '00d96f7f18894055e7f1db44fa0df6462e5e4c8a';
const TREE_API = `https://api.github.com/repos/06wj/pokemon/git/trees/${COMMIT}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/06wj/pokemon/${COMMIT}`;
const CACHE = resolve('data/local/pokemon-models', COMMIT);
const OUTPUT = resolve('public/models/pokemon');

type TreeEntry = { path: string; mode: string; type: string; sha: string; size: number };
type Inspection = {
  glbVersion: number; scenes: number; nodes: number; meshes: number; primitives: number; skins: number;
  animations: number; materials: number; embeddedImages: number; accessors: number; bufferViews: number;
  binaryBytes: number; extensionsUsed: string[]; draco: boolean;
};
type FileRecord = Inspection & {
  id: number; path: string; sourcePath: string; sourceUrl: string; bytes: number;
  sourceGitBlobSha1: string; sha256: string;
};

function parseArgs() {
  const idsAt = process.argv.indexOf('--ids');
  const concurrencyAt = process.argv.indexOf('--concurrency');
  const ids = process.argv.includes('--all') ? Array.from({ length: 151 }, (_, i) => i + 1)
    : (idsAt >= 0 ? process.argv[idsAt + 1] : '1,4,7,25').split(',').map(Number);
  const concurrency = concurrencyAt >= 0 ? Number(process.argv[concurrencyAt + 1]) : 6;
  if (!ids.length || ids.some(id => !Number.isInteger(id) || id < 1 || id > 151) || new Set(ids).size !== ids.length) throw new Error('--ids must contain unique Pokedex IDs 1..151');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error('--concurrency must be 1..6');
  return { ids: [...ids].sort((a, b) => a - b), concurrency };
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function digest(path: string, algorithm: 'sha1' | 'sha256', gitBlobBytes?: number): Promise<string> {
  const hash = createHash(algorithm);
  if (gitBlobBytes !== undefined) hash.update(`blob ${gitBlobBytes}\0`);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function verified(path: string, entry: TreeEntry): Promise<boolean> {
  if (!await exists(path) || (await stat(path)).size !== entry.size) return false;
  return await digest(path, 'sha1', entry.size) === entry.sha;
}

async function download(entry: TreeEntry): Promise<string> {
  const id = Number(entry.path.match(/^public\/models\/(\d{3})\/model\.glb$/)?.[1]);
  const target = resolve(CACHE, `${String(id).padStart(3, '0')}.glb`);
  const partial = `${target}.part`;
  await mkdir(dirname(target), { recursive: true });
  if (await verified(target, entry)) { console.log(`reuse ${id}: ${entry.size} bytes`); return target; }
  if (await exists(target)) throw new Error(`refusing to replace invalid completed cache file: ${target}`);
  const offset = await exists(partial) ? (await stat(partial)).size : 0;
  if (offset > entry.size) throw new Error(`partial file exceeds source size: ${partial}`);
  const response = await fetch(`${RAW_BASE}/${entry.path}`, {
    headers: { 'User-Agent': 'choketmon-model-fetch', ...(offset ? { Range: `bytes=${offset}-` } : {}) },
  });
  if (!response.ok || !response.body) throw new Error(`download ${id} failed: HTTP ${response.status}`);
  if (offset && response.status !== 206) throw new Error(`source did not honor resume for ${id}: HTTP ${response.status}`);
  const file = createWriteStream(partial, { flags: offset ? 'a' : 'w' });
  await pipeline(response.body as unknown as NodeJS.ReadableStream, file);
  if (!await verified(partial, entry)) throw new Error(`source size/Git blob SHA-1 mismatch for ${id}`);
  await rename(partial, target);
  console.log(`downloaded ${id}: ${entry.size} bytes`);
  return target;
}

function uint32(buffer: Buffer, offset: number): number { return buffer.readUInt32LE(offset); }

async function inspectGlb(path: string): Promise<Inspection> {
  const bytes = await readFile(path);
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${path}: GLB magic missing`);
  const version = uint32(bytes, 4), declared = uint32(bytes, 8);
  if (version !== 2 || declared !== bytes.length) throw new Error(`${path}: invalid GLB version/declared length`);
  let offset = 12, document: Record<string, any> | undefined, binaryBytes = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error(`${path}: truncated GLB chunk header`);
    const length = uint32(bytes, offset), type = uint32(bytes, offset + 4); offset += 8;
    if (offset + length > bytes.length || length % 4) throw new Error(`${path}: invalid GLB chunk length`);
    const chunk = bytes.subarray(offset, offset + length); offset += length;
    if (type === 0x4e4f534a) {
      if (document) throw new Error(`${path}: duplicate JSON chunk`);
      document = JSON.parse(chunk.toString('utf8').replace(/[\u0000\u0020]+$/g, ''));
    } else if (type === 0x004e4942) binaryBytes += length;
  }
  if (!document || document.asset?.version !== '2.0') throw new Error(`${path}: missing glTF 2.0 JSON`);
  const list = (name: string): any[] => Array.isArray(document![name]) ? document![name] : [];
  const buffers = list('buffers'), views = list('bufferViews'), accessors = list('accessors');
  const nodes = list('nodes'), meshes = list('meshes'), skins = list('skins'), animations = list('animations'), images = list('images'), materials = list('materials');
  if (!list('scenes').length || !nodes.length || !meshes.length || !skins.length || !animations.length) throw new Error(`${path}: expected scene, nodes, meshes, skin, and animations`);
  if (buffers.length !== 1 || buffers[0].uri || buffers[0].byteLength > binaryBytes) throw new Error(`${path}: GLB binary buffer is missing or external`);
  for (const [index, view] of views.entries()) {
    if (!Number.isInteger(view.buffer) || view.buffer !== 0 || !Number.isInteger(view.byteLength) || view.byteLength < 0 || (view.byteOffset ?? 0) + view.byteLength > buffers[0].byteLength) throw new Error(`${path}: invalid bufferView ${index}`);
  }
  for (const [index, accessor] of accessors.entries()) {
    if (accessor.bufferView !== undefined && (!Number.isInteger(accessor.bufferView) || !views[accessor.bufferView])) throw new Error(`${path}: invalid accessor ${index}`);
    if (!Number.isInteger(accessor.count) || accessor.count < 0) throw new Error(`${path}: invalid accessor count ${index}`);
  }
  const primitives = meshes.reduce((sum, mesh) => sum + (Array.isArray(mesh.primitives) ? mesh.primitives.length : 0), 0);
  if (!primitives) throw new Error(`${path}: no mesh primitives`);
  for (const [meshIndex, mesh] of meshes.entries()) for (const primitive of mesh.primitives ?? []) {
    if (!primitive.attributes || !Object.values(primitive.attributes).every(value => Number.isInteger(value) && accessors[value as number])) throw new Error(`${path}: mesh ${meshIndex} has invalid attributes`);
    if (primitive.indices !== undefined && (!Number.isInteger(primitive.indices) || !accessors[primitive.indices])) throw new Error(`${path}: mesh ${meshIndex} has invalid indices`);
    if (primitive.material !== undefined && (!Number.isInteger(primitive.material) || !materials[primitive.material])) throw new Error(`${path}: mesh ${meshIndex} has invalid material`);
  }
  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.mesh !== undefined && (!Number.isInteger(node.mesh) || !meshes[node.mesh])) throw new Error(`${path}: node ${nodeIndex} has invalid mesh`);
    if (node.skin !== undefined && (!Number.isInteger(node.skin) || !skins[node.skin])) throw new Error(`${path}: node ${nodeIndex} has invalid skin`);
  }
  for (const [skinIndex, skin] of skins.entries()) {
    if (!Array.isArray(skin.joints) || !skin.joints.length || !skin.joints.every((joint: unknown) => Number.isInteger(joint) && nodes[joint as number])) throw new Error(`${path}: skin ${skinIndex} has invalid joints`);
    if (skin.inverseBindMatrices !== undefined && (!Number.isInteger(skin.inverseBindMatrices) || !accessors[skin.inverseBindMatrices])) throw new Error(`${path}: skin ${skinIndex} has invalid inverse bind matrices`);
  }
  for (const [animationIndex, animation] of animations.entries()) {
    if (!Array.isArray(animation.samplers) || !animation.samplers.length || !Array.isArray(animation.channels) || !animation.channels.length) throw new Error(`${path}: animation ${animationIndex} is empty`);
    for (const sampler of animation.samplers) if (!accessors[sampler.input] || !accessors[sampler.output]) throw new Error(`${path}: animation ${animationIndex} has invalid sampler accessors`);
    for (const channel of animation.channels) if (!animation.samplers[channel.sampler] || !channel.target || !nodes[channel.target.node]) throw new Error(`${path}: animation ${animationIndex} has invalid channel target`);
  }
  for (const [index, image] of images.entries()) if (image.bufferView === undefined || !views[image.bufferView] || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)) throw new Error(`${path}: image ${index} is not embedded`);
  const extensionsUsed = Array.isArray(document.extensionsUsed) ? [...document.extensionsUsed].sort() : [];
  const draco = JSON.stringify(meshes).includes('KHR_draco_mesh_compression');
  if (draco) throw new Error(`${path}: unexpected Draco-compressed geometry`);
  return {
    glbVersion: version, scenes: list('scenes').length, nodes: list('nodes').length, meshes: meshes.length,
    primitives, skins: skins.length, animations: animations.length, materials: materials.length,
    embeddedImages: images.length, accessors: accessors.length, bufferViews: views.length, binaryBytes,
    extensionsUsed, draco,
  };
}

async function publish(cachePath: string, id: number, sha256: string): Promise<string> {
  const target = resolve(OUTPUT, `${id}.glb`), partial = `${target}.part`;
  await mkdir(dirname(target), { recursive: true });
  if (await exists(target)) {
    if (await digest(target, 'sha256') !== sha256) throw new Error(`refusing to replace different public model: ${target}`);
    return target;
  }
  await copyFile(cachePath, partial); await rename(partial, target); return target;
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await task(items[index]); }
  });
  await Promise.all(workers); return results;
}

async function main() {
  const { ids, concurrency } = parseArgs();
  const response = await fetch(TREE_API, { headers: { 'User-Agent': 'choketmon-model-fetch' } });
  if (!response.ok) throw new Error(`GitHub tree failed: HTTP ${response.status}`);
  const tree = await response.json() as { sha: string; truncated: boolean; tree: TreeEntry[] };
  if (tree.truncated) throw new Error('GitHub tree response is truncated');
  const entries = tree.tree.filter(entry => entry.type === 'blob' && /^public\/models\/\d{3}\/model\.glb$/.test(entry.path));
  if (entries.length !== 151) throw new Error(`pinned tree must contain 151 regular GLBs, found ${entries.length}`);
  const byId = new Map(entries.map(entry => [Number(entry.path.slice(14, 17)), entry]));
  const selected = ids.map(id => { const entry = byId.get(id); if (!entry) throw new Error(`model ${id} missing`); return entry; });
  console.log(`source ${COMMIT}; ${entries.length} models; ${entries.reduce((sum, entry) => sum + entry.size, 0)} bytes total; fetching ${selected.length}`);
  const records = await mapLimit(selected, concurrency, async entry => {
    const id = Number(entry.path.slice(14, 17));
    const cachePath = await download(entry), inspection = await inspectGlb(cachePath);
    const sha256 = await digest(cachePath, 'sha256');
    const publicPath = await publish(cachePath, id, sha256);
    return { id, path: publicPath.slice(resolve('.').length + 1).replaceAll('\\', '/'), sourcePath: entry.path,
      sourceUrl: `${RAW_BASE}/${entry.path}`, bytes: entry.size, sourceGitBlobSha1: entry.sha, sha256, ...inspection } satisfies FileRecord;
  });
  records.sort((a, b) => a.id - b.id);
  const manifest = {
    schema: 1, source: { repository: REPOSITORY, commit: COMMIT, treeApi: TREE_API },
    scope: records.length === 151 ? 'all-151-regular-forms' : `sample-${records.map(record => record.id).join('-')}`,
    rights: 'Repository README says Pokemon characters and associated assets belong to their respective owners and grants no asset rights. Local fan-game evaluation only; external distribution rights not established.',
    files: records,
    summary: {
      files: records.length, bytes: records.reduce((sum, record) => sum + record.bytes, 0),
      animations: records.reduce((sum, record) => sum + record.animations, 0),
      maxNodes: Math.max(...records.map(record => record.nodes)), maxMeshes: Math.max(...records.map(record => record.meshes)),
      maxSkins: Math.max(...records.map(record => record.skins)), maxAnimations: Math.max(...records.map(record => record.animations)),
      allSelfContained: records.every(record => record.embeddedImages > 0), allSkinned: records.every(record => record.skins > 0),
      allAnimated: records.every(record => record.animations > 0), anyDraco: records.some(record => record.draco),
    },
  };
  const manifestPath = resolve(OUTPUT, records.length === 151 ? 'manifest.json' : 'manifest.sample.json');
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest.summary)); console.log(`wrote ${manifestPath}`);
}

async function writeFileAtomic(path: string, data: string) {
  const partial = `${path}.part`; await mkdir(dirname(path), { recursive: true });
  const handle = await open(partial, 'w'); try { await handle.writeFile(data, 'utf8'); } finally { await handle.close(); }
  await rename(partial, path);
}

await main();
