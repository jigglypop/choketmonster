import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PRIMARY_COMMIT = '429de1288cea0d43f5b4f56305d2276e94239d65';
const FALLBACK_COMMIT = '27703273836f38f0e185976d955b1fbfb15448af';
const primaryRepo = resolve('data/local/source-audit-pokemon-3d-api');
const primaryCache = resolve('data/local/pokemon-models-research', PRIMARY_COMMIT, 'mega-forms');
const fallbackCache = resolve('data/local/pokemon-models-research', FALLBACK_COMMIT, 'mega-forms');
const output = resolve('artifacts/research/mega-models/source-manifest.json');

function sha(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest('hex');
}

function gitBlobSha(bytes) {
  return sha(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), 'sha1');
}

function inspectGlb(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error('invalid GLB 2.0 header');
  }
  let offset = 12;
  let document;
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 || offset + length > bytes.length) throw new Error('invalid GLB chunk');
    if (type === 0x4e4f534a) document = JSON.parse(bytes.subarray(offset, offset + length).toString('utf8').replace(/[\u0000\u0020]+$/g, ''));
    offset += length;
  }
  if (!document) throw new Error('missing GLB JSON document');
  const count = key => Array.isArray(document[key]) ? document[key].length : 0;
  const images = Array.isArray(document.images) ? document.images : [];
  const embeddedImages = images.filter(image => Number.isInteger(image.bufferView)).length;
  const externalImages = images.filter(image => typeof image.uri === 'string' && !image.uri.startsWith('data:')).length;
  const dataImages = images.filter(image => typeof image.uri === 'string' && image.uri.startsWith('data:')).length;
  const extras = document.asset?.extras && typeof document.asset.extras === 'object' ? document.asset.extras : {};
  return {
    assetTitle: typeof extras.title === 'string' ? extras.title : null,
    assetAuthor: typeof extras.author === 'string' ? extras.author : null,
    assetLicense: typeof extras.license === 'string' ? extras.license : null,
    assetSource: typeof extras.source === 'string' ? extras.source : null,
    imageNames: images.map(image => typeof image.name === 'string' ? image.name : null).filter(Boolean),
    scenes: count('scenes'), nodes: count('nodes'), meshes: count('meshes'), materials: count('materials'),
    textures: count('textures'), images: images.length, embeddedImages, dataImages, externalImages,
    skins: count('skins'), animations: count('animations'),
    hasGeometry: count('scenes') > 0 && count('nodes') > 0 && count('meshes') > 0,
    hasSelfContainedTextures: count('textures') > 0 && images.length > 0 && externalImages === 0,
  };
}

const combatSource = readFileSync(resolve('src/data/pokemon-combat-forms.ts'), 'utf8');
const recordsMatch = combatSource.match(/const RECORDS: CombatFormRecord\[\] = (\[.*\]);\r?\nconst metadata/s);
if (!recordsMatch) throw new Error('could not parse combat form records');
const megaRecords = JSON.parse(recordsMatch[1]).filter(record => record.kind === 'mega');

// Do not use `ls-tree -l` in this partial clone: asking for object sizes lazily downloads every model blob.
const treeLines = execFileSync('git', ['-C', primaryRepo, 'ls-tree', '-r', PRIMARY_COMMIT, 'models/opt'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split(/\r?\n/);
const primaryTree = new Map();
for (const line of treeLines) {
  const match = line.match(/^\d+ blob ([0-9a-f]{40})\t(.+\.glb)$/);
  if (match) primaryTree.set(match[2], { blobSha1: match[1] });
}

const primaryPathFor = record => {
  const exact = {
    'charizard-mega-x': 'models/opt/x/6.glb', 'charizard-mega-y': 'models/opt/y/6.glb',
    'blastoise-mega': 'models/opt/y/9.glb',
    'raichu-mega-x': 'models/opt/x/26.glb', 'raichu-mega-y': 'models/opt/y/26.glb',
    'mewtwo-mega-x': 'models/opt/x/150.glb', 'mewtwo-mega-y': 'models/opt/y/150.glb',
    'garchomp-mega-z': 'models/opt/za/445.glb', 'lucario-mega-z': 'models/opt/za/448.glb',
  };
  if (exact[record.identifier]) return exact[record.identifier];
  // These records share a species with another canonical form, so a species-only file cannot identify them safely.
  if (['absol-mega-z', 'magearna-original-mega'].includes(record.identifier) || record.identifier.startsWith('meowstic-') || record.identifier.startsWith('tatsugiri-')) return null;
  const candidate = `models/opt/mega/${record.speciesId}.glb`;
  return primaryTree.has(candidate) ? candidate : null;
};

const fallbackAudit = JSON.parse(readFileSync(resolve('artifacts/research/region-expansion/home-mega-model-audit.json'), 'utf8'));
const fallbackByKey = new Map(fallbackAudit.results.map(row => [`${row.speciesId}:${row.megaVariant}`, row]));
const fallbackVariantFor = identifier => identifier.endsWith('-mega-y') ? 2 : 1;
const permitsFallback = identifier => !identifier.endsWith('-mega-z')
  && identifier !== 'magearna-original-mega'
  && !identifier.startsWith('meowstic-')
  && !identifier.startsWith('tatsugiri-');

function cachePrimary(sourcePath) {
  const entry = primaryTree.get(sourcePath);
  if (!entry) throw new Error(`missing pinned tree entry: ${sourcePath}`);
  const target = join(primaryCache, sourcePath.replace(/^models\/opt\//, ''));
  let bytes;
  try { bytes = readFileSync(target); } catch {
    mkdirSync(dirname(target), { recursive: true });
    const url = `https://raw.githubusercontent.com/Pokemon-3D-api/assets/${PRIMARY_COMMIT}/${sourcePath}`;
    execFileSync('curl.exe', ['-fL', '--retry', '3', '--retry-delay', '1', '-o', target, url], { stdio: 'ignore' });
    bytes = readFileSync(target);
  }
  if (gitBlobSha(bytes) !== entry.blobSha1) throw new Error(`pinned Git blob mismatch: ${sourcePath}`);
  return { target, bytes, entry };
}

const primaryInspections = new Map();
for (const path of [...new Set(megaRecords.map(primaryPathFor).filter(Boolean))].sort()) {
  const { target, bytes, entry } = cachePrimary(path);
  primaryInspections.set(path, {
    cachePath: target.replace(resolve('.') + '\\', '').replaceAll('\\', '/'), bytes: bytes.length,
    sourceGitBlobSha1: entry.blobSha1, sha256: sha(bytes, 'sha256'), ...inspectGlb(bytes),
  });
}

const results = megaRecords.map(record => {
  const primaryPath = primaryPathFor(record);
  const fallbackVariant = fallbackVariantFor(record.identifier);
  const fallback = permitsFallback(record.identifier) ? fallbackByKey.get(`${record.speciesId}:${fallbackVariant}`) : null;
  let fallbackResult = null;
  if (fallback) {
    const cachePath = join(fallbackCache, basename(fallback.sourcePath));
    const bytes = readFileSync(cachePath);
    if (bytes.length !== fallback.bytes || sha(bytes, 'sha256') !== fallback.sha256) throw new Error(`fallback cache mismatch: ${cachePath}`);
    fallbackResult = {
      sourcePath: fallback.sourcePath, cachePath: cachePath.replace(resolve('.') + '\\', '').replaceAll('\\', '/'),
      bytes: bytes.length, sourceGitBlobSha1: fallback.sourceGitBlobSha1, sha256: fallback.sha256, ...inspectGlb(bytes),
    };
  }
  return {
    identifier: record.identifier, speciesId: record.speciesId,
    status: primaryPath ? 'primary' : fallbackResult ? 'fallback' : 'missing',
    primary: primaryPath ? { sourcePath: primaryPath, ...primaryInspections.get(primaryPath) } : null,
    fallback: fallbackResult,
    identityBasis: primaryPath
      ? (primaryPath.includes('/x/') || primaryPath.includes('/y/') || primaryPath.includes('/za/') ? 'explicit-variant-path' : 'canonical-species-in-mega-category')
      : fallbackResult ? 'HOME species and 51/52 variant convention' : null,
  };
});

const available = results.filter(row => row.status !== 'missing');
const primary = results.filter(row => row.status === 'primary');
const fallbackOnly = results.filter(row => row.status === 'fallback');
const missing = results.filter(row => row.status === 'missing');
const allPrimaryValid = primary.every(row => row.primary.hasGeometry && row.primary.hasSelfContainedTextures && row.primary.externalImages === 0);
const allFallbackValid = results.filter(row => row.fallback).every(row => row.fallback.hasGeometry && row.fallback.hasSelfContainedTextures && row.fallback.externalImages === 0);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({
  schema: 1,
  generatedAt: new Date().toISOString(),
  researchOnly: true,
  source: {
    primary: { repository: 'https://github.com/Pokemon-3D-api/assets', commit: PRIMARY_COMMIT, license: 'MIT repository license; README separately attributes model IP to Nintendo/Creatures Inc./GAME FREAK inc.' },
    fallback: { repository: 'https://github.com/Lilothestitch16/Pokemon-HOME-GLB-Models', commit: FALLBACK_COMMIT, rights: 'unverified-do-not-redistribute' },
  },
  scope: {
    combatMegaRecords: megaRecords.length, available: available.length, primary: primary.length, fallbackOnly: fallbackOnly.length,
    missing: missing.length, primaryCachedFiles: primaryInspections.size,
    primaryBytes: [...primaryInspections.values()].reduce((sum, row) => sum + row.bytes, 0),
    fallbackAlternativeRecords: results.filter(row => row.fallback).length,
    allPrimaryGeometryAndTexturesValid: allPrimaryValid, allFallbackGeometryAndTexturesValid: allFallbackValid,
  },
  missingIdentifiers: missing.map(row => row.identifier),
  results,
}, null, 2) + '\n');

console.log(JSON.stringify({ output, records: results.length, available: available.length, primary: primary.length, fallbackOnly: fallbackOnly.length, missing: missing.length, primaryCachedFiles: primaryInspections.size, missingIdentifiers: missing.map(row => row.identifier) }, null, 2));
