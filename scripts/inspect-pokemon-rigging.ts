import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_MODEL_COMMIT } from '../src/data/pokemon-models';

type Gltf = {
  nodes?: Array<{ skin?: number; mesh?: number }>;
  meshes?: Array<{ primitives?: Array<{ targets?: unknown[] }> }>;
  skins?: Array<{ joints?: number[] }>;
  accessors?: Array<{ max?: number[] }>;
  animations?: Array<{ name?: string; samplers?: Array<{ input?: number }>; channels?: Array<{ target?: { path?: string } }> }>;
};
type Entry = {
  id: number; source: 'legacy-06wj' | 'pokemon-3d-api'; path: string; bytes: number; sha256: string;
  nodes: number; skins: number; joints: number; skinnedNodes: number; morphTargetPrimitives: number;
  animationClips: number; animationChannels: number; clipNames: string[]; durationSeconds: number;
  paths: Record<string, number>; support: 'rigged-animated' | 'rigged-static' | 'transform-animated' | 'static';
};

const manifest = JSON.parse(readFileSync('src/data/pokemon-models-manifest.json', 'utf8')) as {
  source: { repository: string; commit: string };
  catalog: { expandedEntries: Array<{ id: number; sourcePath: string }> };
};
const legacySource = { repository: 'https://github.com/06wj/pokemon', commit: LEGACY_MODEL_COMMIT };

function gltfJson(path: string): { json: Gltf; bytes: Buffer } {
  const bytes = readFileSync(path);
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error(`Invalid GLB: ${path}`);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4), start = offset + 8, end = start + length;
    if (end > bytes.length) throw new Error(`Invalid GLB chunk: ${path}`);
    if (type === 0x4e4f534a) return { json: JSON.parse(bytes.toString('utf8', start, end).replace(/[\u0000\u0020]+$/g, '')) as Gltf, bytes };
    offset = end;
  }
  throw new Error(`Missing GLB JSON: ${path}`);
}

function inspect(id: number, source: Entry['source'], path: string): Entry {
  const { json, bytes } = gltfJson(path), skins = json.skins ?? [], animations = json.animations ?? [];
  const jointIds = new Set(skins.flatMap(skin => skin.joints ?? [])), paths: Record<string, number> = {};
  for (const animation of animations) for (const channel of animation.channels ?? []) {
    const path = channel.target?.path ?? 'unknown'; paths[path] = (paths[path] ?? 0) + 1;
  }
  const durationSeconds = animations.reduce((longest, animation) => Math.max(longest, ...(animation.samplers ?? []).map(sampler => json.accessors?.[sampler.input ?? -1]?.max?.[0] ?? 0)), 0);
  const skinnedNodes = (json.nodes ?? []).filter(node => node.skin !== undefined).length;
  const morphTargetPrimitives = (json.meshes ?? []).flatMap(mesh => mesh.primitives ?? []).filter(primitive => (primitive.targets?.length ?? 0) > 0).length;
  const support: Entry['support'] = skins.length && animations.length ? 'rigged-animated'
    : skins.length ? 'rigged-static' : animations.length ? 'transform-animated' : 'static';
  return { id, source, path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), nodes: json.nodes?.length ?? 0,
    skins: skins.length, joints: jointIds.size, skinnedNodes, morphTargetPrimitives, animationClips: animations.length,
    animationChannels: animations.reduce((sum, animation) => sum + (animation.channels?.length ?? 0), 0),
    clipNames: animations.map((animation, index) => animation.name || `clip-${index}`), durationSeconds, paths, support };
}

const entries: Entry[] = [];
for (let id = 1; id <= 151; id++) entries.push(inspect(id, 'legacy-06wj', join('data/local/pokemon-models', legacySource.commit, `${String(id).padStart(3, '0')}.glb`)));
for (const item of manifest.catalog.expandedEntries) entries.push(inspect(item.id, 'pokemon-3d-api', join('data/local/pokemon-models-expanded', manifest.source.commit, `${item.id}.glb`)));
entries.sort((a, b) => a.id - b.id);
const count = (predicate: (entry: Entry) => boolean) => entries.filter(predicate).length;
const bySource = (source: Entry['source']) => {
  const rows = entries.filter(entry => entry.source === source);
  return { total: rows.length, rigged: rows.filter(entry => entry.skins > 0).length, animated: rows.filter(entry => entry.animationClips > 0).length,
    riggedAnimated: rows.filter(entry => entry.support === 'rigged-animated').length, riggedStatic: rows.filter(entry => entry.support === 'rigged-static').length,
    transformAnimated: rows.filter(entry => entry.support === 'transform-animated').length, static: rows.filter(entry => entry.support === 'static').length };
};
const output = {
  schema: 1, generatedAt: new Date().toISOString(), method: 'Read-only GLB v2 JSON-chunk inspection of the pinned local source bytes; no model was modified.',
  tooling: {
    requestedCli: 'game-dev capabilities --json; game-dev doctor --json',
    requestedCliAvailable: false,
    requestedCliResult: 'command not found: game-dev',
    fallback: 'This repository-local TypeScript inspector reads only the GLB v2 JSON chunk and hashes the complete original file.',
  },
  source: { legacy: legacySource, expanded: manifest.source },
  totals: { models: entries.length, rigged: count(entry => entry.skins > 0), animated: count(entry => entry.animationClips > 0),
    riggedAnimated: count(entry => entry.support === 'rigged-animated'), riggedStatic: count(entry => entry.support === 'rigged-static'),
    transformAnimated: count(entry => entry.support === 'transform-animated'), static: count(entry => entry.support === 'static') },
  bySource: { legacy: bySource('legacy-06wj'), expanded: bySource('pokemon-3d-api') }, entries,
};
const destination = process.argv[2] ?? 'docs/pokemon-rigging-metadata.json';
writeFileSync(destination, JSON.stringify(output, null, 2));
const helperDestination = process.argv[3] ?? 'src/data/model-motion.ts';
const idList = (support: Entry['support']) => entries.filter(entry => entry.support === support).map(entry => entry.id);
const formatIds = (ids: number[]) => ids.reduce<string[]>((lines, id, index) => {
  if (index % 24 === 0) lines.push('');
  lines[lines.length - 1] += `${index % 24 ? ' ' : '  '}${id},`;
  return lines;
}, []).join('\n');
const helper = `// Generated by scripts/inspect-pokemon-rigging.ts from pinned local GLB bytes.\n`
  + `// A skin without animation clips is rigged-static, not playable source animation.\n`
  + `export type PokemonMotionSupport = 'rigged-animated' | 'rigged-static' | 'transform-animated' | 'static' | 'unavailable';\n\n`
  + `const RIGGED_ANIMATED = new Set<number>([\n${formatIds(idList('rigged-animated').filter(id => id > 151))}\n]);\n`
  + `const RIGGED_STATIC = new Set<number>([\n${formatIds(idList('rigged-static'))}\n]);\n`
  + `const TRANSFORM_ANIMATED = new Set<number>([\n${formatIds(idList('transform-animated'))}\n]);\n`
  + `const STATIC = new Set<number>([\n${formatIds(idList('static'))}\n]);\n\n`
  + `export type PokemonMotionKind = 'idle' | 'walk' | 'attack' | 'damage';\n`
  + `const MOTION_NAME = {\n`
  + `  idle: /idle|idol|wait|stand|ba10/i,\n`
  + `  walk: /walk|run|fly|turnmove/i,\n`
  + `  attack: /attack|bite|skill|fight|punch|charge|rangeattack|ba2[01]|buturi|tokusyu/i,\n`
  + `  damage: /damage|hit|hurt|faint|down/i,\n`
  + `} satisfies Record<PokemonMotionKind, RegExp>;\n\n`
  + `export function selectPokemonMotionClip<T extends { name: string }>(clips: readonly T[], kind: PokemonMotionKind) {\n`
  + `  const matched = clips.find(clip => MOTION_NAME[kind].test(clip.name));\n`
  + `  return { clip: matched ?? clips.find(clip => MOTION_NAME.idle.test(clip.name)) ?? clips[0], matched: !!matched };\n`
  + `}\n\n`
  + `export function getPokemonMotionSupport(speciesId: number): PokemonMotionSupport {\n`
  + `  if (!Number.isInteger(speciesId) || speciesId < 1) return 'unavailable';\n`
  + `  if (speciesId <= 151) return 'rigged-animated';\n`
  + `  if (RIGGED_ANIMATED.has(speciesId)) return 'rigged-animated';\n`
  + `  if (RIGGED_STATIC.has(speciesId)) return 'rigged-static';\n`
  + `  if (TRANSFORM_ANIMATED.has(speciesId)) return 'transform-animated';\n`
  + `  if (STATIC.has(speciesId)) return 'static';\n`
  + `  return 'unavailable';\n}\n`;
writeFileSync(helperDestination, helper);
console.log(JSON.stringify({ destination, helperDestination, totals: output.totals, bySource: output.bySource }, null, 2));
