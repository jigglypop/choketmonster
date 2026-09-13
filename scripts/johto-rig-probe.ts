import { AnimationMixer, Box3, Color, DirectionalLight, HemisphereLight, Mesh, PerspectiveCamera, Scene, SkinnedMesh, Vector3, WebGLRenderer } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createGLTFLoader } from '../src/three/gltf-loader';
import { prepareJohtoRig } from '../src/three/johto-rig';
import { normalizePokemonModel } from '../src/openworld/model-normalization';

/** Browser-only inspection of actual source bytes, deformation, and local GLB export. */
export async function probeJohtoRig(id: number, exportGlb = false) {
  const asset = await createGLTFLoader().loadAsync(`/rig-source/${id}.glb`);
  const before = new Box3().setFromObject(asset.scene, true), sourceClips = asset.animations.length;
  const original: Vector3[] = [], point = new Vector3();
  asset.scene.updateMatrixWorld(true);
  asset.scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const positions = object.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) original.push(object.getVertexPosition(i, new Vector3()).applyMatrix4(object.matrixWorld));
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
  const mixer = new AnimationMixer(asset.scene), clipResults = [];
  for (const clip of asset.animations.filter(clip => /^CM_/.test(clip.name))) {
    mixer.stopAllAction(); mixer.clipAction(clip).reset().play();
    const first: Vector3[] = [], animated = new Box3(); let changed = 0, maxDelta = 0;
    for (let frame = 0; frame <= 12; frame++) {
      mixer.setTime(clip.duration * frame / 12); asset.scene.updateMatrixWorld(true);
      let index = 0;
      for (const skin of skins) {
        skin.skeleton.update();
        for (let i = 0; i < skin.geometry.getAttribute('position').count; i += 13) {
          skin.getVertexPosition(i, point).applyMatrix4(skin.matrixWorld); animated.expandByPoint(point);
          if (frame === 0) first.push(point.clone());
          else { const delta = point.distanceTo(first[index]); if (delta > boundScale * .0001) changed++; maxDelta = Math.max(maxDelta, delta); }
          index++;
        }
      }
    }
    clipResults.push({ name: clip.name, changedSamples: changed, relativeMaxDelta: maxDelta / boundScale, relativeBounds: animated.getSize(new Vector3()).length() / boundScale });
  }
  mixer.stopAllAction(); mixer.uncacheRoot(asset.scene);
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
  const animation = new AnimationMixer(normalized.animatedRoot), walk = asset.animations.find(clip => /walk/i.test(clip.name)) ?? asset.animations[0];
  if (walk) { animation.clipAction(walk).play(); animation.setTime(walk.duration * .25); }
  renderer.render(scene, camera); const image = renderer.domElement.toDataURL('image/png');
  animation.stopAllAction(); animation.uncacheRoot(normalized.animatedRoot);
  renderer.dispose(); renderer.forceContextLoss();
  asset.scene.traverse(object => { if (object instanceof Mesh) { object.geometry.dispose(); for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose(); } });
  return { id, sourceClips, authored: asset.scene.userData.authoredRig, meshes, skinnedMeshes: skins.length, vertices, unweighted, invalidWeights,
    relativeBindError: bindError / boundScale, rigMs, clipResults, image, binary,
    passed: Boolean(skins.length && !unweighted && !invalidWeights && bindError / boundScale < .0001 && (sourceClips || clipResults.length === 4 && clipResults.every(clip => clip.changedSamples > 0 && clip.relativeBounds < 1.6))),
  };
}
