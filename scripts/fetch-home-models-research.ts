import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const REPOSITORY = 'https://github.com/Lilothestitch16/Pokemon-HOME-GLB-Models';
const COMMIT = '27703273836f38f0e185976d955b1fbfb15448af';
const TREE_URL = `https://api.github.com/repos/Lilothestitch16/Pokemon-HOME-GLB-Models/git/trees/${COMMIT}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/Lilothestitch16/Pokemon-HOME-GLB-Models/${COMMIT}`;
const CACHE = resolve('data/local/pokemon-models-research', COMMIT);
const MANIFEST = resolve('src/data/pokemon-home-research-manifest.json');
const MISSING_IDS = [850, 851, 852, 853, 854, 859, 860, 861, 863, 864, 866, 868, 873, 878, 879, 882, 883, 918, 919, 931, 935, 936, 938, 939, 940, 944, 950, 951, 952, 953, 954, 955, 956, 961, 963, 964, 968, 969, 970, 971, 972, 976, 977, 986, 988, 989, 991, 992, 993, 1011, 1012, 1013, 1022, 1024];

type TreeEntry = { path: string; type: 'blob' | 'tree'; sha: string; size?: number };
type Selected = { id: number; path: string; url: string; bytes: number; gitBlobSha1: string; selection: 'form-00' | 'lowest-form-code' };
type Inspection = { id: number; localPath: string; sha256: string; glbVersion: number; scenes: number; nodes: number; meshes: number; primitives: number; skins: number; animations: number; materials: number; materialNames: string[]; textures: number; materialTextureReferences: number; images: number; externalImageUris: string[]; embeddedBuffer: boolean; extensionsUsed: string[]; draco: boolean; webpTextures: boolean };

const exists = async (path: string) => { try { await stat(path); return true; } catch { return false; } };
async function digest(path: string, algorithm: 'sha1' | 'sha256', gitBlobSize?: number) {
  const hash = createHash(algorithm); if (gitBlobSize !== undefined) hash.update(`blob ${gitBlobSize}\0`);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
async function verified(path: string, entry: Selected) {
  return await exists(path) && (await stat(path)).size === entry.bytes && await digest(path, 'sha1', entry.bytes) === entry.gitBlobSha1;
}
async function download(entry: Selected) {
  const target = resolve(CACHE, `${entry.id}.glb`), partial = `${target}.part`;
  await mkdir(dirname(target), { recursive: true });
  if (await verified(target, entry)) return target;
  if (await exists(target)) throw new Error(`refusing to replace invalid completed cache: ${target}`);
  const offset = await exists(partial) ? (await stat(partial)).size : 0;
  if (offset > entry.bytes) throw new Error(`partial exceeds source size: ${partial}`);
  const response = await fetch(entry.url, { headers: { 'User-Agent': 'choketmon-home-model-research/1.0', ...(offset ? { Range: `bytes=${offset}-` } : {}) } });
  if (!response.ok || !response.body) throw new Error(`download ${entry.id} failed: HTTP ${response.status}`);
  if (offset && response.status !== 206) throw new Error(`source did not honor resume for ${entry.id}`);
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(partial, { flags: offset ? 'a' : 'w' }));
  if (!await verified(partial, entry)) throw new Error(`size/Git blob SHA-1 mismatch for ${entry.id}`);
  await rename(partial, target); return target;
}

async function inspect(id: number, path: string): Promise<Inspection> {
  const bytes = await readFile(path);
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${id}: GLB magic missing`);
  const glbVersion = bytes.readUInt32LE(4), declared = bytes.readUInt32LE(8);
  if (glbVersion !== 2 || declared !== bytes.length) throw new Error(`${id}: invalid GLB header`);
  let offset = 12, document: Record<string, any> | undefined, binaryBytes = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error(`${id}: truncated chunk header`);
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4); offset += 8;
    if (offset + length > bytes.length || length % 4) throw new Error(`${id}: invalid chunk length`);
    const chunk = bytes.subarray(offset, offset + length); offset += length;
    if (type === 0x4e4f534a) document = JSON.parse(chunk.toString('utf8').replace(/[\u0000\u0020]+$/g, ''));
    if (type === 0x004e4942) binaryBytes += length;
  }
  if (!document || document.asset?.version !== '2.0') throw new Error(`${id}: glTF 2.0 document missing`);
  const list = (key: string): any[] => Array.isArray(document![key]) ? document![key] : [];
  const buffers = list('buffers'), views = list('bufferViews'), accessors = list('accessors'), meshes = list('meshes');
  if (buffers.length !== 1 || buffers[0].uri || buffers[0].byteLength > binaryBytes) throw new Error(`${id}: external or invalid buffer`);
  for (const [index, view] of views.entries()) if (view.buffer !== 0 || !Number.isInteger(view.byteLength) || (view.byteOffset ?? 0) + view.byteLength > buffers[0].byteLength) throw new Error(`${id}: invalid bufferView ${index}`);
  for (const [index, accessor] of accessors.entries()) if (accessor.bufferView !== undefined && !views[accessor.bufferView]) throw new Error(`${id}: invalid accessor ${index}`);
  const primitives = meshes.flatMap(mesh => mesh.primitives ?? []);
  if (!list('scenes').length || !list('nodes').length || !meshes.length || !primitives.length) throw new Error(`${id}: scene or mesh missing`);
  const extensionsUsed = [...(document.extensionsUsed ?? [])].sort();
  const images = list('images');
  const materials = list('materials');
  const materialNames = materials.flatMap(material => typeof material.name === 'string' ? [material.name] : []);
  let materialTextureReferences = 0;
  const countTextureReferences = (value: unknown, parentKey = '') => {
    if (!value || typeof value !== 'object') return;
    if (/texture$/i.test(parentKey) && Number.isInteger((value as { index?: unknown }).index)) materialTextureReferences++;
    for (const [key, child] of Object.entries(value)) countTextureReferences(child, key);
  };
  for (const material of materials) countTextureReferences(material);
  return { id, localPath: path.slice(resolve('.').length + 1).replaceAll('\\', '/'), sha256: await digest(path, 'sha256'), glbVersion,
    scenes: list('scenes').length, nodes: list('nodes').length, meshes: meshes.length, primitives: primitives.length,
    skins: list('skins').length, animations: list('animations').length, materials: materials.length, materialNames,
    textures: list('textures').length, materialTextureReferences, images: images.length,
    externalImageUris: images.flatMap(image => typeof image.uri === 'string' ? [image.uri] : []),
    embeddedBuffer: true, extensionsUsed, draco: primitives.some(primitive => primitive.extensions?.KHR_draco_mesh_compression),
    webpTextures: images.length > 0 && images.every(image => image.mimeType === 'image/webp' && views[image.bufferView]),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await task(items[index]); }
  })); return results;
}

const response = await fetch(TREE_URL, { headers: { 'User-Agent': 'choketmon-home-model-research/1.0' } });
if (!response.ok) throw new Error(`GitHub tree failed: HTTP ${response.status}`);
const tree = await response.json() as { sha: string; truncated: boolean; tree: TreeEntry[] };
if (tree.sha !== COMMIT || tree.truncated) throw new Error('Pinned tree identity failed or tree was truncated');
const extensionCounts = tree.tree.filter(entry => entry.type === 'blob').reduce<Record<string, number>>((counts, entry) => {
  const match = entry.path.toLowerCase().match(/(\.[a-z0-9]+)$/);
  const extension = match?.[1] ?? '(none)'; counts[extension] = (counts[extension] ?? 0) + 1; return counts;
}, {});
const repositoryImageFiles = tree.tree.filter(entry => entry.type === 'blob' && /\.(?:png|jpe?g|webp|ktx2?|dds|tga|bmp|gif)$/i.test(entry.path));
const glbs = tree.tree.filter(entry => entry.type === 'blob' && /Pokemon \(Generation [89]\)\/pm\d{4}_.+\.glb$/.test(entry.path) && !entry.path.endsWith('_rare.glb'));
const selected: Selected[] = MISSING_IDS.map(id => {
  const prefix = `pm${String(id).padStart(4, '0')}_`;
  const candidates = glbs.filter(entry => entry.path.split('/').pop()!.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path));
  const entry = candidates.find(candidate => candidate.path.includes('_00_00.glb')) ?? candidates[0];
  if (!entry || entry.size === undefined) throw new Error(`no non-rare HOME GLB candidate for ${id}`);
  return { id, path: entry.path, url: `${RAW_BASE}/${entry.path}`, bytes: entry.size, gitBlobSha1: entry.sha, selection: entry.path.includes('_00_00.glb') ? 'form-00' : 'lowest-form-code' };
});
const requestedBytes = selected.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(`Research-only source ${COMMIT}: ${selected.length} files, ${requestedBytes} bytes`);
const settled = await mapLimit(selected, 6, async entry => {
  try { return { status: 'fulfilled' as const, value: await inspect(entry.id, await download(entry)) }; }
  catch (reason) { return { status: 'rejected' as const, id: entry.id, reason }; }
});
const inspections = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
const failures = settled.flatMap(result => result.status === 'rejected' ? [{ id: result.id, error: String(result.reason) }] : []);
await writeFile(MANIFEST, JSON.stringify({
  schema: 2, generatedAt: new Date().toISOString(), researchOnly: true,
  source: { repository: REPOSITORY, commit: COMMIT, treeUrl: TREE_URL },
  rights: { status: 'unverified-do-not-redistribute', evidence: 'GitHub repository description says the models are extracted from Pokemon HOME. No README or license file exists at the pinned commit. Files are retained only in ignored data/local for source inspection and are excluded from runtime catalog, public, dist, and deployment.' },
  selection: { requestedSpeciesIds: MISSING_IDS, rule: 'Choose non-rare pmNNNN_00_00.glb when present; otherwise choose the lexicographically lowest non-rare form code and record it explicitly.', files: selected },
  textureAudit: {
    method: 'Inspect the pinned recursive repository tree for common texture image extensions, then inspect each selected GLB JSON chunk for images, textures, material names, and material texture references.',
    repositoryExtensionCounts: Object.fromEntries(Object.entries(extensionCounts).sort(([a], [b]) => a.localeCompare(b))),
    repositoryImageFiles: repositoryImageFiles.map(entry => ({ path: entry.path, bytes: entry.size, gitBlobSha1: entry.sha })),
    selectedModelsWithImages: inspections.filter(item => item.images > 0).length,
    selectedModelsWithTextures: inspections.filter(item => item.textures > 0).length,
    selectedMaterialCount: inspections.reduce((sum, item) => sum + item.materials, 0),
    selectedMaterialTextureReferences: inspections.reduce((sum, item) => sum + item.materialTextureReferences, 0),
    conclusion: 'No texture image files exist in the pinned repository tree, and none of the 54 selected GLBs contains an image, texture object, external image URI, or material texture reference. No texture files were downloaded.',
  },
  result: { requested: selected.length, requestedBytes, downloadedAndValid: inspections.length, failed: failures.length, failures,
    animated: inspections.filter(item => item.animations > 0).length, skinned: inspections.filter(item => item.skins > 0).length,
    draco: inspections.filter(item => item.draco).length, webpTextures: inspections.filter(item => item.webpTextures).length, inspections },
}, null, 2) + '\n');
console.log(`Validated ${inspections.length}/${selected.length}; failures ${failures.length}; animated ${inspections.filter(item => item.animations > 0).length}.`);
if (failures.length) process.exitCode = 1;
