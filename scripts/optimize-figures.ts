// Builds the game's figure models (public/models/trainer/web/) from their masters in assets/trainer-source/web/.
// pnpm exec tsx scripts/optimize-figures.ts [name ...]
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { NodeIO, type Animation, type AnimationSampler, type Document, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { Object3D, Quaternion, Vector3 } from 'three';

const source = 'assets/trainer-source/web', target = 'public/models/trainer/web';
/** The only idle the owner's figures came with: green's 14 s Mixamo loop, on the same skeleton names as every figure. */
const IDLE_SOURCE = 'assets/trainer-source/green.glb', IDLE_CLIP = 'Idle_4';
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
/** Triangles a figure may carry: a road holds a dozen of them, each drawn again for shadows. */
const TRIANGLE_BUDGET = 20_000;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const names = process.argv.length > 2 ? process.argv.slice(2) : (await readdir(source)).filter(file => file.endsWith('.glb')).map(file => file.slice(0, -4));
const megabytes = async (path: string) => ((await stat(path)).size / 1e6).toFixed(2);

type Rig = { root: Object3D; byName: Map<string, Object3D> };
/** The document's default scene as a three.js hierarchy, for world-space pose math. */
function rigOf(document: Document): Rig {
  const byName = new Map<string, Object3D>();
  const build = (node: Node): Object3D => {
    const object = new Object3D(); object.name = node.getName();
    object.position.fromArray(node.getTranslation()); object.quaternion.fromArray(node.getRotation()); object.scale.fromArray(node.getScale());
    byName.set(object.name, object);
    for (const child of node.listChildren()) object.add(build(child));
    return object;
  };
  const root = new Object3D(), scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  for (const node of scene.listChildren()) root.add(build(node));
  return { root, byName };
}

/** A sampler's value at `time`, linear between keys (normalized quaternion lerp is close enough at 30 keys a second). */
function sample(sampler: AnimationSampler, time: number, out: number[]): number[] {
  const times = sampler.getInput()!.getArray()!, values = sampler.getOutput()!, size = values.getElementSize();
  let index = 0;
  while (index < times.length - 2 && times[index + 1] <= time) index++;
  const span = times[index + 1] - times[index], t = span > 0 ? Math.min(1, Math.max(0, (time - times[index]) / span)) : 0;
  const a: number[] = [], b: number[] = [];
  values.getElement(index, a); values.getElement(Math.min(index + 1, times.length - 1), b);
  for (let c = 0; c < size; c++) out[c] = a[c] + (b[c] - a[c]) * t;
  if (size === 4) { const length = Math.hypot(...out.slice(0, 4)) || 1; for (let c = 0; c < 4; c++) out[c] /= length; }
  return out;
}

function pose(rig: Rig, animation: Animation, time: number): void {
  const value: number[] = [];
  for (const channel of animation.listChannels()) {
    const object = rig.byName.get(channel.getTargetNode()!.getName()), path = channel.getTargetPath();
    if (!object || (path !== 'rotation' && path !== 'translation')) continue;
    sample(channel.getSampler()!, time, value);
    if (path === 'rotation') object.quaternion.fromArray(value); else object.position.fromArray(value);
  }
  rig.root.updateMatrixWorld(true);
}

const clipNamed = (document: Document, pattern: RegExp) => document.getRoot().listAnimations().find(animation => pattern.test(animation.getName()));

/**
 * Carries green's idle onto a figure. Each figure's walk was made from the same walk as green's, so the walks' first
 * frames are one pose on both skeletons: every bone turns by the idle's world rotation away from that pose, whatever
 * its local axes, and the hips move by the idle's sway scaled to the figure's hip height.
 */
function addIdle(document: Document, idleSource: Document): void {
  const from = rigOf(idleSource), to = rigOf(document);
  const fromWalk = clipNamed(idleSource, /^walking$/i)!, toWalk = clipNamed(document, /^walking$/i), idle = clipNamed(idleSource, new RegExp(`^${IDLE_CLIP}$`))!;
  if (!toWalk) throw new Error('A figure needs its walk to take the idle');
  pose(from, fromWalk, 0); pose(to, toWalk, 0);
  const bones = idle.listChannels().filter(channel => channel.getTargetPath() === 'rotation').map(channel => channel.getTargetNode()!.getName()).filter(name => to.byName.has(name));
  const depth = (object: Object3D) => { let count = 0; for (let parent = object.parent; parent; parent = parent.parent) count++; return count; };
  bones.sort((a, b) => depth(to.byName.get(a)!) - depth(to.byName.get(b)!));
  const worldOf = (rig: Rig, name: string) => rig.byName.get(name)!.getWorldQuaternion(new Quaternion());
  const fromStart = new Map(bones.map(name => [name, worldOf(from, name).invert()])), toStart = new Map(bones.map(name => [name, worldOf(to, name)]));
  const hips = 'mixamorig:Hips', fromHips = from.byName.get(hips)!.getWorldPosition(new Vector3()), toHips = to.byName.get(hips)!.getWorldPosition(new Vector3());
  const scale = toHips.y / fromHips.y;
  const times = idle.listChannels()[0].getSampler()!.getInput()!.getArray()!;
  const rotations = new Map(bones.map(name => [name, new Float32Array(times.length * 4)])), hipsPath = new Float32Array(times.length * 3);
  const turn = new Quaternion(), parent = new Quaternion(), at = new Vector3();
  times.forEach((time, key) => {
    pose(from, idle, time);
    for (const name of bones) {
      const bone = to.byName.get(name)!;
      turn.copy(worldOf(from, name)).multiply(fromStart.get(name)!).multiply(toStart.get(name)!);
      bone.quaternion.copy(bone.parent!.getWorldQuaternion(parent).invert().multiply(turn));
      bone.updateMatrixWorld(true);
      rotations.get(name)!.set(bone.quaternion.toArray(), key * 4);
    }
    const hipsBone = to.byName.get(hips)!;
    at.copy(from.byName.get(hips)!.getWorldPosition(at)).sub(fromHips).multiplyScalar(scale).add(toHips);
    hipsBone.position.copy(hipsBone.parent!.worldToLocal(at)); hipsBone.updateMatrixWorld(true);
    hipsPath.set(hipsBone.position.toArray(), key * 3);
  });
  const buffer = document.getRoot().listBuffers()[0], nodes = new Map(document.getRoot().listNodes().map(node => [node.getName(), node]));
  const input = document.createAccessor().setType('SCALAR').setArray(new Float32Array(times)).setBuffer(buffer);
  const animation = document.createAnimation('Idle');
  const channel = (name: string, path: 'rotation' | 'translation', values: Float32Array<ArrayBuffer>) => {
    const sampler = document.createAnimationSampler().setInput(input).setInterpolation('LINEAR')
      .setOutput(document.createAccessor().setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(values).setBuffer(buffer));
    animation.addSampler(sampler).addChannel(document.createAnimationChannel().setTargetNode(nodes.get(name)!).setTargetPath(path).setSampler(sampler));
  };
  for (const name of bones) channel(name, 'rotation', rotations.get(name)!);
  channel(hips, 'translation', hipsPath);
}

const idleSource = await io.read(IDLE_SOURCE);
for (const name of names) {
  const input = join(source, `${name}.glb`), output = join(target, `${name}.glb`);
  const document = await io.read(input);
  if (!clipNamed(document, /^idle/i)) addIdle(document, idleSource);
  // Rest-pose stubs (restpose, Walking.001: two keys in 0.08 s) hold the T pose and are never played.
  for (const animation of document.getRoot().listAnimations()) {
    const end = Math.max(...animation.listSamplers().map(sampler => sampler.getInput()!.getMax([])[0]));
    if (end < .1) animation.dispose();
  }
  const triangles = document.getRoot().listMeshes().flatMap(mesh => mesh.listPrimitives()).reduce((sum, primitive) => sum + (primitive.getIndices()?.getCount() ?? 0) / 3, 0);
  // shadeFigure draws every figure fully rough and non-metallic, so its metallic-roughness map never reaches the screen.
  for (const material of document.getRoot().listMaterials()) material.setMetallicRoughnessTexture(null);
  await document.transform(
    dedup(), prune(),
    // A figure over budget is simplified to it; welding first lets the simplifier collapse across shared positions.
    ...(triangles > TRIANGLE_BUDGET ? [weld(), simplify({ simplifier: MeshoptSimplifier, ratio: TRIANGLE_BUDGET / triangles, error: .002 })] : []),
    // Drops keys that linear interpolation already reproduces.
    resample(),
    // Relief at half the colour map's size, still lossless: a 1.9 m figure a few metres away shows no finer normal detail.
    textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /^normalTexture$/, resize: [1024, 1024], lossless: true }),
    // Quantized, reordered and compressed geometry and clips; the loader decodes them with three's MeshoptDecoder.
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(output, document);
  console.log(`${name}: ${await megabytes(input)} MB -> ${await megabytes(output)} MB`);
}
