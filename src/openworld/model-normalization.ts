import { AnimationMixer, Box3, Group, Mesh, Object3D, SkinnedMesh, Vector3, type AnimationClip, type BufferGeometry } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { selectPokemonMotionClip } from '../data/model-motion';
import { normalizePokemonMaterials, type PokemonMaterialContext } from './pokemon-materials';

export type NormalizedPokemonModel = {
  visual: Group;
  animatedRoot: Object3D;
  sourceSize: Vector3;
  scale: number;
  grounding: ReadonlyMap<BufferGeometry, readonly number[]>;
};

type ModelProfile = { size: Vector3; origin: Vector3; grounding: ReadonlyMap<BufferGeometry, readonly number[]> };
const profiles = new WeakMap<Object3D, ModelProfile>();
const preparing = new WeakMap<Object3D, Promise<void>>();

function assertVisibleGeometry(model: Object3D): void {
  let renderable = false;
  model.traverseVisible(object => {
    if (!(object instanceof Mesh) || (object.geometry.getAttribute('position')?.count ?? 0) < 3 || object.geometry.drawRange.count < 3) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.some(material => material.visible && material.colorWrite && (!material.transparent || material.opacity > 0))) renderable = true;
  });
  if (!renderable) throw new Error('Pokemon model has no visible geometry');
}

/** Prepare each cached asset once, yielding between poses so new models do not stall input. */
export function preparePokemonModel(source: Object3D, animations: readonly AnimationClip[]): Promise<void> {
  try { assertVisibleGeometry(source); } catch (error) { return Promise.reject(error); }
  if (profiles.has(source)) return Promise.resolve();
  const pending = preparing.get(source);
  if (pending) return pending;
  const task = (async () => {
    const model = clone(source);
    try {
      const iterator = measureModel(model, animations);
      let step = iterator.next();
      while (!step.done) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        step = iterator.next();
      }
      profiles.set(source, step.value);
    } finally {
      const skeletons = new Set<SkinnedMesh['skeleton']>();
      model.traverse(object => { if (object instanceof SkinnedMesh) skeletons.add(object.skeleton); });
      skeletons.forEach(skeleton => skeleton.dispose());
      preparing.delete(source);
    }
  })();
  preparing.set(source, task);
  return task;
}

/** Keeps display scaling outside the hierarchy whose root scale may be keyed by a clip. */
export function normalizePokemonModel(
  model: Object3D,
  animations: readonly AnimationClip[],
  displayHeight: number,
  materialContext: PokemonMaterialContext = {},
  source: Object3D = model,
): NormalizedPokemonModel {
  assertVisibleGeometry(model);
  normalizePokemonMaterials(model, materialContext);
  // Creature LOD already bounds distance, frustum and instance count. Imported
  // skin bounds can remain at the bind pose after bones/root transforms move;
  // a second per-mesh cull can then hide the body while its HTML label survives.
  model.traverse(object => { if (object instanceof Mesh) object.frustumCulled = false; });
  let profile = profiles.get(source);
  if (!profile) {
    const iterator = measureModel(model, animations);
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    profile = step.value;
    profiles.set(source, profile);
  }
  model.position.sub(profile.origin);
  const height = Math.max(.05, displayHeight), size = profile.size;
  const scale = Math.min(height / Math.max(size.y, .001), height * 1.8 / Math.max(Math.hypot(size.x, size.z), .001));
  const visual = new Group();
  visual.scale.setScalar(scale);
  visual.add(model);
  visual.updateMatrixWorld(true);
  return { visual, animatedRoot: model, sourceSize: size.clone(), scale, grounding: profile.grounding };
}

function* measureModel(model: Object3D, animations: readonly AnimationClip[]): Generator<void, ModelProfile> {
  const idle = selectPokemonMotionClip(animations, 'idle').clip;
  const clips = [...new Set([idle, selectPokemonMotionClip(animations, 'walk').clip, selectPokemonMotionClip(animations, 'attack').clip].filter((clip): clip is AnimationClip => !!clip))];
  const skins: SkinnedMesh[] = [];
  model.traverse(object => { if (object instanceof SkinnedMesh) skins.push(object); });
  const meshes: Mesh[] = [];
  model.traverse(object => { if (object instanceof Mesh && object.geometry.getAttribute('position')) meshes.push(object); });
  const support = new Map<BufferGeometry, Set<number>>();
  const heights = meshes.map(mesh => new Float64Array(mesh.geometry.getAttribute('position').count));
  const vertex = new Vector3();
  const bounds = new Box3(), size = new Vector3(), poseSize = new Vector3();
  const measure = () => {
    model.updateMatrixWorld(true);
    for (const skin of skins) skin.skeleton.update();
    bounds.makeEmpty();
    meshes.forEach((mesh, index) => {
      const ys = heights[index];
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < ys.length; i++) {
        mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld);
        bounds.expandByPoint(vertex); ys[i] = vertex.y;
        minY = Math.min(minY, vertex.y); maxY = Math.max(maxY, vertex.y);
      }
      let candidates = support.get(mesh.geometry);
      if (!candidates) { candidates = new Set(); support.set(mesh.geometry, candidates); }
      // Keep the entire lower band of every sampled pose, including feet, fins and tails.
      const ceiling = minY + Math.max((maxY - minY) * .06, 1e-5);
      for (let i = 0; i < ys.length; i++) if (ys[i] <= ceiling) candidates.add(i);
    });
    size.max(bounds.getSize(poseSize));
  };
  const poseMixer = new AnimationMixer(model);
  // Coiled snakes and folded wings can expand several times beyond the idle bounds.
  // Size the display against all three gameplay clips, with skin matrices actually updated.
  for (const clip of clips) {
    poseMixer.stopAllAction();
    poseMixer.clipAction(clip).play();
    for (let frame = 0; frame < 8; frame++) { poseMixer.setTime(clip.duration * frame / 8); measure(); yield; }
  }
  poseMixer.stopAllAction();
  if (idle) { poseMixer.clipAction(idle).play(); poseMixer.setTime(0); }
  measure();
  const center = bounds.getCenter(new Vector3()), floor = bounds.min.y;
  poseMixer.stopAllAction();
  poseMixer.uncacheRoot(model);
  if (![size.x, size.y, size.z].every(Number.isFinite) || size.lengthSq() <= 0) throw new Error('Pokemon model bounds are invalid');

  return { size, origin: new Vector3(center.x, floor, center.z), grounding: new Map([...support].map(([geometry, indices]) => [geometry, [...indices]])) };
}
