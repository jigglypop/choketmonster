import { AnimationMixer, Box3, Group, Object3D, SkinnedMesh, Vector3, type AnimationClip } from 'three';
import { normalizePokemonMaterials, type PokemonMaterialContext } from './pokemon-materials';

export type NormalizedPokemonModel = {
  visual: Group;
  animatedRoot: Object3D;
  sourceSize: Vector3;
  scale: number;
};

/** Keeps display scaling outside the hierarchy whose root scale may be keyed by a clip. */
export function normalizePokemonModel(
  model: Object3D,
  animations: readonly AnimationClip[],
  displayHeight: number,
  materialContext: PokemonMaterialContext = {},
): NormalizedPokemonModel {
  normalizePokemonMaterials(model, materialContext);
  const idle = animations.find(clip => /idle|wait|stand/i.test(clip.name)) ?? animations[0];
  const clips = [...new Set([idle, animations.find(clip => /walk|run/i.test(clip.name)), animations.find(clip => /attack|bite|skill/i.test(clip.name))].filter((clip): clip is AnimationClip => !!clip))];
  const skins: SkinnedMesh[] = [];
  model.traverse(object => { if (object instanceof SkinnedMesh) skins.push(object); });
  const bounds = new Box3(), size = new Vector3(), poseSize = new Vector3();
  const measure = () => {
    model.updateMatrixWorld(true);
    for (const skin of skins) skin.skeleton.update();
    bounds.setFromObject(model, true);
    size.max(bounds.getSize(poseSize));
  };
  const poseMixer = new AnimationMixer(model);
  // Coiled snakes and folded wings can expand several times beyond the idle bounds.
  // Size the display against all three gameplay clips, with skin matrices actually updated.
  for (const clip of clips) {
    poseMixer.stopAllAction();
    poseMixer.clipAction(clip).play();
    for (let frame = 0; frame < 8; frame++) { poseMixer.setTime(clip.duration * frame / 8); measure(); }
  }
  poseMixer.stopAllAction();
  if (idle) { poseMixer.clipAction(idle).play(); poseMixer.setTime(0); }
  measure();
  const center = bounds.getCenter(new Vector3()), floor = bounds.min.y;
  poseMixer.stopAllAction();
  poseMixer.uncacheRoot(model);
  if (![size.x, size.y, size.z].every(Number.isFinite) || size.lengthSq() <= 0) throw new Error('Pokemon model bounds are invalid');

  model.position.sub(new Vector3(center.x, floor, center.z));
  const height = Math.max(.05, displayHeight);
  const scale = Math.min(height / Math.max(size.y, .001), height * 1.8 / Math.max(Math.hypot(size.x, size.z), .001));
  const visual = new Group();
  visual.scale.setScalar(scale);
  visual.add(model);
  visual.updateMatrixWorld(true);
  return { visual, animatedRoot: model, sourceSize: size, scale };
}
