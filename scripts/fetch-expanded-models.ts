import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const REPOSITORY = 'https://github.com/Pokemon-3D-api/assets';
const COMMIT = '429de1288cea0d43f5b4f56305d2276e94239d65';
const TREE_URL = `https://api.github.com/repos/Pokemon-3D-api/assets/git/trees/${COMMIT}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/Pokemon-3D-api/assets/${COMMIT}`;
const CACHE = resolve('data/local/pokemon-models-expanded', COMMIT);
const CATALOG_OUTPUT = resolve('src/data/pokemon-models.ts');
const MANIFEST_OUTPUT = resolve('src/data/pokemon-models-manifest.json');
const REPRESENTATIVE_IDS = [152, 155, 158, 252, 387, 495, 650, 722, 810, 906];
const GENDER_DEFAULTS = new Map([[521, '521-M.glb'], [668, '668-M.glb'], [916, '916-M.glb']]);

type TreeEntry = { path: string; mode: string; type: 'blob' | 'tree'; sha: string; size?: number };
type ModelEntry = { id: number; sourcePath: string; sourceUrl: string; bytes: number; sourceGitBlobSha1: string; genderDefault?: 'male' };
type Inspection = {
  id: number; cachePath: string; sha256: string; glbVersion: number; scenes: number; nodes: number;
  meshes: number; primitives: number; skins: number; animations: number; materials: number; images: number;
  embeddedBuffer: boolean; extensionsUsed: string[]; extensionsRequired: string[]; draco: boolean; webpTextures: boolean;
};
type PreviousManifest = {
  source?: { commit?: string };
  sample?: { scope?: string; requestedIds?: number[]; totalBytes?: number; inspections?: Inspection[] };
};

const exists = async (path: string) => { try { await stat(path); return true; } catch { return false; } };
async function digest(path: string, algorithm: 'sha1' | 'sha256', gitBlobSize?: number) {
  const hash = createHash(algorithm); if (gitBlobSize !== undefined) hash.update(`blob ${gitBlobSize}\0`);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
async function verified(path: string, entry: ModelEntry) {
  return await exists(path) && (await stat(path)).size === entry.bytes
    && await digest(path, 'sha1', entry.bytes) === entry.sourceGitBlobSha1;
}

function parseArgs() {
  const at = process.argv.indexOf('--ids');
  const concurrencyAt = process.argv.indexOf('--concurrency');
  const all = process.argv.includes('--all');
  const ids = at >= 0 ? process.argv[at + 1].split(',').map(Number) : REPRESENTATIVE_IDS;
  const concurrency = concurrencyAt >= 0 ? Number(process.argv[concurrencyAt + 1]) : 6;
  if (all && at >= 0) throw new Error('--all and --ids cannot be combined');
  if (!ids.length || ids.some(id => !Number.isInteger(id) || id < 152 || id > 1025) || new Set(ids).size !== ids.length) {
    throw new Error('--ids must contain unique National Pokedex IDs 152..1025');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('--concurrency must be 1..8');
  return { ids: ids.sort((a, b) => a - b), all, concurrency, catalogOnly: process.argv.includes('--catalog-only') };
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await task(items[index]); }
  }));
  return results;
}

async function download(entry: ModelEntry) {
  const target = resolve(CACHE, `${entry.id}.glb`), partial = `${target}.part`;
  await mkdir(dirname(target), { recursive: true });
  if (await verified(target, entry)) return target;
  if (await exists(target)) throw new Error(`refusing to replace invalid cache: ${target}`);
  const offset = await exists(partial) ? (await stat(partial)).size : 0;
  if (offset > entry.bytes) throw new Error(`partial exceeds source size: ${partial}`);
  const response = await fetch(entry.sourceUrl, { headers: {
    'User-Agent': 'choketmon-expanded-model-audit/1.0', ...(offset ? { Range: `bytes=${offset}-` } : {}),
  } });
  if (!response.ok || !response.body) throw new Error(`download ${entry.id} failed: HTTP ${response.status}`);
  if (offset && response.status !== 206) { await rm(partial, { force: true }); throw new Error(`source did not honor resume for ${entry.id}`); }
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(partial, { flags: offset ? 'a' : 'w' }));
  if (!await verified(partial, entry)) throw new Error(`size/Git blob SHA-1 mismatch for ${entry.id}`);
  await rename(partial, target); return target;
}

async function inspectGlb(id: number, path: string): Promise<Inspection> {
  const bytes = await readFile(path);
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${id}: missing GLB magic`);
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
  if (!document || document.asset?.version !== '2.0') throw new Error(`${id}: missing glTF 2.0 document`);
  const list = (key: string): any[] => Array.isArray(document![key]) ? document![key] : [];
  const buffers = list('buffers'), views = list('bufferViews'), accessors = list('accessors'), meshes = list('meshes');
  if (buffers.length !== 1 || buffers[0].uri || buffers[0].byteLength > binaryBytes) throw new Error(`${id}: external or invalid buffer`);
  for (const [index, view] of views.entries()) if (view.buffer !== 0 || !Number.isInteger(view.byteLength) || (view.byteOffset ?? 0) + view.byteLength > buffers[0].byteLength) throw new Error(`${id}: invalid bufferView ${index}`);
  for (const [index, accessor] of accessors.entries()) if (accessor.bufferView !== undefined && !views[accessor.bufferView]) throw new Error(`${id}: invalid accessor ${index}`);
  const primitives = meshes.flatMap(mesh => mesh.primitives ?? []);
  if (!list('scenes').length || !list('nodes').length || !meshes.length || !primitives.length) throw new Error(`${id}: scene or mesh missing`);
  const extensionsUsed = [...(document.extensionsUsed ?? [])].sort(), extensionsRequired = [...(document.extensionsRequired ?? [])].sort();
  const draco = primitives.some(primitive => primitive.extensions?.KHR_draco_mesh_compression);
  const images = list('images'), webpTextures = images.length > 0 && images.every(image => image.mimeType === 'image/webp' && views[image.bufferView]);
  if (draco && !extensionsUsed.includes('KHR_draco_mesh_compression')) throw new Error(`${id}: Draco primitive is not declared`);
  return {
    id, cachePath: path.slice(resolve('.').length + 1).replaceAll('\\', '/'), sha256: await digest(path, 'sha256'), glbVersion,
    scenes: list('scenes').length, nodes: list('nodes').length, meshes: meshes.length, primitives: primitives.length,
    skins: list('skins').length, animations: list('animations').length, materials: list('materials').length, images: images.length,
    embeddedBuffer: true, extensionsUsed, extensionsRequired, draco, webpTextures,
  };
}

function makeCatalog(entries: ModelEntry[], missingIds: number[], inspections: Inspection[]) {
  const expandedIds = entries.map(entry => entry.id);
  const bytes = Object.fromEntries(entries.map(entry => [entry.id, entry.bytes]));
  const overrides = Object.fromEntries(entries.filter(entry => entry.genderDefault).map(entry => [entry.id, entry.sourcePath.split('/').pop()]));
  const nonDracoIds = inspections.filter(item => !item.draco).map(item => item.id);
  const nonWebpIds = inspections.filter(item => !item.webpTextures).map(item => item.id);
  return `// Generated by scripts/fetch-expanded-models.ts. Do not edit by hand.\n` +
    `export type PokemonModelSource = { id: number; url: string; format: 'glb'; requiresDraco: boolean; compression?: 'KHR_draco_mesh_compression'; textureEncoding?: 'webp'; repository: string; commit: string; sourcePath: string; bytes?: number };\n\n` +
    `export const LEGACY_MODEL_COMMIT = '00d96f7f18894055e7f1db44fa0df6462e5e4c8a';\n` +
    `export const EXPANDED_MODEL_COMMIT = '${COMMIT}';\n` +
    `export const EXPANDED_POKEMON_MODEL_IDS: readonly number[] = ${JSON.stringify(expandedIds)};\n` +
    `export const MISSING_POKEMON_MODEL_IDS: readonly number[] = ${JSON.stringify(missingIds)};\n` +
    `export const EXPANDED_NON_DRACO_MODEL_IDS: readonly number[] = ${JSON.stringify(nonDracoIds)};\n` +
    `export const EXPANDED_NON_WEBP_MODEL_IDS: readonly number[] = ${JSON.stringify(nonWebpIds)};\n` +
    `const EXPANDED_MODEL_SET = new Set(EXPANDED_POKEMON_MODEL_IDS);\nconst EXPANDED_MODEL_BYTES: Record<number, number> = ${JSON.stringify(bytes)};\n` +
    `const EXPANDED_NON_DRACO_SET = new Set(EXPANDED_NON_DRACO_MODEL_IDS);\nconst EXPANDED_NON_WEBP_SET = new Set(EXPANDED_NON_WEBP_MODEL_IDS);\n` +
    `const EXPANDED_PATH_OVERRIDES: Record<number, string> = ${JSON.stringify(overrides)};\n\n` +
    `export function hasPokemonModel(id: number): boolean { return Number.isInteger(id) && id >= 1 && (id <= 151 || EXPANDED_MODEL_SET.has(id)); }\n` +
    `export function getPokemonModelSource(id: number): PokemonModelSource | undefined {\n` +
    `  if (!hasPokemonModel(id)) return undefined;\n` +
    `  if (id <= 151) { const sourcePath = \`public/models/\${String(id).padStart(3, '0')}/model.glb\`; return { id, url: \`https://raw.githubusercontent.com/06wj/pokemon/\${LEGACY_MODEL_COMMIT}/\${sourcePath}\`, format: 'glb', requiresDraco: false, repository: 'https://github.com/06wj/pokemon', commit: LEGACY_MODEL_COMMIT, sourcePath }; }\n` +
    `  const file = EXPANDED_PATH_OVERRIDES[id] ?? \`\${id}.glb\`, sourcePath = \`models/opt/regular/\${file}\`;\n` +
    `  const requiresDraco = !EXPANDED_NON_DRACO_SET.has(id);\n` +
    `  return { id, url: \`https://raw.githubusercontent.com/Pokemon-3D-api/assets/\${EXPANDED_MODEL_COMMIT}/\${sourcePath}\`, format: 'glb', requiresDraco, ...(requiresDraco ? { compression: 'KHR_draco_mesh_compression' as const } : {}), ...(!EXPANDED_NON_WEBP_SET.has(id) ? { textureEncoding: 'webp' as const } : {}), repository: '${REPOSITORY}', commit: EXPANDED_MODEL_COMMIT, sourcePath, bytes: EXPANDED_MODEL_BYTES[id] };\n` +
    `}\n`;
}

async function main() {
  const { ids, all, concurrency, catalogOnly } = parseArgs();
  const previousManifest = await exists(MANIFEST_OUTPUT)
    ? JSON.parse(await readFile(MANIFEST_OUTPUT, 'utf8')) as PreviousManifest
    : undefined;
  const previousInspections = previousManifest?.source?.commit === COMMIT && Array.isArray(previousManifest.sample?.inspections)
    ? previousManifest.sample.inspections
    : [];
  if (catalogOnly && previousInspections.length === 0) {
    throw new Error('--catalog-only requires inspection evidence from an existing manifest for the same pinned commit');
  }
  const response = await fetch(TREE_URL, { headers: { 'User-Agent': 'choketmon-expanded-model-audit/1.0' } });
  if (!response.ok) throw new Error(`GitHub tree failed: HTTP ${response.status}`);
  const tree = await response.json() as { sha: string; truncated: boolean; tree: TreeEntry[] };
  if (tree.sha !== COMMIT || tree.truncated) throw new Error('Pinned tree identity failed or tree was truncated');
  const regular = tree.tree.filter(entry => entry.type === 'blob' && /^models\/opt\/regular\/.+\.glb$/.test(entry.path));
  const numeric = new Map<number, TreeEntry>();
  for (const entry of regular) { const match = entry.path.match(/^models\/opt\/regular\/(\d+)\.glb$/); if (match) numeric.set(Number(match[1]), entry); }
  const supported: ModelEntry[] = [];
  for (let id = 152; id <= 1025; id++) {
    const normal = numeric.get(id), genderFile = GENDER_DEFAULTS.get(id);
    const selected = normal ?? (genderFile ? regular.find(entry => entry.path === `models/opt/regular/${genderFile}`) : undefined);
    if (selected?.size === undefined) continue;
    supported.push({ id, sourcePath: selected.path, sourceUrl: `${RAW_BASE}/${selected.path}`, bytes: selected.size, sourceGitBlobSha1: selected.sha, ...(genderFile && !normal ? { genderDefault: 'male' as const } : {}) });
  }
  const supportedSet = new Set(supported.map(entry => entry.id));
  const missingIds = Array.from({ length: 874 }, (_, index) => index + 152).filter(id => !supportedSet.has(id));
  if (regular.length !== 974 || supported.length !== 820 || missingIds.length !== 54) throw new Error(`Pinned catalog shape changed: regular=${regular.length}, supported=${supported.length}, missing=${missingIds.length}`);
  const selected = all ? supported : ids.map(id => { const entry = supported.find(item => item.id === id); if (!entry) throw new Error(`model ${id} is absent at pinned commit`); return entry; });
  const inspections = catalogOnly ? [] : await mapLimit(selected, concurrency, async entry => inspectGlb(entry.id, await download(entry)));
  const supportedById = new Map(supported.map(entry => [entry.id, entry]));
  const mergedById = new Map(previousInspections.filter(item => supportedById.has(item.id)).map(item => [item.id, item]));
  for (const inspection of inspections) mergedById.set(inspection.id, inspection);
  const mergedInspections = [...mergedById.values()].sort((a, b) => a.id - b.id);
  const hasFullAudit = mergedInspections.length === supported.length && supported.every(entry => mergedById.has(entry.id));
  const auditedEntries = hasFullAudit ? supported : mergedInspections.map(item => supportedById.get(item.id)!);
  const sample = {
    scope: hasFullAudit ? 'all-expanded' : 'incremental',
    requestedIds: auditedEntries.map(entry => entry.id),
    totalBytes: auditedEntries.reduce((sum, entry) => sum + entry.bytes, 0),
    inspections: mergedInspections,
  };
  const catalog = makeCatalog(supported, missingIds, mergedInspections); await writeFile(CATALOG_OUTPUT, catalog);
  const readme = tree.tree.find(entry => entry.path === 'README.md')!, license = tree.tree.find(entry => entry.path === 'LICENSE')!;
  const manifest = {
    schema: 1, generatedAt: new Date().toISOString(), source: { repository: REPOSITORY, commit: COMMIT, treeUrl: TREE_URL, commitDate: '2026-08-22T14:05:39Z' },
    provenance: { pipelineDescription: 'Repository README says source GLBs are downloaded from Sketchfab, Draco-compressed, and textures converted to WebP; pinned scripts/model_map.json is empty, so per-file upstream creator/license provenance is unavailable.', readme: { path: readme.path, bytes: readme.size, gitBlobSha1: readme.sha }, license: { path: license.path, bytes: license.size, gitBlobSha1: license.sha, spdx: 'MIT' } },
    rights: 'README says all 3D models are property of Nintendo/Creatures Inc./GAME FREAK inc. MIT covers repository software but does not establish redistribution rights for model assets; runtime uses pinned owner URLs and this project does not copy these files into deployment output.',
    alternativesReviewed: [
      { repository: 'https://github.com/Sudhanshu-Ambastha/Pokemon-3D', commit: 'eaccd7e5e9522623d6d41249131a0aeb676388da', result: 'Archived predecessor contains the same model collection and fills none of the 54 missing regular species.' },
      { repository: 'https://github.com/Lilothestitch16/Pokemon-HOME-GLB-Models', commit: '27703273836f38f0e185976d955b1fbfb15448af', result: 'All 54 missing species were inspected locally as research-only geometry. The selected GLBs contain no images or texture references, and the pinned repository has no license; they remain excluded from the runtime catalog.' },
      { repository: 'https://github.com/dnnyngyen/codex-pokepets', commit: '3bff0e1def268a3504f9cba1bec467a5d901d20b', result: 'The advertised generation 1-9 3D assets are rendered animated sprites rather than GLB/glTF geometry, so they do not satisfy the 3D-model requirement.' },
    ],
    catalog: { nationalRange: [1, 1025], legacySpecies: 151, expandedSpecies: supported.length, totalSupportedSpecies: 151 + supported.length, missingSpecies: missingIds.length, missingIds, regularFiles: regular.length, regularBytes: regular.reduce((sum, entry) => sum + (entry.size ?? 0), 0), expandedEntries: supported },
    declaredEncoding: { format: 'glb', gltfVersion: 2, compression: 'KHR_draco_mesh_compression', textureEncoding: 'webp' },
    sample,
    output: { path: 'src/data/pokemon-models.ts', sha256: createHash('sha256').update(catalog).digest('hex') },
  };
  await writeFile(MANIFEST_OUTPUT, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Cataloged ${supported.length} post-Kanto species; ${missingIds.length} missing; inspected ${inspections.length} models this run (${mergedInspections.length} retained audits, ${sample.totalBytes} audited bytes).`);
}

await main();
