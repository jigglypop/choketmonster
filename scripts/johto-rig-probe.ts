import { AnimationMixer, Bone, Box3, Color, DirectionalLight, HemisphereLight, Mesh, PerspectiveCamera, Quaternion, Scene, SkinnedMesh, Vector3, WebGLRenderer, type AnimationClip, type Object3D } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createGLTFLoader } from '../src/three/gltf-loader';
import { prepareJohtoRig } from '../src/three/johto-rig';
import { normalizePokemonModel } from '../src/openworld/model-normalization';
import { inspectAnimationDeformation } from './animation-deformation';

function inspectHumanoidArmPose(model: Object3D, animations: readonly AnimationClip[]) {
  const skinnedBones = new Set<Bone>();
  model.traverse(object => { if (object instanceof SkinnedMesh) for (const bone of object.skeleton.bones) skinnedBones.add(bone); });
  const upperArms: Bone[] = [];
  model.traverse(object => {
    if (!(object instanceof Bone) || !skinnedBones.has(object)) return;
    const name = object.name.toLowerCase();
    if (/shoulder|forearm|arm_02|lowerarm|roll|sub|hand|end/.test(name)) return;
    if (/^(l|r)arm(?:_|$)|^(left|right)_arm_01(?:_|$)|_(l|r)_arm$|^(l|r)_arm$/.test(name)) upperArms.push(object);
  });
  const descendants = (bone: Bone): Bone[] => {
    const found: Bone[] = [];
    bone.traverse(child => { if (child !== bone && child instanceof Bone) found.push(child); });
    return found;
  };
  const endFor = (bone: Bone) => descendants(bone).find(child => /forearm|arm_02|lowerarm/i.test(child.name))
    ?? bone.children.find(child => child instanceof Bone) as Bone | undefined;
  const arms = upperArms.flatMap(bone => { const end = endFor(bone); return end ? [{ bone, end }] : []; });
  const objects: Object3D[] = []; model.traverse(object => objects.push(object));
  const rest = objects.map(object => ({ object, position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() }));
  const restore = () => { for (const value of rest) { value.object.position.copy(value.position); value.object.quaternion.copy(value.quaternion); value.object.scale.copy(value.scale); } model.updateMatrixWorld(true); };
  const pose = (bone: Bone, end: Bone) => {
    const start = bone.getWorldPosition(new Vector3()), finish = end.getWorldPosition(new Vector3()), direction = finish.sub(start);
    const length = direction.length();
    return { verticalRatio: length ? direction.y / length : 0, quaternion: bone.getWorldQuaternion(new Quaternion()) };
  };
  restore();
  const bind = new Map(arms.map(({ bone, end }) => [bone, pose(bone, end)]));
  const mixer = new AnimationMixer(model);
  const result = ['idle', 'walk'].flatMap((kind, index) => {
    const clip = animations.find(candidate => new RegExp(kind === 'idle' ? 'idle|wait|stand' : 'walk|run', 'i').test(candidate.name))
      ?? animations[index] ?? animations[0];
    if (!clip) return [];
    const samples: Array<{ time: number; arms: Array<{ bone: string; verticalRatio: number; rotationFromBindRadians: number }> }> = [];
    mixer.stopAllAction(); restore(); mixer.clipAction(clip).play();
    for (const fraction of [.25, .5, .75]) {
      mixer.setTime(clip.duration * fraction); model.updateMatrixWorld(true);
      samples.push({ time: fraction, arms: arms.map(({ bone, end }) => { const value = pose(bone, end), initial = bind.get(bone)!; return { bone: bone.name, verticalRatio: value.verticalRatio, rotationFromBindRadians: initial.quaternion.angleTo(value.quaternion) }; }) });
    }
    return [{ kind, clip: clip.name, samples }];
  });
  mixer.stopAllAction(); mixer.uncacheRoot(model); restore();
  const flattened = result.flatMap(clip => clip.samples.flatMap(sample => sample.arms));
  const bothArmsLoweredInMultipleFrames = arms.length === 0 || result.every(clip =>
    clip.samples.filter(sample => sample.arms.length === arms.length && sample.arms.every(arm => arm.verticalRatio < -.28)).length >= 2,
  );
  return {
    arms: arms.map(({ bone }) => ({ bone: bone.name, bindVerticalRatio: bind.get(bone)!.verticalRatio })),
    clips: result,
    maxRotationFromBindRadians: flattened.length ? Math.max(...flattened.map(value => value.rotationFromBindRadians)) : 0,
    minimumVerticalRatio: flattened.length ? Math.min(...flattened.map(value => value.verticalRatio)) : null,
    hasLoweredOrBentMotion: flattened.some(value => value.verticalRatio < -.28 || value.rotationFromBindRadians > .35),
    bothArmsLoweredInMultipleFrames,
  };
}

/** Browser-only inspection of actual source bytes, deformation, and local GLB export. */
export async function probeJohtoRig(id: number, exportGlb = false, capturePoses = false) {
  const asset = await createGLTFLoader().loadAsync(`/rig-source/${id}.glb`);
  const excludedFromRuntime = (object: Object3D) => {
    const geometryName = object instanceof Mesh ? object.geometry.name : '';
    return id === 914 ? /_gel_mesh(?:_shape)?(?:_lod\d+)?$/i.test(geometryName || object.name)
      : id === 911 && /^(Object_210|Object_212)$/.test(object.name);
  };
  const before = new Box3(), originalClips = [...asset.animations], sourceClips = originalClips.length;
  const original: Vector3[] = [], point = new Vector3();
  asset.scene.updateMatrixWorld(true);
  asset.scene.traverse(object => {
    if (!(object instanceof Mesh) || excludedFromRuntime(object)) return;
    const positions = object.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const value = object.getVertexPosition(i, new Vector3()).applyMatrix4(object.matrixWorld);
      original.push(value); before.expandByPoint(value);
    }
  });
  const start = performance.now(); prepareJohtoRig(asset, id); const rigMs = performance.now() - start;
  let meshes = 0, vertices = 0, unweighted = 0, invalidWeights = 0, bindError = 0, index = 0;
  const skins: SkinnedMesh[] = [];
  asset.scene.updateMatrixWorld(true);
  asset.scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    meshes++;
    if (object instanceof SkinnedMesh) { skins.push(object); object.skeleton.update(); }
    const positions = object.geometry.getAttribute('position'), weights = object.geometry.getAttribute('skinWeight');
    for (let i = 0; i < positions.count; i++) {
      vertices++;
      if (weights) {
        const total = weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i);
        if (total < .001) unweighted++;
        if (!Number.isFinite(total) || Math.abs(total - 1) > .001) invalidWeights++;
      } else unweighted++;
      object.getVertexPosition(i, point).applyMatrix4(object.matrixWorld);
      if (!sourceClips) bindError = Math.max(bindError, point.distanceTo(original[index]));
      index++;
    }
  });
  const boundScale = Math.max(before.getSize(new Vector3()).length(), 1e-5);
  const sourceClipResults = originalClips.map(clip => inspectAnimationDeformation(asset.scene, clip, boundScale));
  const authoredClipResults = asset.animations.filter(clip => /^CM_/.test(clip.name)).map(clip => inspectAnimationDeformation(asset.scene, clip, boundScale));
  const humanoidArmPose = inspectHumanoidArmPose(asset.scene, asset.animations);
  const clipResults = sourceClips ? [...sourceClipResults, ...authoredClipResults] : authoredClipResults;
  const sourceAnimationPassed = sourceClipResults.length === sourceClips
    && sourceClipResults.every(clip => clip.finitePose && clip.nonFiniteSamples === 0)
    && sourceClipResults.some(clip => clip.changedSamples > 0);
  const authoredAnimationPassed = authoredClipResults.length === 4
    && authoredClipResults.every(clip => clip.finitePose && clip.nonFiniteSamples === 0 && clip.changedSamples > 0 && clip.relativeBounds < 1.6);
  const animationPassed = sourceClips
    ? sourceAnimationPassed || authoredAnimationPassed
    : authoredAnimationPassed;
  let binary: number[] | undefined;
  if (exportGlb && !sourceClips) {
    const result = await new GLTFExporter().parseAsync(asset.scene, { binary: true, animations: asset.animations });
    binary = [...new Uint8Array(result as ArrayBuffer)];
  }
  const normalized = normalizePokemonModel(asset.scene, asset.animations, 2);
  const scene = new Scene(); scene.background = new Color('#e4e9ef'); scene.add(normalized.visual);
  scene.add(new HemisphereLight('#ffffff', '#657282', 2.8));
  const light = new DirectionalLight('#ffffff', 3); light.position.set(-3, 5, 6); scene.add(light);
  const camera = new PerspectiveCamera(34, 1, .01, 40); camera.position.set(3.1, 2, 5.4); camera.lookAt(0, 1, 0);
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); renderer.setSize(360, 360);
  const animation = new AnimationMixer(normalized.animatedRoot);
  const idle = asset.animations.find(clip => /idle|wait|stand/i.test(clip.name)) ?? asset.animations[0];
  const walk = asset.animations.find(clip => /walk|run/i.test(clip.name)) ?? asset.animations[1] ?? idle;
  const renderPose = (clip?: AnimationClip, fraction = 0) => {
    animation.stopAllAction();
    if (clip) { animation.clipAction(clip).reset().play(); animation.setTime(clip.duration * fraction); }
    normalized.animatedRoot.updateMatrixWorld(true);
    renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png');
  };
  const poseImages = capturePoses ? { bind: renderPose(), idle: renderPose(idle, .25), walk: renderPose(walk, .25) } : undefined;
  const image = capturePoses ? poseImages!.walk : renderPose(walk, .25);
  animation.stopAllAction(); animation.uncacheRoot(normalized.animatedRoot);
  renderer.dispose(); renderer.forceContextLoss();
  asset.scene.traverse(object => { if (object instanceof Mesh) { object.geometry.dispose(); for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose(); } });
  return { id, sourceClips, authored: asset.scene.userData.authoredRig, appearance: asset.scene.userData.authoredAppearance, cleanup: asset.scene.userData.authoredModelCleanup, meshes, skinnedMeshes: skins.length, vertices, unweighted, invalidWeights,
    relativeBindError: bindError / boundScale, rigMs, clipResults, sourceClipResults, authoredClipResults, humanoidArmPose,
    sourceAnimationPassed, authoredAnimationPassed, animationPassed, image, poseImages, binary,
    passed: Boolean(skins.length && !unweighted && !invalidWeights && bindError / boundScale < .0001 && animationPassed),
  };
}
