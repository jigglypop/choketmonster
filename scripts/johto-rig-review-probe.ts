import * as THREE from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { createGLTFLoader } from '../src/three/gltf-loader';
import { prepareJohtoRig } from '../src/three/johto-rig';
import { normalizePokemonModel } from '../src/openworld/model-normalization';

/** Browser-only source/composed-animation comparison used by the review CLI. */
export async function reviewJohtoRig(speciesId: number) {
  const sourceAsset = await createGLTFLoader().loadAsync(`/rig-source/${speciesId}.glb`);
  const asset = await createGLTFLoader().loadAsync(`/rig-source/${speciesId}.glb`);
  const sourceClipSignature = asset.animations.map(clip => ({ name: clip.name, duration: clip.duration, tracks: clip.tracks.length }));
  const sourceBounds = new THREE.Box3().setFromObject(sourceAsset.scene, true);
  const sourceSize = sourceBounds.getSize(new THREE.Vector3()).max(new THREE.Vector3(1e-6, 1e-6, 1e-6));
  const sourceCenter = sourceBounds.getCenter(new THREE.Vector3());
  type SourceComponent = { vertices: number; weldedVertices: number; triangles: number; materials: string[]; center: number[]; size: number[] };
  const sourceParts: Array<{ name: string; vertices: number; skinned: boolean; center: number[]; size: number[]; components: SourceComponent[] }> = [];
  const sourceBones: string[] = [];
  sourceAsset.scene.updateMatrixWorld(true);
  sourceAsset.scene.traverse(object => {
    if ((object as THREE.Bone).isBone) sourceBones.push(object.name);
    if (!(object as THREE.Mesh).isMesh) return;
    const mesh = object as THREE.Mesh;
    const bounds = new THREE.Box3().setFromObject(mesh, true);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.index;
    const parents = Array.from({ length: position.count }, (_, i) => i);
    const positionKeys: string[] = [];
    const find = (value: number): number => parents[value] === value ? value : (parents[value] = find(parents[value]));
    const unite = (a: number, b: number) => { const rootA = find(a), rootB = find(b); if (rootA !== rootB) parents[rootB] = rootA; };
    const welded = new Map<string, number>();
    for (let i = 0; i < position.count; i++) {
      const key = `${position.getX(i).toPrecision(7)},${position.getY(i).toPrecision(7)},${position.getZ(i).toPrecision(7)}`;
      positionKeys.push(key);
      const prior = welded.get(key);
      if (prior === undefined) welded.set(key, i); else unite(i, prior);
    }
    const triangleCount = (index?.count ?? position.count) / 3;
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      const a = index?.getX(triangle * 3) ?? triangle * 3;
      const b = index?.getX(triangle * 3 + 1) ?? triangle * 3 + 1;
      const c = index?.getX(triangle * 3 + 2) ?? triangle * 3 + 2;
      unite(a, b); unite(b, c);
    }
    const componentData = new Map<number, { vertices: Set<number>; weldedVertices: Set<string>; triangles: number; materialIndexes: Set<number>; bounds: THREE.Box3 }>();
    const groups = mesh.geometry.groups;
    const materialNames = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((material, i) => material.name || `material-${i}`);
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      const ids = [index?.getX(triangle * 3) ?? triangle * 3, index?.getX(triangle * 3 + 1) ?? triangle * 3 + 1, index?.getX(triangle * 3 + 2) ?? triangle * 3 + 2];
      const root = find(ids[0]);
      let component = componentData.get(root);
      if (!component) {
        component = { vertices: new Set(), weldedVertices: new Set(), triangles: 0, materialIndexes: new Set(), bounds: new THREE.Box3() };
        componentData.set(root, component);
      }
      component.triangles++;
      const offset = triangle * 3;
      const group = groups.find(candidate => offset >= candidate.start && offset < candidate.start + candidate.count);
      component.materialIndexes.add(group?.materialIndex ?? 0);
      for (const id of ids) {
        component.vertices.add(id);
        component.weldedVertices.add(positionKeys[id]);
        component.bounds.expandByPoint(new THREE.Vector3(position.getX(id), position.getY(id), position.getZ(id)).applyMatrix4(mesh.matrixWorld));
      }
    }
    const components = [...componentData.values()].map(component => {
      const componentCenter = component.bounds.getCenter(new THREE.Vector3()).sub(sourceCenter).divide(sourceSize);
      const componentSize = component.bounds.getSize(new THREE.Vector3()).divide(sourceSize);
      return {
        vertices: component.vertices.size,
        weldedVertices: component.weldedVertices.size,
        triangles: component.triangles,
        materials: [...component.materialIndexes].map(index => materialNames[index] ?? `material-${index}`),
        center: componentCenter.toArray(),
        size: componentSize.toArray(),
      };
    }).sort((a, b) => b.triangles - a.triangles);
    sourceParts.push({
      name: mesh.name,
      vertices: mesh.geometry.getAttribute('position').count,
      skinned: Boolean((mesh as THREE.SkinnedMesh).isSkinnedMesh),
      center: center.sub(sourceCenter).divide(sourceSize).toArray(),
      size: size.divide(sourceSize).toArray(),
      components,
    });
  });
  prepareJohtoRig(asset, speciesId);
  const preparedClipSignature = asset.animations.map(clip => ({ name: clip.name, duration: clip.duration, tracks: clip.tracks.length }));

  const collectSkins = (root: THREE.Object3D) => {
    const skins: THREE.SkinnedMesh[] = [];
    root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) skins.push(object as THREE.SkinnedMesh); });
    return skins;
  };
  const sampledVertices = (root: THREE.Object3D) => {
    root.updateMatrixWorld(true);
    const values: number[] = [];
    const point = new THREE.Vector3();
    for (const skin of collectSkins(root)) {
      skin.skeleton.update();
      const count = skin.geometry.getAttribute('position').count;
      for (let index = 0; index < count; index += 23) {
        skin.getVertexPosition(index, point).applyMatrix4(skin.matrixWorld);
        values.push(point.x, point.y, point.z);
      }
    }
    return values;
  };
  const maxDelta = (a: number[], b: number[]) => {
    let maximum = 0;
    for (let index = 0; index < Math.min(a.length, b.length); index += 3) {
      maximum = Math.max(maximum, Math.hypot(a[index] - b[index], a[index + 1] - b[index + 1], a[index + 2] - b[index + 2]));
    }
    return maximum;
  };

  const cloneA = clone(asset.scene);
  const cloneB = clone(asset.scene);
  const skinsA = collectSkins(cloneA);
  const skinsB = collectSkins(cloneB);
  const bonesA = new Set(skinsA.flatMap(skin => skin.skeleton.bones));
  const bonesB = new Set(skinsB.flatMap(skin => skin.skeleton.bones));
  const sharedBones = [...bonesA].filter(bone => bonesB.has(bone)).length;
  const sharedSkeletons = skinsA.filter((skin, index) => skin.skeleton === skinsB[index]?.skeleton).length;
  const aBefore = sampledVertices(cloneA);
  const bBefore = sampledVertices(cloneB);
  const walk = asset.animations.find(clip => /walk|run/i.test(clip.name)) ?? asset.animations[1] ?? asset.animations[0];
  const independenceMixer = new THREE.AnimationMixer(cloneA);
  if (walk) { independenceMixer.clipAction(walk).play(); independenceMixer.setTime(walk.duration * .25); }
  const aAfter = sampledVertices(cloneA);
  const bAfter = sampledVertices(cloneB);
  const sourceScale = Math.max(new THREE.Box3().setFromObject(asset.scene, true).getSize(new THREE.Vector3()).length(), 1e-6);
  const cloneIndependence = {
    skinsA: skinsA.length,
    skinsB: skinsB.length,
    sharedBones,
    sharedSkeletons,
    relativeMotionA: maxDelta(aBefore, aAfter) / sourceScale,
    relativeMotionB: maxDelta(bBefore, bAfter) / sourceScale,
  };
  independenceMixer.stopAllAction();
  independenceMixer.uncacheRoot(cloneA);

  const deformationModel = clone(asset.scene);
  const deformationSkins = collectSkins(deformationModel);
  const deformationClips = {
    walk: asset.animations.find(clip => /walk|run/i.test(clip.name)) ?? asset.animations[1] ?? asset.animations[0],
    attack: asset.animations.find(clip => /attack|bite|skill/i.test(clip.name)) ?? asset.animations[2] ?? asset.animations[0],
  };
  const deformationMixer = new THREE.AnimationMixer(deformationModel);
  const bindTriangles = new Map<string, [THREE.Vector3, THREE.Vector3, THREE.Vector3]>();
  const readTriangle = (skin: THREE.SkinnedMesh, triangle: number): [THREE.Vector3, THREE.Vector3, THREE.Vector3] => {
    const geometryIndex = skin.geometry.index;
    return [0, 1, 2].map(offset => {
      const vertex = geometryIndex?.getX(triangle * 3 + offset) ?? triangle * 3 + offset;
      return skin.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(skin.matrixWorld);
    }) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  };
  deformationModel.updateMatrixWorld(true);
  for (const [skinIndex, skin] of deformationSkins.entries()) {
    skin.skeleton.update();
    const triangles = (skin.geometry.index?.count ?? skin.geometry.getAttribute('position').count) / 3;
    for (let triangle = 0; triangle < triangles; triangle++) bindTriangles.set(`${skinIndex}:${triangle}`, readTriangle(skin, triangle));
  }
  const deformationOutliers: Array<{ action: string; phase: number; mesh: string; triangle: number; relativeEdgeStretch: number; center: number[]; influences: string[][] }> = [];
  for (const [action, clip] of Object.entries(deformationClips)) {
    if (!clip) continue;
    deformationMixer.stopAllAction();
    deformationMixer.clipAction(clip).reset().play();
    for (const phase of [.25, .5, .75]) {
      deformationMixer.setTime(clip.duration * phase);
      deformationModel.updateMatrixWorld(true);
      for (const [skinIndex, skin] of deformationSkins.entries()) {
        skin.skeleton.update();
        const geometryIndex = skin.geometry.index;
        const skinIndexAttribute = skin.geometry.getAttribute('skinIndex');
        const skinWeightAttribute = skin.geometry.getAttribute('skinWeight');
        const triangles = (geometryIndex?.count ?? skin.geometry.getAttribute('position').count) / 3;
        for (let triangle = 0; triangle < triangles; triangle++) {
          const before = bindTriangles.get(`${skinIndex}:${triangle}`)!;
          const after = readTriangle(skin, triangle);
          let relativeEdgeStretch = 1;
          for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
            relativeEdgeStretch = Math.max(relativeEdgeStretch, after[a].distanceTo(after[b]) / Math.max(before[a].distanceTo(before[b]), 1e-8));
          }
          if (relativeEdgeStretch < 1.05) continue;
          const vertexIds = [0, 1, 2].map(offset => geometryIndex?.getX(triangle * 3 + offset) ?? triangle * 3 + offset);
          const influences = vertexIds.map(vertex => [0, 1, 2, 3].flatMap(channel => {
            const weight = [skinWeightAttribute.getX(vertex), skinWeightAttribute.getY(vertex), skinWeightAttribute.getZ(vertex), skinWeightAttribute.getW(vertex)][channel];
            const boneIndex = [skinIndexAttribute.getX(vertex), skinIndexAttribute.getY(vertex), skinIndexAttribute.getZ(vertex), skinIndexAttribute.getW(vertex)][channel];
            return weight > .001 ? [`${skin.skeleton.bones[boneIndex]?.name ?? boneIndex}:${weight.toFixed(3)}`] : [];
          }));
          const center = after[0].clone().add(after[1]).add(after[2]).multiplyScalar(1 / 3).sub(sourceCenter).divide(sourceSize).toArray();
          deformationOutliers.push({ action, phase, mesh: skin.name, triangle, relativeEdgeStretch, center, influences });
        }
      }
    }
  }
  deformationMixer.stopAllAction();
  deformationMixer.uncacheRoot(deformationModel);
  deformationOutliers.sort((a, b) => b.relativeEdgeStretch - a.relativeEdgeStretch);
  deformationOutliers.splice(20);
  const maxRelativeEdgeStretch = deformationOutliers[0]?.relativeEdgeStretch ?? 1;
  const deformationLimit = speciesId === 195 ? 2.5 : null;

  const actionClips = {
    idle: asset.animations.find(clip => /idle|wait|stand/i.test(clip.name)) ?? asset.animations[0],
    walk: asset.animations.find(clip => /walk|run/i.test(clip.name)) ?? asset.animations[1] ?? asset.animations[0],
    attack: asset.animations.find(clip => /attack|bite|skill/i.test(clip.name)) ?? asset.animations[2] ?? asset.animations[0],
  };
  const sourceWalk = sourceAsset.animations.find(clip => /walk|run/i.test(clip.name)) ?? sourceAsset.animations[1] ?? sourceAsset.animations[0];
  const phases = [0, .25, .5, .75];
  const tileWidth = 300;
  const tileHeight = 300;
  const panel = document.createElement('canvas');
  panel.width = tileWidth * phases.length;
  panel.height = tileHeight * 4;
  const context = panel.getContext('2d', { alpha: false });
  if (!context) throw new Error('2D canvas context unavailable');
  context.fillStyle = '#e4e9ef';
  context.fillRect(0, 0, panel.width, panel.height);
  const poseMetrics: Array<{ action: string; phase: number; bounds: number[]; finite: boolean }> = [];
  const rows = [
    { label: 'source', template: sourceAsset.scene, animations: sourceAsset.animations, clip: sourceWalk },
    { label: 'idle', template: asset.scene, animations: asset.animations, clip: actionClips.idle },
    { label: 'walk', template: asset.scene, animations: asset.animations, clip: actionClips.walk },
    { label: 'attack', template: asset.scene, animations: asset.animations, clip: actionClips.attack },
  ];
  for (const [row, entry] of rows.entries()) {
    for (const [column, phase] of phases.entries()) {
      const model = clone(entry.template);
      const normalized = normalizePokemonModel(model, entry.animations, 1.65);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#e4e9ef');
      scene.add(normalized.visual);
      scene.add(new THREE.HemisphereLight('#ffffff', '#657282', 2.8));
      const light = new THREE.DirectionalLight('#ffffff', 3);
      light.position.set(-3, 5, 6);
      scene.add(light);
      const camera = new THREE.PerspectiveCamera(34, 1, .01, 40);
      camera.position.set(3.1, 2, 5.4);
      camera.lookAt(0, .85, 0);
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setPixelRatio(1);
      renderer.setSize(tileWidth, tileHeight, false);
      const mixer = new THREE.AnimationMixer(normalized.animatedRoot);
      if (entry.clip) { mixer.clipAction(entry.clip).play(); mixer.setTime(entry.clip.duration * phase); }
      normalized.visual.updateMatrixWorld(true);
      for (const skin of collectSkins(normalized.visual)) skin.skeleton.update();
      const bounds = new THREE.Box3().setFromObject(normalized.visual, true);
      const values = [...bounds.min.toArray(), ...bounds.max.toArray()];
      poseMetrics.push({ action: entry.label, phase, bounds: values, finite: values.every(Number.isFinite) });
      renderer.render(scene, camera);
      context.drawImage(renderer.domElement, column * tileWidth, row * tileHeight);
      context.fillStyle = 'rgba(18, 25, 35, .78)';
      context.fillRect(column * tileWidth + 8, row * tileHeight + 8, 110, 25);
      context.fillStyle = '#ffffff';
      context.font = '16px sans-serif';
      context.fillText(`${entry.label} ${phase}`, column * tileWidth + 15, row * tileHeight + 26);
      mixer.stopAllAction();
      mixer.uncacheRoot(normalized.animatedRoot);
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
  const sourceClipsPreserved = sourceClipSignature.length === 0
    ? preparedClipSignature.length === 4 && preparedClipSignature.every(clip => /^CM_/.test(clip.name))
    : JSON.stringify(sourceClipSignature) === JSON.stringify(preparedClipSignature);
  const automatedChecksPassed = sourceClipsPreserved && skinsA.length > 0 && skinsA.length === skinsB.length && sharedBones === 0
    && sharedSkeletons === 0 && cloneIndependence.relativeMotionA > 1e-5 && cloneIndependence.relativeMotionB < 1e-7
    && poseMetrics.every(metric => metric.finite) && (deformationLimit === null || maxRelativeEdgeStretch <= deformationLimit);
  return {
    id: speciesId,
    sourceClipSignature,
    preparedClipSignature,
    authoredRig: asset.scene.userData.authoredRig ?? null,
    sourceParts,
    sourceBones,
    sourceClipsPreserved,
    cloneIndependence,
    deformationOutliers,
    deformationCheck: { maxRelativeEdgeStretch, limit: deformationLimit },
    poseMetrics,
    automatedChecksPassed,
    visualReview: 'requires-human-inspection' as const,
    image: panel.toDataURL('image/png'),
  };
}
