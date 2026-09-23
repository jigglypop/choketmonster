import {
  AnimationClip, Bone, Box3, BufferAttribute, BufferGeometry, DataTexture, Mesh, MeshStandardMaterial,
  NearestFilter, Object3D, PropertyBinding, Quaternion, QuaternionKeyframeTrack, RGBAFormat, Skeleton, SkinnedMesh,
  SRGBColorSpace, Vector3, VectorKeyframeTrack, type KeyframeTrack,
} from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { HOME_AUTHORED_PALETTES } from '../data/pokemon-home-authored-palettes';
import { POKEMON_MOTION_KINDS, STATIC_MOTION_CLIP, selectPokemonMotionClip, type PokemonMotionKind } from '../data/model-motion';
import { isMovingClipMotion, missingMotionKinds, summarizeClipMotion, type KeyframeSample } from './clip-motion';

/** Authored articulation, separate from the immutable source models and their clips.
 * v5: source clips are measured; frozen ones are flagged and every missing motion kind is authored. */
export const REGIONAL_RIG_VERSION = 'regional-authored-v5';
export const JOHTO_RIG_VERSION = REGIONAL_RIG_VERSION;
// Deoxys' source GLB contains one ArmatureAction whose 402 tracks repeat their bind-pose values.
// Preserve that source clip for provenance, and append authored motion so the runtime can animate it.
export const STATIC_NATIVE_CLIP_SPECIES: ReadonlySet<number> = new Set([68,122,386,794,796,798,802,805,914]);
type Shape = 'biped' | 'quadruped' | 'bird' | 'winged' | 'fish' | 'plant' | 'floatingPlant' | 'glyph' | 'serpent' | 'soft';
type Joint = { bone: Bone; start: Vector3; end: Vector3; role: string; side: number; phase: number };
const groups: Record<Exclude<Shape, 'biped'>, number[]> = {
  quadruped: [152,153,154,155,156,157,162,179,196,197,203,213,220,221,222,228,229,231,232,234,243,244,245,261,262,263,264,273,274,287,288,289,293,294,295,300,301,304,305,306,309,310,322,323,352,359,371,372,373,377,378,379,387,388,389,399,400,403,404,405,408,409,410,417,427,428,431,432,434,435,443,444,445,446,447,448,449,450,459,460,461,464,465,466,467,470,471,473,495,496,497,498,499,500,504,505,506,507,508,509,510,522,523,524,525,526,529,530,551,552,553,554,555,559,560,585,586,613,614,626,631,632,633,634,638,639,640,643,644,645],
  bird: [163,164,177,178,198,225,227,250,276,277,333,334,396,397,398,441,519,520,521,561,580,581,627,628,629,630],
  winged: [165,166,167,168,169,176,188,189,193,207,214,249,267,269,278,279,283,284,290,291,313,314,329,330,414,415,416,455,469,472,527,528,566,567,587,588,595,596,616,617,636,637],
  fish: [170,171,211,223,224,226,230,318,319,320,321,339,340,349,366,367,368,369,370,382,418,419,456,457,458,484,489,490,535,536,537,550,564,565,592,593,594,602,603,604],
  plant: [185,191,192,252,253,254,273,274,275,285,286,315,331,332,345,346,357,406,407,420,421,455,459,460,465,470,492,511,512,513,514,515,516,546,547,548,549,556,557,558,590,591,597,598,640],
  floatingPlant: [187],
  glyph: [201],
  serpent: [206,208,336,350,384,487,545,621,635],
  soft: [200,204,205,218,219,292,302,316,317,325,326,351,353,354,355,356,358,360,361,362,363,364,365,380,381,385,386,422,423,425,426,429,433,442,477,478,479,480,481,482,488,491,493,517,518,562,563,577,578,579,582,583,584,605,606,607,608,609,610],
};
export const johtoRigShape = (id: number): Shape => (Object.entries(groups).find(([, ids]) => ids.includes(id))?.[0] ?? 'biped') as Shape;

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

const LEG_SEGMENT = /thigh|upleg|crotch|leg|knee|calf|shin|foot|ankle/;
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
  const role = /hand|forearm|arm_02|lowerarm/.test(lower) ? 'armTip' : /arm|shoulder/.test(lower) ? 'arm'
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
      bone.traverse(child => { if (child !== bone && child instanceof Bone && /forearm|arm_02|lowerarm/i.test(child.name) && !endpoint?.name.match(/forearm|arm_02|lowerarm/i)) endpoint = child; });
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
function measureSourceClips(root: Object3D, clips: readonly AnimationClip[]): Array<{ clip: AnimationClip; name: string; moving: boolean }> {
  let height: number | undefined;
  const scales = new Map<string, number>();
  const translationScale = (trackName: string) => {
    const nodeName = PropertyBinding.parseTrackName(trackName).nodeName;
    let scale = scales.get(nodeName);
    if (scale === undefined) {
      if (height === undefined) { root.updateMatrixWorld(true); height = Math.max(new Box3().setFromObject(root, true).getSize(new Vector3()).y, 1e-6); }
      const parent = (PropertyBinding.findNode(root, nodeName) as Object3D | undefined)?.parent;
      const world = parent ? parent.getWorldScale(new Vector3()) : new Vector3(1, 1, 1);
      scale = Math.max(Math.abs(world.x), Math.abs(world.y), Math.abs(world.z)) / height;
      scales.set(nodeName, scale);
    }
    return scale;
  };
  return clips.map(clip => ({ clip, name: clip.name, moving: isMovingClipMotion(summarizeClipMotion(motionSamples(clip), translationScale)) }));
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

function authoredClips(model: Object3D, joints: Joint[], id: number, kinds: readonly PokemonMotionKind[] = POKEMON_MOTION_KINDS, basePose: readonly PoseValue[] = []): AnimationClip[] {
  const shape = johtoRigShape(id), size = new Box3().setFromObject(model, true).getSize(new Vector3());
  const roles = new Set(['hips', 'spine', 'neck', 'head', 'tail', 'leg', 'foot', 'arm', 'armTip', 'wing', 'wingTip', 'shell', 'shellTip', 'antenna', 'fin', 'finTip', 'leaf', 'leafTip']);
  const animated = joints.filter(joint => roles.has(joint.role));
  if (animated.length < 2) throw new Error(`Source skeleton ${id} needs an explicit motion mapping`);
  return kinds.map(kind => {
    const duration = kind === 'idle' ? 2.4 : kind === 'walk' ? .9 : .65;
    const times = Array.from({ length: 25 }, (_, i) => i * duration / 24), tracks: Array<QuaternionKeyframeTrack | VectorKeyframeTrack> = [];
    for (const { bone, start, end, role, side, phase } of animated) {
      const base = bone.quaternion.clone(), world = bone.getWorldQuaternion(new Quaternion());
      const upperArm = role === 'arm' && !/shoulder/i.test(bone.name);
      // Upper arms in many static source rigs are authored in a horizontal bind pose. Rotate
      // around world Z so idle/walk lower them toward the body instead of only swinging the
      // unchanged T pose around world Y. The side sign lowers both left and right arms.
      const bindDirection = end.clone().sub(start).normalize();
      const down = new Vector3(0, -1, 0);
      const loweringAxis = bindDirection.clone().cross(down);
      if (loweringAxis.lengthSq() < 1e-8) loweringAxis.set(0, 0, 1);
      else loweringAxis.normalize();
      const worldAxis = upperArm ? loweringAxis
        : new Vector3(role.startsWith('wing') || role.startsWith('fin') || role.startsWith('leaf') ? 0 : 1, role === 'tail' ? 1 : 0, role.startsWith('wing') || role.startsWith('fin') || role.startsWith('leaf') ? 1 : 0).normalize();
      const axis = worldAxis.applyQuaternion(world.clone().invert());
      // Rotate toward world-down from the actual bind segment. This also handles arms whose
      // source bind direction points mainly forward instead of along model X.
      const armRestAngle = Math.min(1.3, Math.acos(Math.max(-1, Math.min(1, bindDirection.dot(down)))) * .82);
      const values: number[] = [];
      for (const time of times) {
        const p = time / duration, loop = Math.sin(p * Math.PI * 2), gait = Math.sin(p * Math.PI * 2 + (side === 1 ? Math.PI : 0) + phase);
        let angle = 0;
        if (kind === 'idle') angle = upperArm ? armRestAngle + loop * .025 : ['head', 'neck'].includes(role) ? loop * .025 : role === 'spine' ? loop * .012 : role === 'tail' ? Math.sin(p * Math.PI * 2 + phase) * .065 : /wing|fin|leaf/.test(role) ? loop * .045 * (side || 1) : 0;
        if (kind === 'walk') angle = upperArm ? armRestAngle * .92 + gait * .09 : role === 'leg' ? gait * .27 : role === 'foot' ? Math.max(0, gait) * -.22 : /wing/.test(role) ? loop * .32 * side : /fin|leaf/.test(role) ? loop * .15 * side : /arm/.test(role) ? gait * -.16 : role === 'tail' ? Math.sin(p * Math.PI * 2 + phase) * .13 : role === 'spine' ? loop * .035 : role === 'head' ? -loop * .025 : 0;
        if (kind === 'attack') angle = Math.sin(p * Math.PI) * (role === 'spine' ? .17 : /arm|wing|fin/.test(role) ? -.35 : role === 'head' ? .14 : role === 'tail' ? .18 : 0);
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
    if (hips && ['bird', 'winged', 'fish', 'soft', 'floatingPlant', 'glyph'].includes(shape)) {
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
    return clip;
  });
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
  let skinned = false; gltf.scene.traverse(object => { if (object instanceof SkinnedMesh) skinned = true; });
  const sourceClips = [...gltf.animations];
  // Source clips stay in place for provenance. Frozen ones (bind-pose repeats) are flagged so
  // clip selection never lets them shadow an authored clip of the same kind.
  const measured = measureSourceClips(gltf.scene, sourceClips);
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
