import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import manifest from '../src/data/pokemon-models-manifest.json' with { type: 'json' };
import homeManifest from '../src/data/pokemon-home-research-manifest.json' with { type: 'json' };
import { LEGACY_MODEL_COMMIT } from '../src/data/pokemon-models';

type Material = {
  name?: string;
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  pbrMetallicRoughness?: { metallicFactor?: number; roughnessFactor?: number; baseColorTexture?: unknown; metallicRoughnessTexture?: unknown };
  normalTexture?: unknown;
  occlusionTexture?: unknown;
  emissiveTexture?: unknown;
};
type Document = {
  accessors?: Array<{ count?: number }>;
  animations?: unknown[];
  images?: unknown[];
  materials?: Material[];
  meshes?: Array<{ primitives?: Array<{ attributes?: { POSITION?: number }; material?: number }> }>;
  skins?: unknown[];
  textures?: unknown[];
};

function documentOf(path: string): Document {
  const bytes = readFileSync(path);
  if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error(`${path}: invalid GLB`);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4), start = offset + 8, end = start + length;
    if (end > bytes.length) throw new Error(`${path}: invalid chunk`);
    if (type === 0x4e4f534a) return JSON.parse(bytes.toString('utf8', start, end).replace(/[\u0000\u0020]+$/g, '')) as Document;
    offset = end;
  }
  throw new Error(`${path}: missing JSON chunk`);
}

const expanded = new Map(manifest.catalog.expandedEntries.map(entry => [entry.id, entry]));
const home = new Map(homeManifest.result.inspections.map(entry => [entry.id, entry]));
const entries = Array.from({ length: 1025 }, (_, index) => {
  const id = index + 1;
  const sourceClass = id <= 151 ? 'legacy-06wj' : expanded.has(id) ? 'pokemon-3d-api' : 'home-research-fallback';
  const path = id <= 151
    ? join('data/local/pokemon-models', LEGACY_MODEL_COMMIT, `${String(id).padStart(3, '0')}.glb`)
    : expanded.has(id)
      ? join('data/local/pokemon-models-expanded', manifest.source.commit, `${id}.glb`)
      : home.get(id)?.localPath;
  if (!path) throw new Error(`${id}: no local source`);
  const document = documentOf(path), materials = document.materials ?? [], primitives = (document.meshes ?? []).flatMap(mesh => mesh.primitives ?? []);
  const textureReferences = materials.reduce((sum, material) => sum + [material.pbrMetallicRoughness?.baseColorTexture,
    material.pbrMetallicRoughness?.metallicRoughnessTexture, material.normalTexture, material.occlusionTexture, material.emissiveTexture].filter(Boolean).length, 0);
  const metallicMaterials = materials.filter(material => (material.pbrMetallicRoughness?.metallicFactor ?? 1) > .15);
  const blendedMaterials = materials.filter(material => material.alphaMode === 'BLEND');
  return {
    id, sourceClass, path: path.replaceAll('\\', '/'), meshes: document.meshes?.length ?? 0, primitives: primitives.length,
    vertices: primitives.reduce((sum, primitive) => sum + (document.accessors?.[primitive.attributes?.POSITION ?? -1]?.count ?? 0), 0),
    skins: document.skins?.length ?? 0, animations: document.animations?.length ?? 0,
    materials: materials.length, textures: document.textures?.length ?? 0, images: document.images?.length ?? 0, textureReferences,
    metallicMaterials: metallicMaterials.length, blendedMaterials: blendedMaterials.length,
    blendedWithoutTexture: blendedMaterials.filter(material => !material.pbrMetallicRoughness?.baseColorTexture).length,
    authoredRigRequired: !(document.skins?.length) || !(document.animations?.length),
    sourceTextureMissing: textureReferences === 0,
  };
});

const count = (predicate: (entry: typeof entries[number]) => boolean) => entries.filter(predicate).length;
const sum = (field: keyof typeof entries[number]) => entries.reduce((total, entry) => total + (typeof entry[field] === 'number' ? entry[field] as number : 0), 0);
const receipt = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  method: 'Read-only inspection of every pinned local GLB JSON chunk. Source bytes are not modified. Counts describe source data; runtime-authored v4 rig/deformation evidence remains in the dedicated verification receipts.',
  scope: { models: entries.length, primary: count(entry => entry.sourceClass !== 'home-research-fallback'), homeResearchFallback: count(entry => entry.sourceClass === 'home-research-fallback') },
  totals: {
    meshes: sum('meshes'), primitives: sum('primitives'), vertices: sum('vertices'), materials: sum('materials'), textures: sum('textures'), images: sum('images'),
    rawSkinsMissing: count(entry => entry.skins === 0), rawAnimationsMissing: count(entry => entry.animations === 0), authoredRigRequired: count(entry => entry.authoredRigRequired),
    sourceTexturesMissing: count(entry => entry.sourceTextureMissing), modelsWithMetallicMaterials: count(entry => entry.metallicMaterials > 0),
    modelsWithBlendedMaterials: count(entry => entry.blendedMaterials > 0), modelsWithBlendWithoutTexture: count(entry => entry.blendedWithoutTexture > 0),
  },
  affectedIds: {
    sourceTexturesMissing: entries.filter(entry => entry.sourceTextureMissing).map(entry => entry.id),
    metallicMaterials: entries.filter(entry => entry.metallicMaterials > 0).map(entry => entry.id),
    blendWithoutTexture: entries.filter(entry => entry.blendedWithoutTexture > 0).map(entry => entry.id),
    authoredRigRequired: entries.filter(entry => entry.authoredRigRequired).map(entry => entry.id),
  },
  qualityPolicy: {
    geometrySimplification: 'disabled-no-quality-loss',
    immutableSources: true,
    runtimeMaterialNormalization: 'clone-per-instance; preserve maps; remove unsupported chrome response; move no-alpha opaque blends to depth-writing opaque pass',
    runtimeRigging: 'regional-authored-v4 for source models without usable skinned motion',
  },
  entries,
};
const destination = process.argv[2] ?? 'artifacts/research/model-quality/full-model-quality-audit.json';
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ scope: receipt.scope, totals: receipt.totals, destination }, null, 2));
