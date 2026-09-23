/**
 * Read-only audit of every runtime Pokemon GLB (base species plus Alola/Mega form models).
 *
 *   npx tsx scripts/audit-model-motion-materials.ts [--skip-pixels] [--out artifacts/model-motion-material-audit.json]
 *
 * Motion: parses skins and animation channels from the GLB JSON/BIN chunks and measures whether
 * each clip actually moves (shared rules in src/three/clip-motion.ts), then simulates the walk
 * clip the runtime picked before and after the regional-authored-v5 rig change.
 * Materials: reports metal/gloss, BLEND/MASK/opacity, emissive, unlit and KHR physical extensions,
 * and (unless --skip-pixels) loads every model in headless Chromium (routed local files, no dev
 * server) to sample base-color alpha at the UVs each BLEND material maps, plus vertex-color alpha.
 * That separates genuine cutouts from alpha channels that only carry data. Cutout names are
 * written to src/data/pokemon-cutout-surfaces.ts for the runtime material normalizer.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Matrix4, Quaternion, Vector3 } from 'three';
import manifest from '../src/data/pokemon-models-manifest.json' with { type: 'json' };
import homeManifest from '../src/data/pokemon-home-research-manifest.json' with { type: 'json' };
import alolaManifest from '../src/data/pokemon-alola-models-manifest.json' with { type: 'json' };
import megaManifest from '../src/data/pokemon-mega-models-manifest.json' with { type: 'json' };
import { LEGACY_MODEL_COMMIT, getPokemonModelSource, hasPokemonModel } from '../src/data/pokemon-models';
import { POKEMON_MOTION_KINDS, STATIC_MOTION_CLIP, matchesPokemonMotionKind, selectPokemonMotionClip } from '../src/data/model-motion';
import { OPAQUE_POKEMON_SURFACES, POKEMON_METAL_SURFACES } from '../src/data/pokemon-material-overrides';
import { isMovingClipMotion, missingMotionKinds, summarizeClipMotion, type ClipMotionSummary, type KeyframeSample } from '../src/three/clip-motion';
import { STATIC_NATIVE_CLIP_SPECIES, boneMotionRole } from '../src/three/johto-rig';

type TextureRef = { index: number; texCoord?: number };
type GltfMaterial = {
  name?: string; alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'; alphaCutoff?: number; doubleSided?: boolean;
  pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: TextureRef; metallicFactor?: number; roughnessFactor?: number; metallicRoughnessTexture?: TextureRef };
  emissiveFactor?: number[]; emissiveTexture?: TextureRef; normalTexture?: TextureRef;
  extensions?: Record<string, Record<string, unknown>>;
};
type Accessor = { bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string; min?: number[]; max?: number[];
  sparse?: { count: number; indices: { bufferView: number; byteOffset?: number; componentType: number }; values: { bufferView: number; byteOffset?: number } } };
type Node = { name?: string; children?: number[]; mesh?: number; skin?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] };
type Gltf = {
  extensionsUsed?: string[];
  accessors?: Accessor[];
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: Record<string, unknown> }>;
  nodes?: Node[]; scenes?: Array<{ nodes?: number[] }>; scene?: number;
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number>; material?: number; extensions?: Record<string, unknown> }> }>;
  skins?: Array<{ joints?: number[]; inverseBindMatrices?: number; skeleton?: number }>;
  animations?: Array<{ name?: string; channels?: Array<{ sampler: number; target?: { node?: number; path?: string } }>; samplers?: Array<{ input: number; output: number; interpolation?: string }> }>;
  materials?: GltfMaterial[];
  textures?: Array<{ source?: number; extensions?: Record<string, { source?: number }> }>;
  images?: Array<{ bufferView?: number; mimeType?: string; uri?: string; name?: string }>;
};
type ModelEntry = { key: string; speciesId: number; identifier?: string; source: string; path: string };
type ClipReport = { name: string; channels: number; duration: number; moving: boolean; motion: Omit<ClipMotionSummary, 'tracks'> & { rotationDegrees: number } };
/** Alpha sampled at the UVs a material's triangles use (vertices and centroids). */
type AlphaStats = { samples: number; minAlpha: number; belowHalf: number; nearZero: number; nearOne: number; clearOnOpenEdge: number; surfaceShare: number } | { error: string };

const args = process.argv.slice(2);
const skipPixels = args.includes('--skip-pixels');
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'artifacts/model-motion-material-audit.json';
const cutoutOut = 'src/data/pokemon-cutout-surfaces.ts';

// ---------------------------------------------------------------- model inventory
function inventory(): ModelEntry[] {
  const entries: ModelEntry[] = [];
  const legacyRoot = join('data/local/pokemon-models', LEGACY_MODEL_COMMIT);
  const expandedRoot = join('data/local/pokemon-models-expanded', manifest.source.commit);
  const home = new Map(homeManifest.result.inspections.map(entry => [entry.id, entry.localPath]));
  for (let id = 1; id <= 1025; id++) {
    if (!hasPokemonModel(id)) continue;
    if (id <= 151) { entries.push({ key: String(id), speciesId: id, source: 'legacy-06wj', path: existsSync(`public/models/pokemon/${id}.glb`) ? `public/models/pokemon/${id}.glb` : join(legacyRoot, `${String(id).padStart(3, '0')}.glb`) }); continue; }
    const source = getPokemonModelSource(id)!;
    if (source.sourceClass === 'research-fallback') entries.push({ key: String(id), speciesId: id, source: 'home-fallback', path: home.get(id)! });
    else entries.push({ key: String(id), speciesId: id, source: 'pokemon-3d-api', path: join(expandedRoot, `${id}.glb`) });
  }
  for (const entry of alolaManifest.entries) {
    const commit = alolaManifest.sources.find(source => source.name === entry.source)!.commit;
    entries.push({ key: entry.identifier, speciesId: entry.speciesId, identifier: entry.identifier, source: `alola:${entry.source}`, path: `data/local/alola-models/${commit}/${entry.sourcePath.split('/').at(-1)}` });
  }
  for (const entry of megaManifest.entries) {
    entries.push({ key: entry.identifier, speciesId: entry.speciesId, identifier: entry.identifier, source: 'mega:pokemon-3d-api', path: `data/local/pokemon-models-research/${megaManifest.source.commit}/mega-forms/${entry.sourcePath.replace('models/opt/', '')}` });
  }
  return entries;
}

// ---------------------------------------------------------------- GLB parsing
function parseGlb(bytes: Buffer): { json: Gltf; bin?: Buffer } {
  if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2) throw new Error('invalid GLB header');
  let offset = 12, json: Gltf | undefined, bin: Buffer | undefined;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (type === 0x4e4f534a) json = JSON.parse(bytes.toString('utf8', start, start + length).replace(/[\u0000 ]+$/g, '')) as Gltf;
    else if (type === 0x004e4942) bin = bytes.subarray(start, start + length);
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error('missing JSON chunk');
  return { json, bin };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
function readComponent(view: DataView, offset: number, type: number, normalized: boolean): number {
  switch (type) {
    case 5126: return view.getFloat32(offset, true);
    case 5120: { const v = view.getInt8(offset); return normalized ? Math.max(v / 127, -1) : v; }
    case 5121: { const v = view.getUint8(offset); return normalized ? v / 255 : v; }
    case 5122: { const v = view.getInt16(offset, true); return normalized ? Math.max(v / 32767, -1) : v; }
    case 5123: { const v = view.getUint16(offset, true); return normalized ? v / 65535 : v; }
    case 5125: return view.getUint32(offset, true);
    default: throw new Error(`unsupported componentType ${type}`);
  }
}
function readAccessor(doc: Gltf, bin: Buffer | undefined, index: number): { data: Float32Array; size: number } {
  const accessor = doc.accessors?.[index];
  if (!accessor) throw new Error(`missing accessor ${index}`);
  const size = COMPONENTS[accessor.type], data = new Float32Array(accessor.count * size);
  const bufferView = (viewIndex: number) => {
    const view = doc.bufferViews?.[viewIndex];
    if (!view) throw new Error(`missing bufferView ${viewIndex}`);
    if (view.extensions?.EXT_meshopt_compression) throw new Error('EXT_meshopt_compression animation data is not decoded by this audit');
    if (view.buffer !== 0 || !bin) throw new Error('external buffers are not supported');
    return { view, data: new DataView(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0), view.byteLength) };
  };
  if (accessor.bufferView !== undefined) {
    const { view, data: dv } = bufferView(accessor.bufferView), component = BYTES[accessor.componentType];
    const stride = view.byteStride || component * size, base = accessor.byteOffset ?? 0;
    for (let i = 0; i < accessor.count; i++) for (let c = 0; c < size; c++) {
      data[i * size + c] = readComponent(dv, base + i * stride + c * component, accessor.componentType, !!accessor.normalized);
    }
  }
  if (accessor.sparse) {
    const { data: indices } = bufferView(accessor.sparse.indices.bufferView), { data: values } = bufferView(accessor.sparse.values.bufferView);
    const indexBytes = BYTES[accessor.sparse.indices.componentType], component = BYTES[accessor.componentType];
    for (let i = 0; i < accessor.sparse.count; i++) {
      const target = readComponent(indices, (accessor.sparse.indices.byteOffset ?? 0) + i * indexBytes, accessor.sparse.indices.componentType, false);
      for (let c = 0; c < size; c++) data[target * size + c] = readComponent(values, (accessor.sparse.values.byteOffset ?? 0) + (i * size + c) * component, accessor.componentType, !!accessor.normalized);
    }
  }
  return { data, size };
}

function worldMatrices(doc: Gltf): { world: Matrix4[]; parent: number[] } {
  const nodes = doc.nodes ?? [], world = nodes.map(() => new Matrix4()), parent = nodes.map(() => -1);
  nodes.forEach((node, index) => node.children?.forEach(child => { parent[child] = index; }));
  const local = (node: Node) => node.matrix ? new Matrix4().fromArray(node.matrix)
    : new Matrix4().compose(new Vector3(...(node.translation ?? [0, 0, 0])), new Quaternion(...(node.rotation ?? [0, 0, 0, 1])), new Vector3(...(node.scale ?? [1, 1, 1])));
  const visit = (index: number, parentMatrix: Matrix4) => {
    world[index].multiplyMatrices(parentMatrix, local(nodes[index]));
    nodes[index].children?.forEach(child => visit(child, world[index]));
  };
  nodes.forEach((_, index) => { if (parent[index] === -1) visit(index, new Matrix4()); });
  return { world, parent };
}

/** Bind-pose model height, used to express translation keys in model-relative units. */
function modelHeight(doc: Gltf, bin: Buffer | undefined, world: Matrix4[]): number {
  let min = Infinity, max = -Infinity;
  (doc.nodes ?? []).forEach(node => {
    if (node.mesh === undefined) return;
    let matrix = world[doc.nodes!.indexOf(node)];
    const skin = node.skin === undefined ? undefined : doc.skins?.[node.skin];
    if (skin?.joints?.length && skin.inverseBindMatrices !== undefined) {
      try {
        const inverse = readAccessor(doc, bin, skin.inverseBindMatrices).data;
        matrix = world[skin.joints[0]].clone().multiply(new Matrix4().fromArray(Array.from(inverse.subarray(0, 16))));
      } catch { /* fall back to the node transform */ }
    }
    for (const primitive of doc.meshes?.[node.mesh]?.primitives ?? []) {
      const accessor = doc.accessors?.[primitive.attributes?.POSITION ?? -1];
      if (!accessor?.min || !accessor.max) continue;
      for (const x of [accessor.min[0], accessor.max[0]]) for (const y of [accessor.min[1], accessor.max[1]]) for (const z of [accessor.min[2], accessor.max[2]]) {
        const point = new Vector3(x, y, z).applyMatrix4(matrix);
        min = Math.min(min, point.y); max = Math.max(max, point.y);
      }
    }
  });
  return Number.isFinite(max - min) && max > min ? max - min : 1;
}

const PATH_PROPERTY: Record<string, string> = { rotation: 'quaternion', translation: 'position', scale: 'scale', weights: 'morphTargetInfluences' };
function clipReports(doc: Gltf, bin: Buffer | undefined): ClipReport[] {
  const { world, parent } = worldMatrices(doc), height = modelHeight(doc, bin, world);
  const scaleOf = (node: number) => { const p = parent[node]; return p < 0 ? 1 : new Vector3().setFromMatrixScale(world[p]).toArray().reduce((a, b) => Math.max(a, Math.abs(b)), 0); };
  return (doc.animations ?? []).map((animation, index) => {
    const tracks: KeyframeSample[] = [];
    let duration = 0;
    for (const channel of animation.channels ?? []) {
      const sampler = animation.samplers?.[channel.sampler], property = PATH_PROPERTY[channel.target?.path ?? ''];
      if (!sampler || !property || channel.target?.node === undefined) continue;
      const times = readAccessor(doc, bin, sampler.input).data, output = readAccessor(doc, bin, sampler.output);
      let values = output.data;
      if (sampler.interpolation === 'CUBICSPLINE') {
        const stride = values.length / times.length / 3, keyed = new Float32Array(times.length * stride);
        for (let k = 0; k < times.length; k++) keyed.set(values.subarray((k * 3 + 1) * stride, (k * 3 + 2) * stride), k * stride);
        values = keyed;
      }
      duration = Math.max(duration, times[times.length - 1] ?? 0);
      tracks.push({ name: `${channel.target.node}.${property}`, times, values });
    }
    const motion = summarizeClipMotion(tracks, name => scaleOf(Number(name.split('.')[0])) / height);
    const { tracks: _tracks, ...rest } = motion;
    return { name: animation.name || `animation_${index}`, channels: animation.channels?.length ?? 0, duration: +duration.toFixed(3),
      moving: isMovingClipMotion(motion), motion: { ...rest, rotationDegrees: +(motion.rotation * 180 / Math.PI).toFixed(2), rotation: +motion.rotation.toFixed(4), translation: +motion.translation.toFixed(4), scale: +motion.scale.toFixed(4), weights: +motion.weights.toFixed(4) } };
  });
}

// ---------------------------------------------------------------- runtime simulation
type WalkState = 'native-walk-moving' | 'native-walk-frozen' | 'fallback-moving-not-walk' | 'fallback-frozen' | 'authored-walk' | 'no-clips';
const AUTHORED_KINDS = POKEMON_MOTION_KINDS.map(kind => ({ name: `CM_${kind}`, moving: true, authored: true }));
function walkState(clips: Array<{ name: string; moving: boolean; authored?: boolean; userData?: Record<string, unknown> }>, legacySelection: boolean): WalkState {
  const selection = legacySelection
    ? (() => { const matched = clips.find(clip => matchesPokemonMotionKind(clip.name, 'walk')); return { clip: matched ?? clips.find(clip => matchesPokemonMotionKind(clip.name, 'idle')) ?? clips[0], matched: !!matched }; })()
    : selectPokemonMotionClip(clips, 'walk');
  if (!selection.clip) return 'no-clips';
  if (selection.clip.authored) return 'authored-walk';
  if (selection.matched) return selection.clip.moving ? 'native-walk-moving' : 'native-walk-frozen';
  return selection.clip.moving ? 'fallback-moving-not-walk' : 'fallback-frozen';
}
function runtimeMotion(id: number, skinned: boolean, native: ClipReport[]) {
  // regional-authored-v4: a skinned model with any clip kept only its source clips. Every other
  // model was re-skinned onto an authored skeleton, which detaches the source clips from the
  // rendered meshes, yet those clips still won the name-based selection.
  const reskinned = !skinned || id === 222 || STATIC_NATIVE_CLIP_SPECIES.has(id);
  const beforeAuthored = !(native.length && skinned && !STATIC_NATIVE_CLIP_SPECIES.has(id));
  const beforeNative = native.map(clip => ({ ...clip, moving: clip.moving && !(beforeAuthored && reskinned) }));
  const before = walkState([...beforeNative, ...(beforeAuthored ? AUTHORED_KINDS : [])], true);
  // regional-authored-v5 (prepareRegionalRig): frozen clips are flagged; authored clips cover missing kinds.
  const nativeMotion = native.some(clip => clip.moving);
  let kinds = nativeMotion ? missingMotionKinds(native) : [...POKEMON_MOTION_KINDS], path: string, freezeAll = false;
  if (!skinned && nativeMotion && !kinds.includes('walk')) { kinds = []; path = 'native-transform-motion'; }
  else if (!reskinned && nativeMotion && !kinds.length) path = 'native-skinned-motion';
  else if (reskinned) { kinds = [...POKEMON_MOTION_KINDS]; freezeAll = true; path = native.length ? 'replaced-source-skeleton' : 'authored-skeleton'; }
  else path = native.length ? 'source-skeleton-plus-authored' : 'source-skeleton-authored';
  const flagged = native.map(clip => ({ ...clip, userData: clip.moving && !freezeAll ? {} : { [STATIC_MOTION_CLIP]: true } }));
  const after = walkState([...flagged, ...AUTHORED_KINDS.filter(clip => kinds.includes(clip.name.slice(3) as never))], false);
  return { beforeAuthoredClips: beforeAuthored, before, afterPath: path, afterAuthoredKinds: kinds, after };
}

/** Leg joints the authored walk swings, with the v4 name rules and the v5 leg-chain rules. */
function legCoverage(doc: Gltf) {
  const joints = new Set((doc.skins ?? []).flatMap(skin => skin.joints ?? [])), parent = new Map<number, number>();
  (doc.nodes ?? []).forEach((node, index) => node.children?.forEach(child => parent.set(child, index)));
  let before = 0, after = 0;
  for (const joint of joints) {
    const ancestors: string[] = [];
    for (let p = parent.get(joint); p !== undefined && joints.has(p); p = parent.get(p)) ancestors.push(doc.nodes?.[p]?.name ?? '');
    const name = doc.nodes?.[joint]?.name ?? '', lower = name.toLowerCase();
    if (!/wing|tail/.test(lower) && /thigh|upleg/.test(lower)) before++;
    if (boneMotionRole(name, ancestors) === 'leg') after++;
  }
  return { before, after };
}

// ---------------------------------------------------------------- materials
const METALLIC_SURFACE = /metal|steel|armor|armour|blade|sword|bell|chrome|gold|silver|iron/i;
const GLOSSY_SURFACE = /eye|pupil|cornea|glass|gem|crystal|jewel|water|wet/i;
const OBVIOUS_NON_METAL = /eye|pupil|cornea|mouth|tongue|tooth|fire|flame|leaf|flower|fur|skin/i;
const PHYSICAL = ['KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_specular', 'KHR_materials_clearcoat', 'KHR_materials_sheen', 'KHR_materials_iridescence', 'KHR_materials_ior', 'KHR_materials_anisotropy', 'KHR_materials_dispersion'];
function imageIndexOf(doc: Gltf, texture?: TextureRef): number | undefined {
  const source = doc.textures?.[texture?.index ?? -1];
  return source ? Object.values(source.extensions ?? {}).find(value => value?.source !== undefined)?.source ?? source.source : undefined;
}
function materialReports(entry: ModelEntry, doc: Gltf, bin: Buffer | undefined) {
  const vertexAlpha = new Set<number>();
  for (const mesh of doc.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
    const color = doc.accessors?.[primitive.attributes?.COLOR_0 ?? -1];
    if (color?.type !== 'VEC4' || primitive.material === undefined || primitive.extensions?.KHR_draco_mesh_compression) continue;
    try { const { data } = readAccessor(doc, bin, primitive.attributes!.COLOR_0); for (let i = 3; i < data.length; i += 4) if (data[i] < .999) { vertexAlpha.add(primitive.material); break; } } catch { vertexAlpha.add(primitive.material); }
  }
  const opaqueAudited = entry.identifier ? [] : OPAQUE_POKEMON_SURFACES[entry.speciesId] ?? [];
  const metalAudited = entry.identifier ? [] : POKEMON_METAL_SURFACES[entry.speciesId] ?? [];
  return (doc.materials ?? []).map((material, index) => {
    const name = material.name ?? '', pbr = material.pbrMetallicRoughness ?? {}, extensions = Object.keys(material.extensions ?? {});
    const metallic = pbr.metallicFactor ?? 1, roughness = pbr.roughnessFactor ?? 1, opacity = pbr.baseColorFactor?.[3] ?? 1, alphaMode = material.alphaMode ?? 'OPAQUE';
    const strength = Number(material.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1);
    const emissive = Math.max(0, ...(material.emissiveFactor ?? [0, 0, 0])) * strength;
    const unlit = extensions.includes('KHR_materials_unlit'), physical = extensions.filter(extension => PHYSICAL.includes(extension));
    const hasMap = !!pbr.baseColorTexture, mrMap = !!pbr.metallicRoughnessTexture;
    const baseLuma = pbr.baseColorFactor ? .2126 * pbr.baseColorFactor[0] + .7152 * pbr.baseColorFactor[1] + .0722 * pbr.baseColorFactor[2] : 1;
    // Pre-change runtime rules (normalizePokemonMaterials before this audit).
    const namedMetal = METALLIC_SURFACE.test(name) || metalAudited.includes(name);
    const preserveMetal = !unlit && ((namedMetal && !OBVIOUS_NON_METAL.test(name)) || (metallic > .15 && metallic < .999) || mrMap);
    const metalBefore = !unlit && metallic > .15 && preserveMetal;
    const glossyBefore = !unlit && roughness < .45 && (preserveMetal || mrMap || GLOSSY_SURFACE.test(name));
    const blendFixedBefore = opacity >= .999 && !vertexAlpha.has(index) && (!hasMap || (opaqueAudited.includes(name) && !vertexAlpha.has(index)));
    const transparentBefore = alphaMode === 'BLEND' && !blendFixedBefore;
    return {
      index, name, alphaMode, alphaCutoff: material.alphaCutoff, opacity, metallic, roughness, emissive: +emissive.toFixed(4), emissiveTexture: !!material.emissiveTexture,
      emissiveOnlyColor: emissive > .01 && !hasMap && baseLuma < .05, unlit, physical, extensions, baseColorTexture: hasMap, metallicRoughnessTexture: mrMap,
      imageIndex: imageIndexOf(doc, pbr.baseColorTexture), vertexAlpha: vertexAlpha.has(index), auditedOpaque: opaqueAudited.includes(name),
      runtimeBefore: { metal: metalBefore, glossy: glossyBefore, transparent: transparentBefore, emissive: emissive > .01, physical: physical.length > 0 },
      source: { metallic: metallic > .15, glossy: roughness < .45, blend: alphaMode === 'BLEND', mask: alphaMode === 'MASK', translucentFactor: opacity < .999 },
    };
  });
}

/**
 * Loads each model with the real GLTFLoader/DRACOLoader in headless Chromium (files routed from
 * node_modules/three and public/draco; no dev server) and samples base-color alpha at the UVs of
 * every vertex and triangle centroid that uses a BLEND/MASK material. Whole-image statistics would
 * count empty atlas padding that no triangle maps.
 */
async function sampleUsedAlpha(jobs: Array<{ key: string; path: string; materials: string[] }>): Promise<Map<string, AlphaStats>> {
  const results = new Map<string, AlphaStats>();
  if (!jobs.length) return results;
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const types: Record<string, string> = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
  try {
    const page = await browser.newPage();
    // tsx keeps function names through an injected __name helper that the page lacks.
    await page.addInitScript({ content: 'window.__name = (target) => target;' });
    await page.route('http://audit.local/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/index.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>' });
      const file = path.startsWith('/three/') ? join('node_modules', decodeURIComponent(path)) : path.startsWith('/draco/') ? join('public', path) : path.startsWith('/model/') ? jobs[Number(path.slice(7))]?.path : undefined;
      if (!file || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
      await route.fulfill({ body: readFileSync(file), contentType: types[file.slice(file.lastIndexOf('.'))] ?? 'model/gltf-binary' });
    });
    await page.goto('http://audit.local/index.html');
    for (let start = 0; start < jobs.length; start += 8) {
      const batch = jobs.slice(start, start + 8).map((job, offset) => ({ url: `/model/${start + offset}`, key: job.key, materials: job.materials }));
      const stats = await page.evaluate(async models => {
        const three = 'three', gltfPath = 'three/addons/loaders/GLTFLoader.js', dracoPath = 'three/addons/loaders/DRACOLoader.js';
        const { Mesh, Vector2 } = await import(three);
        const { GLTFLoader } = await import(gltfPath), { DRACOLoader } = await import(dracoPath);
        const w = window as unknown as { __auditLoader?: InstanceType<typeof GLTFLoader> };
        w.__auditLoader ??= new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath('/draco/'));
        const output: Array<[string, unknown]> = [];
        for (const model of models) {
          try {
            const gltf = await w.__auditLoader.loadAsync(model.url);
            const pixels = new Map<unknown, { data: Uint8ClampedArray; width: number; height: number }>();
            const read = (image: CanvasImageSource & { width: number; height: number }) => {
              const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d', { willReadFrequently: true })!;
              context.drawImage(image, 0, 0);
              return { data: context.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
            };
            const totals = new Map<string, { samples: number; belowHalf: number; nearZero: number; nearOne: number; min: number; clearVertices: number; clearOnOpenEdge: number }>();
            let modelTriangles = 0;
            const vertexColors = new Map<string, { vertices: number; belowHalf: number; nearZero: number }>();
            gltf.scene.traverse((object: InstanceType<typeof Mesh>) => {
              if (!(object as { isMesh?: boolean }).isMesh) return;
              modelTriangles += (object.geometry.index ? object.geometry.index.count : object.geometry.getAttribute('position').count) / 3;
              const list = Array.isArray(object.material) ? object.material : [object.material];
              const geometry = object.geometry, index = geometry.index, position = geometry.getAttribute('position');
              const vertexCount = index ? index.count : position.count, corner = (i: number) => index ? index.getX(i) : i;
              // Weld by position (UV seams split vertices) and find open edges: overlay cards and
              // effect planes put their clear texels on open edges; alpha masks sit inside islands.
              const welded = new Int32Array(position.count), keys = new Map<string, number>();
              for (let v = 0; v < position.count; v++) {
                const key = `${Math.round(position.getX(v) * 1e5)},${Math.round(position.getY(v) * 1e5)},${Math.round(position.getZ(v) * 1e5)}`;
                welded[v] = keys.get(key) ?? keys.size; if (!keys.has(key)) keys.set(key, welded[v]);
              }
              const edges = new Map<string, number>(), edge = (a: number, b: number) => a < b ? `${a}_${b}` : `${b}_${a}`;
              for (let i = 0; i + 2 < vertexCount; i += 3) {
                const [a, b, c] = [welded[corner(i)], welded[corner(i + 1)], welded[corner(i + 2)]];
                for (const key of [edge(a, b), edge(b, c), edge(c, a)]) edges.set(key, (edges.get(key) ?? 0) + 1);
              }
              const open = new Uint8Array(keys.size);
              for (const [key, uses] of edges) if (uses === 1) for (const value of key.split('_')) open[Number(value)] = 1;
              const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
              const color = geometry.getAttribute('color');
              if (color?.itemSize === 4) for (const group of groups) {
                const material = list[group.materialIndex ?? 0];
                if (!material) continue;
                const stats = vertexColors.get(material.name) ?? { vertices: 0, belowHalf: 0, nearZero: 0 };
                for (let i = group.start; i < Math.min(vertexCount, group.start + group.count); i++) {
                  const alpha = color.getW(corner(i)); stats.vertices++;
                  if (alpha < .5) stats.belowHalf++; if (alpha < .1) stats.nearZero++;
                }
                vertexColors.set(material.name, stats);
              }
              for (const group of groups) {
                const material = list[group.materialIndex ?? 0];
                if (!material || !model.materials.includes(material.name) || !material.map?.image) continue;
                const map = material.map, uv = geometry.getAttribute(map.channel ? `uv${map.channel}` : 'uv');
                if (!uv) continue;
                if (!pixels.has(map.image)) pixels.set(map.image, read(map.image));
                const texel = pixels.get(map.image)!; map.updateMatrix();
                const total = totals.get(material.name) ?? { samples: 0, belowHalf: 0, nearZero: 0, nearOne: 0, min: 255, clearVertices: 0, clearOnOpenEdge: 0 };
                const point = new Vector2();
                const sample = (u: number, v: number) => {
                  point.set(u, v).applyMatrix3(map.matrix);
                  const x = Math.min(texel.width - 1, Math.floor((point.x - Math.floor(point.x)) * texel.width));
                  const y = Math.min(texel.height - 1, Math.floor((point.y - Math.floor(point.y)) * texel.height));
                  const alpha = texel.data[(y * texel.width + x) * 4 + 3];
                  total.samples++; total.min = Math.min(total.min, alpha);
                  if (alpha < 128) total.belowHalf++; if (alpha < 26) total.nearZero++; if (alpha > 229) total.nearOne++;
                  return alpha;
                };
                const end = Math.min(vertexCount, group.start + group.count);
                for (let i = group.start; i + 2 < end; i += 3) {
                  const a = corner(i), b = corner(i + 1), c = corner(i + 2);
                  for (const vertex of [a, b, c]) if (sample(uv.getX(vertex), uv.getY(vertex)) < 26) { total.clearVertices++; total.clearOnOpenEdge += open[welded[vertex]]; }
                  sample((uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3, (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3);
                }
                totals.set(material.name, total);
              }
            });
            for (const [name, total] of totals) output.push([`${model.key}#${name}`, {
              samples: total.samples, minAlpha: total.min,
              belowHalf: +(total.belowHalf / Math.max(1, total.samples)).toFixed(4),
              nearZero: +(total.nearZero / Math.max(1, total.samples)).toFixed(4),
              nearOne: +(total.nearOne / Math.max(1, total.samples)).toFixed(4),
              clearOnOpenEdge: +(total.clearOnOpenEdge / Math.max(1, total.clearVertices)).toFixed(4),
              surfaceShare: +(total.samples / 4 / Math.max(1, modelTriangles)).toFixed(4),
            }]);
            for (const [name, stats] of vertexColors) output.push([`${model.key}#vc#${name}`, {
              vertices: stats.vertices, belowHalf: +(stats.belowHalf / Math.max(1, stats.vertices)).toFixed(4), nearZero: +(stats.nearZero / Math.max(1, stats.vertices)).toFixed(4),
            }]);
          } catch (error) { output.push([`${model.key}#*`, { error: String(error) }]); }
        }
        return output;
      }, batch);
      for (const [key, value] of stats) results.set(key, value as AlphaStats);
    }
  } finally { await browser.close(); }
  return results;
}

/**
 * Runtime alpha policy. Genuine cutouts keep alphaTest; alpha that only carries data (Corviknight's
 * 31-64/255 body, Sun/Moon body masks) would erase the surface under alphaTest, so those surfaces,
 * the pixel-audited opaque list and every other BLEND surface render opaque.
 */
function alphaPolicy(material: ReturnType<typeof materialReports>[number], stats?: AlphaStats): 'opaque' | 'cutout' | 'mask' {
  if (material.alphaMode === 'MASK') return 'mask';
  if (material.alphaMode !== 'BLEND' || !material.baseColorTexture || material.auditedOpaque || !stats || 'error' in stats) return 'opaque';
  if (stats.belowHalf < .01) return 'opaque';
  // Flames, smoke and battle effects: keep their silhouette instead of a solid sheet.
  if (EFFECT_SURFACE.test(material.name)) return 'cutout';
  // Half-transparent wings/gel without clear texels render solid.
  if (stats.nearZero < .005) return 'opaque';
  // An alpha mask painted over most of the body (Sun/Moon bodies) is data, not a silhouette.
  if (stats.surfaceShare >= .2) return 'opaque';
  // Mostly half-transparent anatomy (Kyurem's ice) would vanish under alphaTest.
  if (stats.belowHalf - stats.nearZero >= .45) return 'opaque';
  // Eyes, irises, fangs, fins and decals: overlay cards with clear margins.
  return 'cutout';
}
const EFFECT_SURFACE = /fire|flame|smoke|gas|eff|aura|glow|spark/i;

// ---------------------------------------------------------------- main
const models = inventory();
const parsed = models.map(entry => {
  const bytes = readFileSync(entry.path), { json, bin } = parseGlb(bytes);
  return { entry, bytes, json, bin };
});
const pixelJobs = skipPixels ? [] : parsed.map(({ entry, json }) => ({ key: entry.key, path: entry.path,
  materials: (json.materials ?? []).filter(material => (material.alphaMode === 'BLEND' || material.alphaMode === 'MASK') && material.pbrMetallicRoughness?.baseColorTexture).map(material => material.name ?? '') }));
const alpha = await sampleUsedAlpha(pixelJobs);

const reports = parsed.map(({ entry, bytes, json, bin }) => {
  const skins = json.skins ?? [], skinned = (json.nodes ?? []).some(node => node.skin !== undefined && node.mesh !== undefined);
  let clips: ClipReport[] = [], clipError: string | undefined;
  try { clips = clipReports(json, bin); } catch (error) { clipError = String(error); }
  const motion = runtimeMotion(entry.speciesId, skinned, clips);
  const materials = materialReports(entry, json, bin).map(material => {
    const stats = alpha.get(`${entry.key}#${material.name}`) ?? alpha.get(`${entry.key}#*`);
    const vertexColorAlpha = alpha.get(`${entry.key}#vc#${material.name}`) as { vertices: number; belowHalf: number; nearZero: number } | undefined;
    const vertexAlpha = material.vertexAlpha || (vertexColorAlpha?.belowHalf ?? 0) > 0 || (vertexColorAlpha?.nearZero ?? 0) > 0;
    const runtimeBefore = { ...material.runtimeBefore, transparent: material.runtimeBefore.transparent || (material.alphaMode === 'BLEND' && vertexAlpha) };
    return { ...material, vertexAlpha, vertexColorAlpha, runtimeBefore, textureAlpha: stats, runtimeAlpha: alphaPolicy(material, stats) };
  });
  return {
    key: entry.key, speciesId: entry.speciesId, identifier: entry.identifier, source: entry.source, path: entry.path.replaceAll('\\', '/'),
    sha256: createHash('sha256').update(bytes).digest('hex'), extensionsUsed: json.extensionsUsed ?? [],
    skins: skins.length, joints: new Set(skins.flatMap(skin => skin.joints ?? [])).size, skinned, clipError,
    clips, movingClips: clips.filter(clip => clip.moving).length, motion, legJoints: legCoverage(json), materials,
  };
});

const flagged = <T>(predicate: (report: typeof reports[number]) => T) => reports.filter(report => predicate(report)).map(report => report.key);
const anyMaterial = (report: typeof reports[number], predicate: (material: typeof reports[number]['materials'][number]) => boolean) => report.materials.some(predicate);
const walkCounts = (key: 'before' | 'after') => reports.reduce<Record<string, number>>((counts, report) => ({ ...counts, [report.motion[key]]: (counts[report.motion[key]] ?? 0) + 1 }), {});
const noWalk = (state: WalkState) => state !== 'native-walk-moving' && state !== 'authored-walk';
const summary = {
  models: reports.length,
  base: reports.filter(report => !report.identifier).length,
  forms: reports.filter(report => report.identifier).length,
  motion: {
    skinned: reports.filter(report => report.skinned).length,
    withClips: reports.filter(report => report.clips.length).length,
    withFrozenClipsOnly: flagged(report => report.clips.length && !report.movingClips).length,
    clipParseErrors: flagged(report => report.clipError).length,
    walkBefore: walkCounts('before'),
    walkAfter: walkCounts('after'),
    lackingMovingWalkBefore: flagged(report => noWalk(report.motion.before)).length,
    lackingMovingWalkAfter: flagged(report => noWalk(report.motion.after)).length,
    afterPaths: reports.reduce<Record<string, number>>((counts, report) => ({ ...counts, [report.motion.afterPath]: (counts[report.motion.afterPath] ?? 0) + 1 }), {}),
    authoredWalkOnSourceSkeleton: {
      models: flagged(report => report.motion.afterPath.startsWith('source-skeleton') && report.motion.afterAuthoredKinds.includes('walk')).length,
      withLegJointsV4: flagged(report => report.motion.afterPath.startsWith('source-skeleton') && report.motion.afterAuthoredKinds.includes('walk') && report.legJoints.before > 0).length,
      withLegJointsV5: flagged(report => report.motion.afterPath.startsWith('source-skeleton') && report.motion.afterAuthoredKinds.includes('walk') && report.legJoints.after > 0).length,
    },
  },
  materials: {
    total: reports.reduce((sum, report) => sum + report.materials.length, 0),
    source: {
      metallic: flagged(report => anyMaterial(report, material => material.source.metallic)).length,
      glossy: flagged(report => anyMaterial(report, material => material.source.glossy)).length,
      blend: flagged(report => anyMaterial(report, material => material.source.blend)).length,
      mask: flagged(report => anyMaterial(report, material => material.source.mask)).length,
      translucentFactor: flagged(report => anyMaterial(report, material => material.source.translucentFactor)).length,
      emissive: flagged(report => anyMaterial(report, material => material.emissive > .01)).length,
      emissiveOnlyColor: flagged(report => anyMaterial(report, material => material.emissiveOnlyColor)).length,
      physicalExtensions: flagged(report => anyMaterial(report, material => material.physical.length > 0)).length,
      unlit: flagged(report => anyMaterial(report, material => material.unlit)).length,
      vertexAlpha: flagged(report => anyMaterial(report, material => material.vertexAlpha)).length,
    },
    runtimeBefore: {
      metal: flagged(report => anyMaterial(report, material => material.runtimeBefore.metal)).length,
      glossy: flagged(report => anyMaterial(report, material => material.runtimeBefore.glossy)).length,
      transparent: flagged(report => anyMaterial(report, material => material.runtimeBefore.transparent)).length,
      emissive: flagged(report => anyMaterial(report, material => material.runtimeBefore.emissive)).length,
      physical: flagged(report => anyMaterial(report, material => material.runtimeBefore.physical)).length,
      anyOdd: flagged(report => anyMaterial(report, material => Object.values(material.runtimeBefore).some(Boolean))).length,
    },
    runtimeAfter: {
      cutoutMaterials: reports.reduce((sum, report) => sum + report.materials.filter(material => material.runtimeAlpha === 'cutout').length, 0),
      maskMaterials: reports.reduce((sum, report) => sum + report.materials.filter(material => material.runtimeAlpha === 'mask').length, 0),
      pixelDecodeErrors: [...alpha.values()].filter(stats => 'error' in stats).length,
    },
  },
};
const problems = {
  walkBefore: Object.fromEntries(['native-walk-frozen', 'fallback-moving-not-walk', 'fallback-frozen', 'no-clips'].map(state => [state, flagged(report => report.motion.before === state)])),
  walkAfter: Object.fromEntries(['native-walk-frozen', 'fallback-moving-not-walk', 'fallback-frozen', 'no-clips'].map(state => [state, flagged(report => report.motion.after === state)])),
  frozenClipsOnly: flagged(report => report.clips.length && !report.movingClips),
  authoredWalkWithoutLegJoints: flagged(report => report.motion.afterPath.startsWith('source-skeleton') && report.motion.afterAuthoredKinds.includes('walk') && !report.legJoints.after),
  runtimeBefore: {
    metal: flagged(report => anyMaterial(report, material => material.runtimeBefore.metal)),
    glossy: flagged(report => anyMaterial(report, material => material.runtimeBefore.glossy)),
    transparent: flagged(report => anyMaterial(report, material => material.runtimeBefore.transparent)),
    emissive: flagged(report => anyMaterial(report, material => material.runtimeBefore.emissive)),
    physical: flagged(report => anyMaterial(report, material => material.runtimeBefore.physical)),
    unlit: flagged(report => anyMaterial(report, material => material.unlit)),
  },
  clipParseErrors: reports.filter(report => report.clipError).map(report => ({ key: report.key, error: report.clipError })),
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), method: 'Read-only GLB JSON/BIN inspection; base-color alpha sampled at mapped UVs and vertex-color alpha read in headless Chromium with the three.js GLTFLoader/DRACOLoader. Source bytes unchanged.', pixelsDecoded: !skipPixels, summary, problems, models: reports }, null, 2) + '\n');

if (!skipPixels) {
  const cutouts: Record<string, string[]> = {};
  for (const report of reports) {
    const names = [...new Set(report.materials.filter(material => material.runtimeAlpha === 'cutout').map(material => material.name))].sort();
    if (names.length) cutouts[report.key] = names;
  }
  const body = Object.entries(cutouts).map(([key, names]) => `  ${JSON.stringify(key)}: ${JSON.stringify(names)},`).join('\n');
  writeFileSync(cutoutOut, `// Generated by scripts/audit-model-motion-materials.ts from decoded texture alpha. Do not edit by hand.\n`
    + `/** BLEND surfaces whose mapped base-color alpha is a genuine cutout (eye/iris overlays, fangs, fins, flames).\n`
    + ` * Keyed by species id or form identifier. They render opaque with alphaTest; other BLEND surfaces render opaque. */\n`
    + `export const POKEMON_CUTOUT_SURFACES: Readonly<Record<string, readonly string[]>> = {\n${body}\n};\n`);
}
console.log(JSON.stringify({ outPath, summary }, null, 2));
