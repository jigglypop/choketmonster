import {
  AnimationClip, Bone, Box3, BufferAttribute, BufferGeometry, DataTexture, Group, Matrix3, Mesh, MeshStandardMaterial,
  NearestFilter, Object3D, PropertyBinding, Quaternion, QuaternionKeyframeTrack, RGBAFormat, Skeleton, SkinnedMesh,
  SRGBColorSpace, Vector3, VectorKeyframeTrack, type KeyframeTrack,
} from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { isSteppingPlan, pokemonBodyPlan, type BodyPlan } from '../data/body-plans';
import { pokemonBodyShape } from '../data/pokemon-body-shapes';
import { HOME_AUTHORED_PALETTES } from '../data/pokemon-home-authored-palettes';
import { CLIP_GROUND_SPEED, POKEMON_MOTION_KINDS, STATIC_MOTION_CLIP, pokemonMotionCandidates, selectPokemonMotionClip, type PokemonMotionKind } from '../data/model-motion';
import { isMovingClipMotion, missingMotionKinds, summarizeClipMotion, type KeyframeSample } from './clip-motion';

/** Authored articulation, separate from the immutable source models and their clips.
 * v5: source clips are measured; frozen ones are flagged and every missing motion kind is authored.
 * v6: looping walks and idles lose their root motion and keep its speed for playback matching.
 * v7: body plans come from the Pokédex body shapes; stepping walks plant the stance foot, lift the swing foot,
 *     trot on four legs and record their ground speed; serpents and fish ripple, flyers and floaters do not step. */
export const REGIONAL_RIG_VERSION = 'regional-authored-v7';
export const JOHTO_RIG_VERSION = REGIONAL_RIG_VERSION;
// Deoxys' source GLB contains one ArmatureAction whose 402 tracks repeat their bind-pose values.
// Preserve that source clip for provenance, and append authored motion so the runtime can animate it.
export const STATIC_NATIVE_CLIP_SPECIES: ReadonlySet<number> = new Set([68,122,386,794,796,798,802,805,914]);
type Shape = 'biped' | 'quadruped' | 'bird' | 'winged' | 'fish' | 'plant' | 'floatingPlant' | 'glyph' | 'serpent' | 'soft';
type Joint = { bone: Bone; start: Vector3; end: Vector3; role: string; side: number; phase: number };
const SPECIAL_SHAPES: Readonly<Record<number, Shape>> = { 187: 'floatingPlant', 201: 'glyph' };
/** Legless plant bodies keep leaves for arms: Sunkern, Lileep, Cherubi, Carnivine, Cottonee, Petilil, Maractus, Foongus, Ferroseed. */
const LEAFY_FLOATERS: ReadonlySet<number> = new Set([191, 345, 346, 420, 455, 546, 548, 549, 556, 590, 591, 597, 598]);
/** The skeleton authored for a static model, from its body plan (the Pokédex body shape unless its pose differs). */
export const johtoRigShape = (id: number): Shape => {
  const special = SPECIAL_SHAPES[id]; if (special) return special;
  const plan = pokemonBodyPlan(id);
  if (plan === 'quadruped' || plan === 'multileg') return 'quadruped';
  if (plan === 'serpent' || plan === 'fish') return plan;
  if (plan === 'flyer') return pokemonBodyShape(id) === 'bug-wings' ? 'winged' : 'bird';
  if (plan === 'floater') return LEAFY_FLOATERS.has(id) ? 'plant' : 'soft';
  return 'biped';
};

function applyHomeAuthoredAppearance(model: Object3D, id: number): void {
  const palette = HOME_AUTHORED_PALETTES[id];
  if (!palette || model.userData.authoredAppearance) return;
  let materialIndex = 0, materials = 0, uvMeshes = 0;
  const channels = (hex: string) => [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
  const darkest = [...palette].sort((a, b) => channels(a).reduce((sum, value) => sum + value, 0) - channels(b).reduce((sum, value) => sum + value, 0))[0];
  const warmest = [...palette].sort((a, b) => { const [ar, ag] = channels(a), [br, bg] = channels(b); return (br - bg) - (ar - ag); })[0];
  const materialColor = (name: string) => {
    if (/eye|pupil/i.test(name)) return darkest;
    if (/mouth|tongue|claw/i.test(name)) return warmest;
    const suffix = name.match(/(?:body|dsp|mat)[a-z]*0*([0-9]+)$/i)?.[1];
    return palette[suffix ? Number(suffix) % Math.min(3, palette.length) : 0];
  };
  const textureFor = (color: string) => {
    const rgba = (hex: string) => [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16), 255];
    const texel = rgba(color); const texture = new DataTexture(new Uint8Array([...texel, ...texel, ...texel, ...texel]), 2, 2, RGBAFormat);
    texture.colorSpace = SRGBColorSpace; texture.magFilter = NearestFilter; texture.minFilter = NearestFilter; texture.needsUpdate = true;
    texture.name = `CM_HOME_${id}_${materialIndex}`;
    return texture;
  };
  model.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const hasUv = Boolean(object.geometry.getAttribute('uv')); if (hasUv) uvMeshes++;
    const source = Array.isArray(object.material) ? object.material : [object.material];
    const authored = source.map(value => {
      const material = value.clone() as MeshStandardMaterial;
      const color = materialColor(value.name);
      if (material.color) material.color.set(hasUv ? '#ffffff' : color);
      if (hasUv && 'map' in material) material.map = textureFor(color);
      if ('metalness' in material) material.metalness = 0;
      if ('roughness' in material) material.roughness = .82;
      material.vertexColors = false;
      material.name = `${value.name || `material-${materialIndex}`}-CM-authored-palette`;
      material.needsUpdate = true; materialIndex++; materials++; return material;
    });
    object.material = Array.isArray(object.material) ? authored : authored[0];
  });
  model.userData.authoredAppearance = { version: 'home-sprite-palette-v1', speciesId: id, materials, uvMeshes, sourceSprite: `/pokemon/${id}.png`, classification: 'authored-derived-palette-not-source-texture' };
}

function buildSkeleton(model: Object3D, size: Vector3, center: Vector3, floor: number, id: number): Joint[] {
  const shape = johtoRigShape(id), joints: Joint[] = [];
  const point = (x: number, y: number, z: number) => new Vector3(center.x + x * size.x, floor + y * size.y, center.z + z * size.z);
  const add = (name: string, parent: Joint | undefined, start: Vector3, end: Vector3, role: string, side = 0, phase = 0) => {
    const bone = new Bone(); bone.name = `CM_${id}_${name}`;
    bone.position.copy(start).sub(parent?.start ?? new Vector3());
    (parent?.bone ?? model).add(bone);
    const joint = { bone, start, end, role, side, phase }; joints.push(joint); return joint;
  };
  const joint = (name: string, parent: Joint | undefined, a: [number, number, number], b: [number, number, number], role: string, side = 0, phase = 0) => add(name, parent, point(...a), point(...b), role, side, phase);
  const low = shape === 'quadruped' ? .43 : shape === 'plant' ? .12 : .38;
  const hips = joint('hips', undefined, [0, low, -.12], [0, low + .13, 0], 'hips');
  if (id === 165 || id === 170) {
    const body = joint('body', hips, [0, id === 170 ? .32 : .46, 0], [0, .64, .2], 'spine');
    for (const side of [-1, 1]) {
      if (id === 165) {
        for (const [n, y, z] of [[0, .074, .017], [1, .267, .199], [2, .457, .359]]) {
          const leg = joint(`${side}_leg${n}`, body, [side * .18, y + .1, z - .08], [side * .28, y + .04, z - .03], 'leg', side, n * Math.PI);
          joint(`${side}_foot${n}`, leg, [side * .28, y + .04, z - .03], [side * .37, y, z], 'foot', side, n * Math.PI);
        }
        const shell = joint(`${side}_shell`, body, [side * .03, .65, .05], [side * .22, .71, -.04], 'shell', side);
        joint(`${side}_shellTip`, shell, [side * .22, .71, -.04], [side * .44, .75, -.2], 'shellTip', side);
        const wing = joint(`${side}_wing`, body, [side * .04, .647, -.02], [side * .25, .647, -.19], 'wing', side);
        joint(`${side}_wingTip`, wing, [side * .25, .647, -.19], [side * .49, .647, -.31], 'wingTip', side);
      } else {
        const path: Array<[number, number, number]> = [[side * .08, .5, -.35], [side * .14, .85, -.32], [side * .32, .94, .02], [side * .42, .62, .33], [side * .43, .28, .4]];
        let parent = body;
        for (let n = 0; n < path.length - 1; n++) parent = joint(`${side}_antenna${n}`, parent, path[n], path[n + 1], 'antenna', side, n * .4);
      }
    }
    return joints;
  }
  if (shape === 'floatingPlant' || shape === 'glyph') {
    const body = joint('body', hips, [0, .4, 0], [0, .65, 0], 'spine');
    if (shape === 'floatingPlant') for (const side of [-1, 1]) {
      const leaf = joint(`${side}_leaf`, body, [0, .68, .3], [side * .23, .85, .3], 'leaf', side);
      joint(`${side}_leafTip`, leaf, [side * .23, .85, .3], [side * .48, .94, .3], 'leafTip', side);
    }
    return joints;
  }
  if (shape === 'serpent') {
    // A segmented centerline flexes the body instead of rotating the whole object.
    let parent = hips;
    const alongY = size.y >= size.z;
    for (let i = 0; i < 7; i++) {
      const a: [number, number, number] = alongY ? [0, .08 + i * .12, 0] : [0, .48, -.44 + i * .13];
      const b: [number, number, number] = alongY ? [0, .08 + (i + 1) * .12, 0] : [0, .48, -.44 + (i + 1) * .13];
      parent = joint(`segment${i}`, parent, a, b, i === 6 ? 'head' : 'tail', 0, i * .5);
    }
    return joints;
  }
  const horizontal = shape === 'quadruped' || shape === 'fish';
  const spine = joint('spine', hips, [0, low + .05, 0], [0, horizontal ? .55 : .67, horizontal ? .17 : .03], 'spine');
  const neck = joint('neck', spine, [0, horizontal ? .55 : .65, horizontal ? .19 : .04], [0, horizontal ? .68 : .77, horizontal ? .29 : .08], 'neck');
  joint('head', neck, [0, horizontal ? .69 : .77, horizontal ? .3 : .08], [0, horizontal ? .77 : .93, horizontal ? .45 : .12], 'head');
  if (shape !== 'plant') {
    const a: [number, number, number] = id === 161 ? [0, .47, -.08] : [0, low, -.22];
    const b: [number, number, number] = id === 161 ? [0, .24, -.09] : [0, low + .03, -.36];
    const c: [number, number, number] = id === 161 ? [0, .06, .02] : [0, id === 179 ? .82 : low + .08, -.5];
    const tail = joint('tail1', hips, a, b, 'tail');
    joint('tail2', tail, b, c, 'tail', 0, .55);
  }
  for (const side of [-1, 1]) {
    const sign = side < 0 ? 'L' : 'R';
    if (shape === 'quadruped') {
      for (const [label, z, phase] of [['front', .2, 0], ['back', -.24, Math.PI]] as const) {
        const parent = label === 'front' ? spine : hips;
        const upper = joint(`${sign}_${label}_thigh`, parent, [side * .24, .43, z], [side * .26, .22, z + .02], 'leg', side, phase);
        joint(`${sign}_${label}_foot`, upper, [side * .26, .22, z + .02], [side * .27, .04, z + .08], 'foot', side, phase);
      }
      continue;
    } else if (!['fish', 'plant', 'soft'].includes(shape)) {
      const footY = id === 161 ? .34 : .04, hipY = id === 161 ? .51 : .32;
      const upper = joint(`${sign}_thigh`, hips, [side * .19, hipY, 0], [side * .2, (hipY + footY) / 2, .02], 'leg', side);
      joint(`${sign}_foot`, upper, [side * .2, (hipY + footY) / 2, .02], [side * .22, footY, .08], 'foot', side);
    }
    const wing = shape === 'bird' || shape === 'winged', fin = shape === 'fish';
    const role = wing ? 'wing' : fin ? 'fin' : shape === 'plant' ? 'leaf' : 'arm';
    if (id === 195) {
      const arm = joint(`${sign}_arm`, spine, [side * .25, .6, .03], [side * .32, .56, .25], 'arm', side);
      joint(`${sign}_arm_tip`, arm, [side * .32, .56, .25], [side * .32, .59, .45], 'armTip', side);
      continue;
    }
    const arm = joint(`${sign}_${role}`, spine, [side * .17, .62, .02], [side * .34, wing || fin ? .6 : .5, .04], role, side);
    joint(`${sign}_${role}_tip`, arm, [side * .34, wing || fin ? .6 : .5, .04], [side * .49, wing || fin ? .58 : .39, .07], `${role}Tip`, side, .4);
  }
  return joints;
}

function capsuleDistance(point: Vector3, joint: Joint, size: Vector3): number {
  // Compare in normalized anatomical space, so the largest axis cannot dominate weights.
  const start = joint.start.clone().divide(size), end = joint.end.clone().divide(size), p = point.clone().divide(size);
  const direction = end.sub(start), t = Math.max(0, Math.min(1, p.sub(start).dot(direction) / Math.max(1e-12, direction.lengthSq())));
  return p.addScaledVector(direction, -t).lengthSq();
}

function weightCandidates(point: Vector3, bounds: Box3, joints: Joint[], shape: Shape, id: number, part?: string): Array<[number, number]> {
  const size = bounds.getSize(new Vector3()), center = bounds.getCenter(new Vector3());
  const x = (point.x - center.x) / size.x, y = (point.y - bounds.min.y) / size.y, z = (point.z - center.z) / size.z;
  const smooth = (a: number, b: number, v: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  if (id === 165 || id === 170) {
    const body = joints.findIndex(j => j.role === 'spine');
    if (!part || part === 'body') return [[body, 1]];
    const ranked = joints.map((j, i): [number, number] => [i, (j.side === Math.sign(x) && (part === 'leg' ? /leg|foot/.test(j.role) : j.role.startsWith(part))) ? 1 / Math.pow(.018 + capsuleDistance(point, j, size), 1.6) : 0]).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (id === 170 && y < .56 && z > .05) return [[joints.findIndex(j => j.side === Math.sign(x) && j.bone.name.endsWith('antenna3')), 1]];
    const total = ranked.reduce((s, [, w]) => s + w, 0);
    return total ? ranked.map(([i, w]) => [i, w / total]) : [[body, 1]];
  }
  // A continuous field shared by all material pieces avoids seams at anatomical cuts.
  // Facial overlays must deform with the body underneath, never by mesh-name rules.
  if (shape === 'glyph') return [[joints.findIndex(j => j.role === 'spine'), 1]];
  if (id === 195) {
    // Quagsire has one round torso/head and arms extending forwards, not a T pose.
    if (part === 'foot') return [[joints.findIndex(j => j.role === 'foot' && j.side === Math.sign(x)), 1]];
    const arm = smooth(.21, .32, Math.abs(x)) * smooth(.05, .23, z) * smooth(.4, .53, y) * (1 - smooth(.65, .74, y));
    const leg = 0, tail = smooth(.18, .36, -z);
    const region = Math.max(arm, leg, tail), body = joints.findIndex(j => j.role === 'spine');
    const ranked = joints.map((j, i): [number, number] => [i, (j.side && Math.sign(x) !== j.side ? 0 : /arm/.test(j.role) ? arm : /leg|foot/.test(j.role) ? leg : j.role === 'tail' ? tail : 0) / Math.pow(.018 + capsuleDistance(point, j, size), 1.5)])
      .filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const total = ranked.reduce((s, [, w]) => s + w, 0);
    return total ? [[body, 1 - region], ...ranked.map(([i, w]): [number, number] => [i, region * w / total])] : [[body, 1]];
  }
  if (shape === 'floatingPlant') {
    const leaf = smooth(.68, .86, y), body = joints.findIndex(j => j.role === 'spine');
    const ranked = joints.map((j, i): [number, number] => [i, j.role.startsWith('leaf') ? smooth(-.06, .16, j.side * x) / Math.pow(.015 + capsuleDistance(point, j, size), 1.5) : 0]).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const total = ranked.reduce((s, [, w]) => s + w, 0);
    return total && leaf ? [[body, 1 - leaf], ...ranked.map(([i, w]): [number, number] => [i, leaf * w / total])] : [[body, 1]];
  }
  const horizontal = shape === 'quadruped' || shape === 'fish';
  const head = horizontal ? smooth(.08, .28, z) * smooth(.4, .6, y) : smooth(.61, .77, y);
  const anatomical = (j: Joint): number => {
    if (shape === 'serpent') return j.role === 'hips' ? 0 : 1;
    if (j.role === 'head') return .15 + head * 3;
    const side = j.side ? smooth(-.03, .16, j.side * x) : 1;
    if (/arm|wing|fin|leaf/.test(j.role)) return side * smooth(.12, .3, Math.abs(x)) * smooth(.28, .46, y) * (1 - head);
    if (/leg|foot/.test(j.role)) return side * (1 - smooth(.22, .46, y));
    if (j.role === 'tail') return smooth(.15, .36, -z) * (1 - head);
    return (1 - head) * (j.role === 'neck' ? .45 : 1);
  };
  const ranked = joints.map((j, i): [number, number] => [i, anatomical(j) / Math.pow(.018 + capsuleDistance(point, j, size), 1.7)])
    .filter(([, weight]) => weight > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const total = ranked.reduce((sum, [, weight]) => sum + weight, 0);
  return ranked.map(([index, weight]) => [index, weight / total]);
}

/** Material primitives contain disconnected anatomical pieces in these two sources. */
function anatomicalParts(geometry: BufferGeometry, bounds: Box3, id: number, name: string): string[] | undefined {
  if (id !== 165 && id !== 170 && id !== 195) return;
  const positions = geometry.getAttribute('position'), size = bounds.getSize(new Vector3()), point = new Vector3();
  if (id === 170) return Array(positions.count).fill(name === 'Object_3' ? 'antenna' : 'body');
  if (name === 'Object_6') return Array(positions.count).fill('wing');
  if (name !== (id === 195 ? 'Object_2' : 'Object_3')) return Array(positions.count).fill('body');
  const parent = Array.from({ length: positions.count }, (_, i) => i), welded = new Map<string, number>();
  const root = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number) => { parent[root(a)] = root(b); };
  for (let i = 0; i < positions.count; i++) {
    point.fromBufferAttribute(positions, i).sub(bounds.min).divide(size);
    const key = point.toArray().map(v => Math.round(v * 100000)).join(','), prior = welded.get(key);
    if (prior === undefined) welded.set(key, i); else union(i, prior);
  }
  const index = geometry.index, count = index?.count ?? positions.count;
  for (let i = 0; i < count; i += 3) { const a = index?.getX(i) ?? i; union(a, index?.getX(i + 1) ?? i + 1); union(a, index?.getX(i + 2) ?? i + 2); }
  const components = new Map<number, Box3>();
  for (let i = 0; i < positions.count; i++) { const key = root(i), box = components.get(key) ?? new Box3(); box.expandByPoint(point.fromBufferAttribute(positions, i)); components.set(key, box); }
  const parts = new Map<number, string>();
  for (const [key, box] of components) {
    const center = box.getCenter(new Vector3()).sub(bounds.min).divide(size), span = box.getSize(new Vector3()).divide(size);
    parts.set(key, id === 195 ? (center.y < .1 ? 'foot' : 'body') : center.y < .53 && Math.abs(center.x - .5) > .14 ? 'leg' : center.y > .6 && span.y > .3 && center.z < .55 ? 'shell' : 'body');
  }
  return parent.map((_, i) => parts.get(root(i)) ?? 'body');
}

function skinStaticModel(model: Object3D, id: number): Joint[] {
  model.updateMatrixWorld(true);
  const meshes: Mesh[] = []; model.traverse(object => { if (object instanceof Mesh) meshes.push(object); });
  const inverse = model.matrixWorld.clone().invert(), bounds = new Box3(), point = new Vector3();
  for (const mesh of meshes) {
    const transform = inverse.clone().multiply(mesh.matrixWorld), positions = mesh.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      if (mesh instanceof SkinnedMesh) mesh.getVertexPosition(i, point); else point.fromBufferAttribute(positions, i);
      bounds.expandByPoint(point.applyMatrix4(transform));
    }
  }
  const size = bounds.getSize(new Vector3());
  if (bounds.isEmpty() || ![size.x, size.y, size.z].every(Number.isFinite)) throw new Error(`Invalid source geometry for rig ${id}`);
  size.max(new Vector3(1e-5, 1e-5, 1e-5));
  const joints = buildSkeleton(model, size, bounds.getCenter(new Vector3()), bounds.min.y, id);
  model.updateMatrixWorld(true);
  const skeleton = new Skeleton(joints.map(j => j.bone));
  const discarded = new Set<Mesh['geometry']>();
  const weldedWeights = new Map<string, Array<[number, number]>>();
  for (const mesh of meshes) {
    const transform=inverse.clone().multiply(mesh.matrixWorld),geometry=mesh.geometry.clone();
    if(mesh instanceof SkinnedMesh){const source=mesh.geometry.getAttribute('position'),baked=new Float32Array(source.count*3);for(let i=0;i<source.count;i++){mesh.getVertexPosition(i,point).applyMatrix4(transform);baked[i*3]=point.x;baked[i*3+1]=point.y;baked[i*3+2]=point.z;}geometry.setAttribute('position',new BufferAttribute(baked,3));}
    else geometry.applyMatrix4(transform);
    const positions = geometry.getAttribute('position'), indices = new Uint16Array(positions.count * 4), weights = new Float32Array(positions.count * 4);
    const parts = anatomicalParts(geometry, bounds, id, mesh.name);
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i);
      const key = `${parts?.[i] ?? ''}:` + [point.x / size.x, point.y / size.y, point.z / size.z].map(v => Math.round(v * 100000)).join(',');
      let skinWeights = weldedWeights.get(key);
      if (!skinWeights) { skinWeights = weightCandidates(point, bounds, joints, johtoRigShape(id), id, parts?.[i]); weldedWeights.set(key, skinWeights); }
      for (const [slot, [index, weight]] of skinWeights.entries()) {
        indices[i * 4 + slot] = index; weights[i * 4 + slot] = weight;
      }
    }
    geometry.setAttribute('skinIndex', new BufferAttribute(indices, 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4));
    const skinned = new SkinnedMesh(geometry, mesh.material);
    skinned.name = mesh.name; skinned.userData = { ...mesh.userData, authoredRig: JOHTO_RIG_VERSION };
    skinned.castShadow = mesh.castShadow; skinned.receiveShadow = mesh.receiveShadow; skinned.frustumCulled = false;
    // The geometry is now in the model's local frame; all pieces share one skeleton.
    model.add(skinned); skinned.bind(skeleton, model.matrixWorld); skinned.normalizeSkinWeights();
    mesh.removeFromParent(); discarded.add(mesh.geometry);
  }
  for (const geometry of discarded) geometry.dispose();
  model.updateMatrixWorld(true); skeleton.update();
  return joints;
}

/** Side from source naming (LThigh, left_leg_01, Leg.L, HindLegL, trright_arm); 0 for Leg, Root, Luxio. */
export function boneSide(name: string): number {
  const base = name.replace(/_\d+$/, '').replace(/_end$/i, '');
  const sided = (full: RegExp, letter: 'L' | 'R') => full.test(base) || new RegExp(`^${letter}(?=[A-Z0-9_.])`).test(base)
    || new RegExp(`(?:^|[_.\\s|-])${letter}(?:$|[_.\\s|0-9-])`, 'i').test(base) || new RegExp(`[a-z0-9]${letter}$`).test(base);
  return sided(/left/i, 'L') ? -1 : sided(/right/i, 'R') ? 1 : 0;
}

const LEG_SEGMENT = /thigh|upleg|crotch|leg|knee|calf|shin|foot|ankle|toe/;
// Gen 8/9 rigs pair each joint with a constant "tr" translation parent (trleft_leg_01 -> left_leg_01).
const TRANSLATION_HELPER = /^tr(?:left|right|center|spine|neck|head|hips|arm|leg|foot|shoulder|crotch)/;

/**
 * Motion role from a bone name and its bone ancestors (nearest first). Leg chains are ranked by
 * position, so a named hip/thigh swings, the next segment bends, and deeper segments follow.
 */
export function boneMotionRole(name: string, ancestors: readonly string[]): string {
  const lower = name.toLowerCase();
  if (/wing/.test(lower)) return 'wing';
  if (/tail/.test(lower)) return 'tail';
  if (LEG_SEGMENT.test(lower) && !/feeler|pole|target|ik/.test(lower)) {
    if (TRANSLATION_HELPER.test(lower)) return 'legHelper';
    let chain = 0;
    for (const ancestor of ancestors.map(value => value.toLowerCase())) {
      if (TRANSLATION_HELPER.test(ancestor)) continue;
      if (!LEG_SEGMENT.test(ancestor) || /feeler|pole|target|ik/.test(ancestor)) break;
      chain++;
    }
    return chain === 0 ? 'leg' : chain === 1 ? 'foot' : 'legTip';
  }
  const role = /hand|forearm|arm_02(?!\d)|lowerarm/.test(lower) ? 'armTip' : /arm|shoulder/.test(lower) ? 'arm'
    : /head/.test(lower) ? 'head' : /neck/.test(lower) ? 'neck' : /spine|chest|body|^waist/.test(lower) ? 'spine' : /hips|pelvis/.test(lower) ? 'hips' : 'other';
  if (role !== 'other') return role;
  const depth = ancestors.length;
  return depth === 0 ? 'hips' : depth === 1 ? 'spine' : depth === 2 ? 'neck' : depth === 3 ? 'head' : 'other';
}

function existingJoints(model: Object3D): Joint[] {
  const bones = new Set<Bone>(); model.traverse(object => { if (object instanceof SkinnedMesh) for (const bone of object.skeleton.bones) bones.add(bone); });
  model.updateMatrixWorld(true);
  return [...bones].map(bone => {
    const name = bone.name.toLowerCase(), side = boneSide(bone.name), ancestors: string[] = [];
    for (let parent = bone.parent; parent instanceof Bone; parent = parent.parent) ancestors.push(parent.name);
    const role = boneMotionRole(bone.name, ancestors);
    let endpoint = bone.children.find(child => child instanceof Bone) as Bone | undefined;
    if (role === 'arm') {
      bone.traverse(child => { if (child !== bone && child instanceof Bone && /forearm|arm_02(?!\d)|lowerarm/i.test(child.name) && !endpoint?.name.match(/forearm|arm_02(?!\d)|lowerarm/i)) endpoint = child; });
    }
    return { bone, start: bone.getWorldPosition(new Vector3()), end: endpoint?.getWorldPosition(new Vector3()) ?? bone.getWorldPosition(new Vector3()).add(new Vector3(0, .1, 0)), role, side, phase: /tail[2-9]/.test(name) ? .5 : 0 };
  });
}

type PoseValue = { track: string; node: string; property: 'quaternion' | 'position' | 'scale'; value: number[] };

/** Values per keyframe, excluding glTF cubic-spline tangents. */
function keyframeValues(track: KeyframeTrack): { stride: number; offset: number; step: number } {
  const perKey = track.times.length ? track.values.length / track.times.length : track.values.length;
  // GLTFLoader flags cubic-spline tracks on their interpolant factory; values then hold in/value/out tangents.
  const cubic = (track as unknown as { createInterpolant?: { isInterpolantFactoryMethodGLTFCubicSpline?: boolean } }).createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline === true;
  return cubic ? { stride: perKey / 3, offset: perKey / 3, step: perKey } : { stride: perKey, offset: 0, step: perKey };
}

function motionSamples(clip: AnimationClip): KeyframeSample[] {
  return clip.tracks.map(track => {
    const { stride, offset, step } = keyframeValues(track);
    if (!offset) return { name: track.name, times: track.times, values: track.values };
    const values = new Float32Array(track.times.length * stride);
    for (let key = 0; key < track.times.length; key++) values.set(track.values.subarray(key * step + offset, key * step + offset + stride), key * stride);
    return { name: track.name, times: track.times, values };
  });
}

/** Whether each source clip visibly moves: rotation, scale, morph weights, or translation relative to model height. */
function measureSourceClips(root: Object3D, clips: readonly AnimationClip[], modelHeight: () => number): Array<{ clip: AnimationClip; name: string; moving: boolean }> {
  const scales = new Map<string, number>();
  const translationScale = (trackName: string) => {
    const nodeName = PropertyBinding.parseTrackName(trackName).nodeName;
    let scale = scales.get(nodeName);
    if (scale === undefined) {
      const parent = (PropertyBinding.findNode(root, nodeName) as Object3D | undefined)?.parent;
      const world = parent ? parent.getWorldScale(new Vector3()) : new Vector3(1, 1, 1);
      scale = Math.max(Math.abs(world.x), Math.abs(world.y), Math.abs(world.z)) / modelHeight();
      scales.set(nodeName, scale);
    }
    return scale;
  };
  return clips.map(clip => ({ clip, name: clip.name, moving: isMovingClipMotion(summarizeClipMotion(motionSamples(clip), translationScale)) }));
}

/** Travel per loop, as a share of model height, above which a looping clip carries root motion. */
export const ROOT_MOTION_FLOOR = .05;

/**
 * Source walk and run loops often carry root motion: the body strides ahead of its origin and snaps
 * back every cycle, while the world already moves the creature. Removes the per-loop travel of the
 * topmost translating nodes (bob and sway stay) and records the travel speed in model heights per
 * second, so playback can match the creature's ground speed. Returns that speed, or 0.
 */
export function removeRootMotion(root: Object3D, clip: AnimationClip, modelHeight: number): number {
  root.updateMatrixWorld(true);
  const drifting: Array<{ track: KeyframeTrack; node: Object3D; local: Vector3; world: Vector3 }> = [];
  for (const track of clip.tracks) {
    const { nodeName, propertyName, propertyIndex } = PropertyBinding.parseTrackName(track.name);
    if (propertyName !== 'position' || propertyIndex !== undefined || track.times.length < 2) continue;
    const node = PropertyBinding.findNode(root, nodeName) as Object3D | undefined, { stride, offset, step } = keyframeValues(track);
    if (!node || stride !== 3) continue;
    const first = offset, last = (track.times.length - 1) * step + offset, values = track.values;
    const local = new Vector3(values[last] - values[first], values[last + 1] - values[first + 1], values[last + 2] - values[first + 2]);
    const world = node.parent ? local.clone().applyMatrix3(new Matrix3().setFromMatrix4(node.parent.matrixWorld)) : local.clone();
    if (world.length() >= ROOT_MOTION_FLOOR * modelHeight) drifting.push({ track, node, local, world });
  }
  const nodes = new Set(drifting.map(entry => entry.node));
  const topmost = drifting.filter(({ node }) => { for (let parent = node.parent; parent; parent = parent.parent) if (nodes.has(parent)) return false; return true; });
  let speed = 0;
  for (const { track, local, world } of topmost) {
    const { stride, offset, step } = keyframeValues(track), times = track.times, span = times[times.length - 1] - times[0];
    if (!(span > 0)) continue;
    // Copy first: GLTFLoader may share one accessor array between tracks.
    const values = track.values = track.values.slice(), slope = local.clone().divideScalar(span).toArray();
    for (let key = 0; key < times.length; key++) {
      const elapsed = times[key] - times[0];
      for (let c = 0; c < 3; c++) {
        values[key * step + offset + c] -= slope[c] * elapsed;
        // Cubic-spline tangents are per-second derivatives; the removed travel is a constant slope.
        if (offset) { values[key * step + c] -= slope[c]; values[key * step + 2 * stride + c] -= slope[c]; }
      }
    }
    speed = Math.max(speed, Math.hypot(world.x, world.z) / Math.max(clip.duration, span) / modelHeight);
  }
  if (speed > 0) clip.userData[CLIP_GROUND_SPEED] = speed;
  return speed;
}

/** The first keyframe of a source clip: the pose its authored companions start from. */
function clipStartPose(clip: AnimationClip): PoseValue[] {
  return clip.tracks.flatMap(track => {
    const { nodeName, propertyName, propertyIndex } = PropertyBinding.parseTrackName(track.name);
    if (propertyIndex !== undefined || !(propertyName === 'quaternion' || propertyName === 'position' || propertyName === 'scale')) return [];
    const { stride, offset } = keyframeValues(track);
    if (stride !== (propertyName === 'quaternion' ? 4 : 3)) return [];
    return [{ track: track.name, node: nodeName, property: propertyName, value: Array.from(track.values.subarray(offset, offset + stride)) }];
  });
}

/**
 * The mixer returns a bone that the playing clip leaves unkeyed to its bind pose, often a T pose: a walk without
 * arm tracks spreads the arms the idle lowered, and a crossfade blends toward that pose. Every playable clip gets a
 * constant track for each bone another playable clip keys, held at the idle's first pose, else the bind pose.
 */
export function holdUnkeyedTracks(root: Object3D, clips: readonly AnimationClip[]): void {
  const playable = clips.filter(clip => clip.userData?.[STATIC_MOTION_CLIP] !== true);
  if (playable.length < 2) return;
  const idle = selectPokemonMotionClip(playable, 'idle').clip;
  const held = new Map((idle ? clipStartPose(idle) : []).map(pose => [pose.track, pose.value]));
  const keyed = new Map<string, { node: string; property: PoseValue['property'] }>();
  for (const clip of playable) for (const track of clip.tracks) {
    const { nodeName, propertyName, propertyIndex } = PropertyBinding.parseTrackName(track.name);
    if (propertyIndex === undefined && (propertyName === 'quaternion' || propertyName === 'position' || propertyName === 'scale')) keyed.set(track.name, { node: nodeName, property: propertyName });
  }
  for (const clip of playable) {
    const own = new Set(clip.tracks.map(track => track.name)), duration = Math.max(clip.duration, 1e-3);
    for (const [name, { node, property }] of keyed) {
      if (own.has(name)) continue;
      const value = held.get(name) ?? (PropertyBinding.findNode(root, node) as Object3D | undefined)?.[property].toArray();
      if (!value) continue;
      clip.tracks.push(property === 'quaternion' ? new QuaternionKeyframeTrack(name, [0, duration], [...value, ...value]) : new VectorKeyframeTrack(name, [0, duration], [...value, ...value]));
    }
  }
}

function applyPose(root: Object3D, pose: readonly PoseValue[]): () => void {
  const restore: Array<() => void> = [];
  for (const { node, property, value } of pose) {
    const target = (PropertyBinding.findNode(root, node) as Object3D | undefined)?.[property];
    if (!target) continue;
    const previous = target.toArray();
    restore.push(() => { target.fromArray(previous); });
    target.fromArray(value);
  }
  root.updateMatrixWorld(true);
  return () => { restore.reverse().forEach(reset => reset()); root.updateMatrixWorld(true); };
}

/**
 * Stepping gait per plan. `swing`: hip angle either side of vertical for hips at 35% of body height (shorter legs swing
 * wider); `knee`: peak swing-phase flex, radians. `duty`: share of the cycle a foot stays planted. Past half, the stance
 * phases of alternating feet overlap, so a planted foot always carries the body.
 */
const STEPS: Readonly<Record<'biped' | 'quadruped' | 'multileg', { swing: number; knee: number; duty: number }>> = {
  biped: { swing: .42, knee: .8, duty: .6 }, quadruped: { swing: .38, knee: .7, duty: .56 }, multileg: { swing: .3, knee: .5, duty: .56 },
};
const WALK_SECONDS = .9;
/** `reach`: the leg root's height above the ground, as a share of body height. */
type Limb = { phase: number; depth: number; reach: number };

/**
 * Leg chains of a stepping body and their cycle offsets, in cycles: bipeds alternate, four-footed bodies trot (each
 * foreleg with the opposite hind leg), many-legged bodies step in alternating tripods. Four-footed sources often name
 * their forelegs arms: on a quadruped every arm chain is a leg, and a biped whose hands reach the ground walks on all
 * fours. Also returns hip height as a share of model height.
 */
function steppingLimbs(model: Object3D, joints: readonly Joint[], plan: BodyPlan): { limbs: Map<Joint, Limb>; hip: number } {
  const bounds = new Box3().setFromObject(model, true), height = Math.max(bounds.max.y - bounds.min.y, 1e-6), center = bounds.getCenter(new Vector3());
  const width = Math.max(bounds.max.x - bounds.min.x, 1e-6);
  const byBone = new Map(joints.map(joint => [joint.bone, joint]));
  /** Lowest point of a joint's chain: the joint and every joint below it. */
  const reach = (joint: Joint) => { let low = Math.min(joint.start.y, joint.end.y); joint.bone.traverse(bone => { const below = byBone.get(bone as Bone); if (below) low = Math.min(low, below.start.y, below.end.y); }); return low - bounds.min.y; };
  const armChain = (joint: Joint) => joint.role === 'arm' || joint.role === 'armTip';
  const fourFooted = plan !== 'biped' || joints.some(joint => joint.role === 'arm' && reach(joint) < .2 * height);
  // A four-footed plan on a body that stands up (Pichu, Iron Crown) holds its arms at the shoulder: an arm chain
  // that ends well above the ground stays an arm and is lowered, not stepped from its spread bind pose.
  const foreleg = (joint: Joint) => plan !== 'quadruped' || reach(joint) < .25 * height;
  const isLeg = (joint: Joint) => /^(leg|foot|legTip)$/.test(joint.role) || (fourFooted && armChain(joint) && foreleg(joint));
  const legAncestor = (joint: Joint) => { for (let bone = joint.bone.parent; bone; bone = bone.parent) { const parent = byBone.get(bone as Bone); if (parent && isLeg(parent)) return parent; } return undefined; };
  const roots = joints.filter(joint => isLeg(joint) && !legAncestor(joint));
  const sideOf = (joint: Joint) => joint.side || (Math.abs(joint.start.x - center.x) > .03 * width ? Math.sign(joint.start.x - center.x) : 0);
  const limbs = new Map<Joint, Limb>();
  for (const root of roots) {
    const side = sideOf(root), front = armChain(root) || root.start.z > center.z;
    let phase = side > 0 ? .5 : 0;
    if (plan === 'multileg') phase += roots.filter(other => sideOf(other) === side && other.start.z > root.start.z).length % 2 * .5;
    else if (fourFooted && !front) phase += .5;
    limbs.set(root, { phase: phase % 1, depth: 0, reach: Math.max(.05, (root.start.y - bounds.min.y) / height) });
  }
  for (const joint of joints) {
    if (limbs.has(joint) || !isLeg(joint)) continue;
    let depth = 0, root: Joint | undefined = joint;
    while (root && !limbs.has(root)) { root = legAncestor(root); depth++; }
    if (root) limbs.set(joint, { ...limbs.get(root)!, depth });
  }
  // Hind legs set the stride; forelegs named as arms start at the shoulder, well above the ground.
  const hips = roots.filter(root => !armChain(root)).map(root => (root.start.y - bounds.min.y) / height).sort((a, b) => a - b);
  return { limbs, hip: Math.max(.08, Math.min(.7, hips[Math.floor(hips.length / 2)] ?? .35)) };
}

/**
 * Direction from each upper arm's joint to the centre of the mesh its chain carries. A skeleton authored for a
 * static mesh places its arm bones by body proportions, so an arm the mesh holds straight out (Beartic) sits
 * well above its bone; lowering by the bone's angle would leave that arm half raised.
 */
function skinnedArmDirections(model: Object3D, joints: readonly Joint[]): Map<Joint, Vector3> {
  const chainOf = new Map<Bone, Joint>();
  for (const joint of joints) if (joint.role === 'arm') joint.bone.traverse(bone => { if (bone instanceof Bone) chainOf.set(bone, joint); });
  const sums = new Map<Joint, { sum: Vector3; count: number }>(), point = new Vector3();
  model.traverse(object => {
    if (!(object instanceof SkinnedMesh)) return;
    const { position, skinIndex, skinWeight } = object.geometry.attributes;
    if (!position || !skinIndex || !skinWeight) return;
    for (let i = 0; i < position.count; i++) {
      let best = .5, arm: Joint | undefined;
      for (let slot = 0; slot < 4; slot++) {
        const weight = skinWeight.getComponent(i, slot);
        if (weight > best) { best = weight; arm = chainOf.get(object.skeleton.bones[skinIndex.getComponent(i, slot)]); }
      }
      if (!arm) continue;
      const entry = sums.get(arm) ?? { sum: new Vector3(), count: 0 };
      entry.sum.add(point.fromBufferAttribute(position, i)); entry.count++; sums.set(arm, entry);
    }
  });
  const directions = new Map<Joint, Vector3>();
  for (const [joint, { sum, count }] of sums) {
    const direction = sum.divideScalar(count).sub(joint.start);
    if (count >= 8 && direction.lengthSq() > 1e-10) directions.set(joint, direction.normalize());
  }
  return directions;
}

function authoredClips(model: Object3D, joints: Joint[], id: number, kinds: readonly PokemonMotionKind[] = POKEMON_MOTION_KINDS, basePose: readonly PoseValue[] = []): AnimationClip[] {
  const shape = johtoRigShape(id), plan = pokemonBodyPlan(id, model.userData.pokemonFormIdentifier as string | undefined), size = new Box3().setFromObject(model, true).getSize(new Vector3());
  const roles = new Set(['hips', 'spine', 'neck', 'head', 'tail', 'leg', 'foot', 'legTip', 'arm', 'armTip', 'wing', 'wingTip', 'shell', 'shellTip', 'antenna', 'fin', 'finTip', 'leaf', 'leafTip']);
  const animated = joints.filter(joint => roles.has(joint.role));
  if (animated.length < 2) throw new Error(`Source skeleton ${id} needs an explicit motion mapping`);
  const stepping = isSteppingPlan(plan) ? steppingLimbs(model, animated, plan) : undefined;
  const step = isSteppingPlan(plan) ? STEPS[plan as keyof typeof STEPS] : undefined;
  // A skeleton authored for a static mesh has coarse skin weights that tear under deep flexes.
  const authoredSkeleton = animated.some(joint => joint.bone.name.startsWith(`CM_${id}_`));
  const swing = step && stepping ? Math.max(step.swing * .8, Math.min(authoredSkeleton ? .65 : .75, step.swing * Math.sqrt(.35 / stepping.hip))) : undefined;
  const knee = step ? step.knee * (authoredSkeleton ? .6 : 1) : 0;
  const armDirections = authoredSkeleton ? skinnedArmDirections(model, animated) : new Map<Joint, Vector3>();
  // Serpents and fish ripple along their body chain: each bone lags the one before it.
  const chainDepth = new Map<Joint, number>();
  if (plan === 'serpent' || plan === 'fish') for (const joint of animated) { let depth = 0; for (let bone = joint.bone.parent; bone instanceof Bone; bone = bone.parent) depth++; chainDepth.set(joint, depth); }
  return kinds.map(kind => {
    const duration = kind === 'idle' ? 2.4 : kind === 'walk' ? WALK_SECONDS : .65;
    const times = Array.from({ length: 25 }, (_, i) => i * duration / 24), tracks: Array<QuaternionKeyframeTrack | VectorKeyframeTrack> = [];
    for (const joint of animated) {
      const { bone, start, end, side, phase } = joint, limb = stepping?.limbs.get(joint);
      // A foreleg named as an arm steps as a leg; the rest of the body keeps its own role.
      const role = limb ? (limb.depth === 0 ? 'leg' : limb.depth === 1 ? 'foot' : 'legTip') : joint.role;
      const body = (plan === 'serpent' || plan === 'fish') && /^(spine|neck|tail|head)$/.test(role);
      const base = bone.quaternion.clone(), world = bone.getWorldQuaternion(new Quaternion());
      const upperArm = role === 'arm' && !/shoulder/i.test(bone.name);
      // Upper arms in many static source rigs are authored in a horizontal bind pose. Rotate
      // around world Z so idle/walk lower them toward the body instead of only swinging the
      // unchanged T pose around world Y. The side sign lowers both left and right arms.
      const bindDirection = (upperArm && armDirections.get(joint)?.clone()) || end.clone().sub(start).normalize();
      const down = new Vector3(0, -1, 0);
      const loweringAxis = bindDirection.clone().cross(down);
      if (loweringAxis.lengthSq() < 1e-8) loweringAxis.set(0, 0, 1);
      else loweringAxis.normalize();
      // A rippling body bends sideways: about the vertical, or about the forward axis where the chain stands upright.
      const ripple = body && kind === 'walk' ? (Math.abs(bindDirection.y) > .7 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0)) : undefined;
      const worldAxis = upperArm ? loweringAxis : ripple
        ?? new Vector3(role.startsWith('wing') || role.startsWith('fin') || role.startsWith('leaf') ? 0 : 1, role === 'tail' ? 1 : 0, role.startsWith('wing') || role.startsWith('fin') || role.startsWith('leaf') ? 1 : 0).normalize();
      const axis = worldAxis.applyQuaternion(world.clone().invert());
      // Rotate toward world-down from the actual bind segment. This also handles arms whose
      // source bind direction points mainly forward instead of along model X.
      const armRestAngle = Math.min(1.3, Math.acos(Math.max(-1, Math.min(1, bindDirection.dot(down)))) * .82);
      const values: number[] = [];
      for (const time of times) {
        const p = time / duration, loop = Math.sin(p * Math.PI * 2), gait = Math.sin(p * Math.PI * 2 + (side === 1 ? Math.PI : 0) + phase);
        let angle = 0;
        if (kind === 'idle') angle = upperArm ? armRestAngle + loop * .025 : ['head', 'neck'].includes(role) ? loop * .025 : role === 'spine' ? loop * .012 : role === 'tail' ? Math.sin(p * Math.PI * 2 + phase) * .065 : /wing|fin|leaf/.test(role) ? loop * .045 * (side || 1) : 0;
        if (kind === 'walk') {
          const cycle = p * Math.PI * 2;
          if (limb && step && swing) {
            // Positive hip angle carries the foot backward. A planted foot sweeps back at a constant rate; the swing
            // brings it forward with the knee lifted, so no foot ever slides forward over the ground.
            const u = ((p + limb.phase) % 1 + 1) % 1, stance = u < step.duty, s = stance ? 0 : (u - step.duty) / (1 - step.duty);
            // Every foot covers the hind feet's stride: a longer leg (a foreleg from the shoulder) swings through less angle.
            const reach = Math.asin(Math.min(.95, stepping!.hip * Math.sin(swing) / limb.reach));
            const hipAngle = stance ? reach * (2 * u / step.duty - 1) : reach * (1 - 2 * s * s * (3 - 2 * s)), lift = stance ? 0 : Math.sin(Math.PI * s);
            // Lower segments fold whichever way raises their tip: back for a shin that hangs down, up for a toe that points ahead.
            const raise = bindDirection.z > .05 ? -1 : 1;
            angle = limb.depth === 0 ? hipAngle : (limb.depth === 1 ? knee : knee * .5) * lift * raise;
          } else if (body) angle = (role === 'head' ? -.05 : role === 'neck' ? .04 : role === 'tail' ? .15 : .07) * Math.sin(cycle - (chainDepth.get(joint) ?? 0) * .8);
          // Flyers, floaters and fish do not step: whatever legs they have trail.
          else if (/^(leg|foot|legTip)$/.test(role)) angle = Math.sin(cycle + phase) * .06;
          else angle = upperArm ? armRestAngle * .92 + gait * .09 : /wing/.test(role) ? loop * .32 * side : /fin|leaf/.test(role) ? loop * .15 * side : /arm/.test(role) ? gait * -.16 : role === 'tail' ? Math.sin(cycle + phase) * .13 : role === 'spine' ? loop * .035 : role === 'head' ? -loop * .025 : 0;
        }
        if (kind === 'attack') angle = Math.sin(p * Math.PI) * (role === 'spine' ? .17 : /arm|wing|fin/.test(role) ? (authoredSkeleton ? -.18 : -.35) : role === 'head' ? .14 : role === 'tail' ? .18 : 0);
        if (kind === 'damage') angle = Math.sin(p * Math.PI) * (role === 'spine' ? -.12 : role === 'head' ? -.1 : /arm|wing/.test(role) ? .16 : /leg|foot|tail/.test(role) ? .07 * (side || 1) : 0);
        // Its coarse, connected shoulder mesh folds under large arm rotations.
        if (id === 195 && /arm/.test(role)) angle *= .18;
        if (role.startsWith('shell')) angle = loop * .025 * side;
        if (role === 'antenna') angle = Math.sin(p * Math.PI * 2 + phase) * (kind === 'walk' ? .025 : .012) * side;
        values.push(...base.clone().multiply(new Quaternion().setFromAxisAngle(axis, angle)).toArray());
      }
      tracks.push(new QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
    }
    const hips = animated.find(joint => joint.role === 'hips');
    if (hips && (plan === 'flyer' || plan === 'floater' || plan === 'fish' || shape === 'floatingPlant' || shape === 'glyph')) {
      const values: number[] = [], up = new Vector3(0, Math.max(size.y, .001) * .018, 0);
      // Translation tracks use the bone parent's local frame, including its scale.
      if (hips.bone.parent) up.applyMatrix4(hips.bone.parent.matrixWorld.clone().invert()).sub(new Vector3().applyMatrix4(hips.bone.parent.matrixWorld.clone().invert()));
      for (const time of times) values.push(...hips.bone.position.clone().addScaledVector(up, Math.sin(time / duration * Math.PI * 2)).toArray());
      tracks.push(new VectorKeyframeTrack(`${hips.bone.name}.position`, times, values));
    }
    // Vine Whip is optional attack geometry, fully extended in Chikorita's source bind pose.
    // Keep its chains retracted during these ordinary motions without altering that bind pose.
    if (id === 152) for (const { bone } of joints) if (/^[LR]Feeler01$/.test(bone.name)) {
      const scale = bone.scale.clone().multiplyScalar(.001).toArray();
      tracks.push(new VectorKeyframeTrack(`${bone.name}.scale`, [0, duration], [...scale, ...scale]));
    }
    // Hold every other bone at the source idle pose. Otherwise the mixer restores fingers, ears
    // and jaws to the bind pose whenever this clip replaces the source idle.
    const covered = new Set(tracks.map(track => track.name));
    for (const { track, property, value } of basePose) {
      if (covered.has(track)) continue;
      tracks.push(property === 'quaternion' ? new QuaternionKeyframeTrack(track, [0, duration], [...value, ...value]) : new VectorKeyframeTrack(track, [0, duration], [...value, ...value]));
    }
    const clip = new AnimationClip(`CM_${kind}`, duration, tracks);
    clip.userData.choketmonAuthored = REGIONAL_RIG_VERSION;
    // A planted foot travels 2 · hip · sin(swing) while it is down. Recording that speed lets playback step at the
    // rate that keeps it still under the moving body.
    if (kind === 'walk' && step && swing && stepping?.limbs.size) clip.userData[CLIP_GROUND_SPEED] = 2 * stepping.hip * Math.sin(swing) / (step.duty * duration);
    return clip;
  });
}

/**
 * Models face +Z standing on +Y. These sources were exported facing sideways or lying down (seen in
 * the model audit), keyed by form identifier or species id. Radians: pitch about X, then yaw about Y.
 */
export const SOURCE_ORIENTATION_FIXES: Readonly<Record<string, { pitch?: number; yaw?: number }>> = {
  503: { yaw: Math.PI / 2 }, // Samurott faced -X
  539: { yaw: -Math.PI / 2 }, // Sawk faced +X
  550: { yaw: -Math.PI / 2 }, // Basculin faced +X
  1007: { yaw: Math.PI / 2 }, // Koraidon faced -X
  1008: { yaw: Math.PI / 2 }, // Miraidon faced -X
  914: { pitch: Math.PI / 2 }, // Quaquaval lay flat, head toward -Z
};

/**
 * Game rips keep every swappable part as a `CusAnimVis_*` mesh (eye expressions A–F, folded and spread wings, shell
 * states) that the game shows one at a time; left visible together they overlap. Of each set only its A variants stay;
 * a set without an A (left and right parts) stays whole, and lone swaps that are effects or blink lids go.
 */
export function removeAlternateStates(scene: Object3D): string[] {
  const parts: Array<{ object: Object3D; base: string; variant: string; token: string }> = [];
  scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const token = /CusAnimVis_(?:pm\d+_\d+_\d+_)?(\w+?)Skin/.exec(`${object.name} ${object.geometry.name}`)?.[1];
    if (!token) return;
    const split = /^(.*?[a-z])([A-Z])(\d*(?:_\d+)*)$/.exec(token);
    parts.push({ object, token, base: split ? split[1] : token, variant: split ? split[2] : '' });
  });
  const removed = parts.filter(part => {
    const set = parts.filter(other => other.base === part.base);
    if (set.some(other => other.variant === 'A')) return part.variant !== 'A';
    return !part.variant && /^(?:Effect|Lid|Eyelid|Fire)$/.test(part.token);
  });
  for (const { object } of removed) object.removeFromParent();
  return removed.map(part => part.token);
}

/** Turns the source content under the template root, so rigging, clips and bounds all see the fixed frame. */
function orientSource(scene: Object3D, { pitch = 0, yaw = 0 }: { pitch?: number; yaw?: number }): void {
  const turn = new Group(); turn.name = 'CM_orientation';
  turn.rotation.set(pitch, yaw, 0, 'YXZ');
  for (const child of [...scene.children]) turn.add(child);
  scene.add(turn);
  scene.updateMatrixWorld(true);
  scene.userData.orientationFix = { version: REGIONAL_RIG_VERSION, pitch, yaw };
}

/** Called once on a loaded template, before per-creature skeleton cloning. No simulation RNG. */
export function prepareRegionalRig(gltf: Pick<GLTF, 'scene' | 'animations'>, id: number): void {
  if (id < 1 || id > 1025 || gltf.scene.userData.authoredRig || gltf.scene.userData.nativeMotion) return;
  applyHomeAuthoredAppearance(gltf.scene, id);
  // Quaquaval's source includes three visible LOD copies of a long battle-only water/gel
  // effect. It expands the character bounds to 16 units and makes the actual model render
  // as a tiny silhouette above a vertical chain. Keep the immutable source GLB intact and
  // omit only these named effect meshes from the runtime character template.
  if(id===911||id===914){const effects:Object3D[]=[];gltf.scene.traverse(object=>{const geometryName=object instanceof Mesh?object.geometry.name:'';if(id===914?/_gel_mesh(?:_shape)?(?:_lod\d+)?$/i.test(geometryName||object.name):/^(Object_210|Object_212)$/.test(object.name))effects.push(object);});for(const effect of effects)effect.removeFromParent();gltf.scene.userData.authoredModelCleanup={version:REGIONAL_RIG_VERSION,removedEffectNodes:effects.map(effect=>({node:effect.name,geometry:effect instanceof Mesh?effect.geometry.name:''})),reason:id===914?'battle-only-gel-effect-distorts-character-bounds':'duplicate-expanded-bird-effects-distort-character-silhouette'};}
  const alternates = removeAlternateStates(gltf.scene);
  if (alternates.length) gltf.scene.userData.alternateStatesRemoved = { version: REGIONAL_RIG_VERSION, parts: alternates };
  const orientation = SOURCE_ORIENTATION_FIXES[String(gltf.scene.userData.pokemonFormIdentifier ?? id)];
  if (orientation) orientSource(gltf.scene, orientation);
  let skinned = false; gltf.scene.traverse(object => { if (object instanceof SkinnedMesh) skinned = true; });
  const sourceClips = [...gltf.animations];
  let height: number | undefined;
  const modelHeight = () => height ??= (gltf.scene.updateMatrixWorld(true), Math.max(new Box3().setFromObject(gltf.scene, true).getSize(new Vector3()).y, 1e-6));
  // Looping walks and idles play in place; the world moves the creature.
  const loops = new Set([...pokemonMotionCandidates(sourceClips, 'walk'), ...pokemonMotionCandidates(sourceClips, 'idle')]);
  for (const clip of loops) if (clip.tracks.some(track => track.name.endsWith('.position'))) removeRootMotion(gltf.scene, clip, modelHeight());
  // Source clips stay in place for provenance. Frozen ones (bind-pose repeats) are flagged so
  // clip selection never lets them shadow an authored clip of the same kind.
  const measured = measureSourceClips(gltf.scene, sourceClips, modelHeight);
  const freeze = (all: boolean) => { for (const { clip, moving } of measured) if (all || !moving) clip.userData[STATIC_MOTION_CLIP] = true; };
  const frozenCount = () => sourceClips.filter(clip => clip.userData[STATIC_MOTION_CLIP] === true).length;
  const nativeMotion = measured.some(clip => clip.moving);
  let kinds: PokemonMotionKind[] = nativeMotion ? missingMotionKinds(measured) : [...POKEMON_MOTION_KINDS];
  // Deoxys, Machamp, Mr. Mime and the other listed sources use an authored skeleton instead of theirs.
  // Corsola's source has only a rigid waist influence; add actual leg/body joints.
  const reskin = !skinned || id === 222 || STATIC_NATIVE_CLIP_SPECIES.has(id);
  // Rigid node animation (Xurkitree, Kartana, Stakataka, Runerigus) drives mesh nodes directly.
  // Re-skinning would detach the meshes from the animated nodes, so it plays as-is when it walks.
  if (!skinned && nativeMotion && !kinds.includes('walk')) {
    freeze(false);
    gltf.scene.userData.nativeMotion = { version: REGIONAL_RIG_VERSION, speciesId: id, sourceClips: sourceClips.length, frozenSourceClips: frozenCount(), reason: 'native-transform-motion' };
    return;
  }
  if (!reskin && nativeMotion) {
    freeze(false);
    if (!kinds.length) {
      gltf.scene.userData.nativeMotion = { version: REGIONAL_RIG_VERSION, speciesId: id, sourceClips: sourceClips.length, frozenSourceClips: frozenCount(), reason: 'native-skinned-motion' };
      return;
    }
  }
  let sourceSkeleton = !reskin;
  // Authored companions of a moving source idle start from its first pose, so crossfades do not
  // snap the body back to the bind (often T) pose.
  const idle = sourceSkeleton && nativeMotion && !kinds.includes('idle') ? selectPokemonMotionClip(sourceClips, 'idle').clip : undefined;
  const basePose = idle ? clipStartPose(idle) : [];
  let restorePose = basePose.length ? applyPose(gltf.scene, basePose) : () => {};
  let joints: Joint[];
  let authored: AnimationClip[];
  try {
    joints = sourceSkeleton ? existingJoints(gltf.scene) : skinStaticModel(gltf.scene, id);
    const motionRoles = /^(hips|spine|neck|head|tail|leg|foot|arm|armTip|wing|wingTip|shell|shellTip|antenna|fin|finTip|leaf|leafTip)$/;
    if (sourceSkeleton && joints.filter(joint => motionRoles.test(joint.role)).length < 2) {
      restorePose(); restorePose = () => {};
      joints = skinStaticModel(gltf.scene, id); sourceSkeleton = false;
    }
    // A replacement skeleton detaches the source clips from the rendered skin.
    if (!sourceSkeleton) { freeze(true); kinds = [...POKEMON_MOTION_KINDS]; }
    authored = authoredClips(gltf.scene, joints, id, kinds, sourceSkeleton ? basePose : []);
  } finally {
    restorePose();
  }
  gltf.animations = [...sourceClips, ...authored];
  gltf.scene.userData.authoredRig = {
    version: JOHTO_RIG_VERSION,
    speciesId: id,
    sourceSkeleton,
    sourceClipsPreserved: sourceClips.length,
    frozenSourceClips: frozenCount(),
    authoredKinds: kinds,
    reason: !sourceClips.length ? 'missing-native-clips' : !sourceSkeleton ? 'replaced-source-skeleton' : nativeMotion ? 'missing-native-motion-kinds' : 'static-native-clips',
    joints: joints.length,
    shape: johtoRigShape(id),
  };
}

/** Backward-compatible entry point used by the shared GLTF loader. */
export const prepareJohtoRig = prepareRegionalRig;
