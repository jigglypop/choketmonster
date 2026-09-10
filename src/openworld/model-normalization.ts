import { AnimationMixer, Box3, Group, Object3D, Vector3, type AnimationClip } from 'three';

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
): NormalizedPokemonModel {
  const idle = animations.find(clip => /idle|wait|stand/i.test(clip.name)) ?? animations[0];
  if (idle) {
    const poseMixer = new AnimationMixer(model);
    poseMixer.clipAction(idle).play();
    poseMixer.setTime(0);
    model.updateMatrixWorld(true);
    poseMixer.stopAllAction();
    poseMixer.uncacheRoot(model);
  } else model.updateMatrixWorld(true);

  const bounds = new Box3().setFromObject(model, true);
  const size = bounds.getSize(new Vector3());
  const center = bounds.getCenter(new Vector3());
  if (![size.x, size.y, size.z].every(Number.isFinite) || size.lengthSq() <= 0) throw new Error('Pokemon model bounds are invalid');

  model.position.sub(new Vector3(center.x, bounds.min.y, center.z));
  const height = Math.max(.05, displayHeight);
  const scale = Math.min(height / Math.max(size.y, .001), height * 2.15 / Math.max(size.x, size.z, .001));
  const visual = new Group();
  visual.scale.setScalar(scale);
  visual.add(model);
  visual.updateMatrixWorld(true);
  return { visual, animatedRoot: model, sourceSize: size, scale };
}
