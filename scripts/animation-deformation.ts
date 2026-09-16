import { AnimationClip, AnimationMixer, Box3, Object3D, SkinnedMesh, Vector3 } from 'three';

export interface AnimationDeformationResult {
  name: string;
  duration: number;
  tracks: number;
  dynamicTracks: string[];
  sampledVertices: number;
  changedSamples: number;
  nonFiniteSamples: number;
  finitePose: boolean;
  relativeMaxDelta: number;
  relativeBounds: number;
}

const SAMPLE_FRAMES = 13;
const MAX_SAMPLES_PER_MESH = 256;

function matricesAreFinite(root: Object3D): boolean {
  let finite = true;
  root.traverse(object => {
    if (!object.matrixWorld.elements.every(Number.isFinite)) finite = false;
    if (object instanceof SkinnedMesh) {
      object.skeleton.update();
      if (!Array.from(object.skeleton.boneMatrices).every(Number.isFinite)) finite = false;
    }
  });
  return finite;
}

/** Samples skinned vertex positions before object transforms, so rigid root motion cannot pass as deformation. */
export function inspectAnimationDeformation(
  root: Object3D,
  clip: AnimationClip,
  boundScale: number,
): AnimationDeformationResult {
  const mixer = new AnimationMixer(root);
  const dynamicTracks = clip.tracks.filter(track => {
    const valueSize = track.getValueSize();
    for (let offset = valueSize; offset < track.values.length; offset++) {
      if (Math.abs(Number(track.values[offset]) - Number(track.values[offset % valueSize])) > 1e-7) return true;
    }
    return false;
  }).map(track => track.name);
  const firstFrame: Vector3[] = [];
  const animatedBounds = new Box3();
  const point = new Vector3();
  let changedSamples = 0;
  let maxDelta = 0;
  let nonFiniteSamples = 0;
  let sampledVertices = 0;
  let finitePose = Number.isFinite(clip.duration) && clip.duration >= 0;

  try {
    mixer.clipAction(clip).reset().play();
    for (let frame = 0; frame < SAMPLE_FRAMES; frame++) {
      mixer.setTime(clip.duration * frame / (SAMPLE_FRAMES - 1));
      root.updateMatrixWorld(true);
      finitePose &&= matricesAreFinite(root);
      let sampleIndex = 0;
      root.traverse(object => {
        if (!(object instanceof SkinnedMesh)) return;
        const positions = object.geometry.getAttribute('position');
        const stride = Math.max(1, Math.ceil(positions.count / MAX_SAMPLES_PER_MESH));
        for (let vertex = 0; vertex < positions.count; vertex += stride) {
          object.getVertexPosition(vertex, point);
          const pointIsFinite = Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
          if (!pointIsFinite) {
            nonFiniteSamples++;
            finitePose = false;
          } else {
            animatedBounds.expandByPoint(point.clone().applyMatrix4(object.matrixWorld));
            if (frame === 0) firstFrame.push(point.clone());
            else {
              const delta = point.distanceTo(firstFrame[sampleIndex]);
              if (!Number.isFinite(delta)) {
                nonFiniteSamples++;
                finitePose = false;
              } else {
                if (delta > boundScale * .0001) changedSamples++;
                maxDelta = Math.max(maxDelta, delta);
              }
            }
          }
          if (frame === 0 && !pointIsFinite) firstFrame.push(new Vector3(Number.NaN, Number.NaN, Number.NaN));
          sampleIndex++;
          if (frame === 0) sampledVertices++;
        }
      });
    }
  } finally {
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
  }

  const boundsSize = animatedBounds.isEmpty() ? Number.POSITIVE_INFINITY : animatedBounds.getSize(new Vector3()).length();
  return {
    name: clip.name,
    duration: clip.duration,
    tracks: clip.tracks.length,
    dynamicTracks,
    sampledVertices,
    changedSamples,
    nonFiniteSamples,
    finitePose,
    relativeMaxDelta: maxDelta / boundScale,
    relativeBounds: boundsSize / boundScale,
  };
}
