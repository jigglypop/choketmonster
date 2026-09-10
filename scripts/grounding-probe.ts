import { AnimationMixer, Box3, BufferAttribute, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Raycaster, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGrounding, terrainSurfaceHeight, TERRAIN_SEGMENTS } from '../src/openworld/grounding';
import { normalizePokemonModel } from '../src/openworld/model-normalization';
import { sampleWorld } from '../src/openworld/simulation';
import { getSpecies } from '../src/data/pokemon';

/** Browser-only numerical inspection, using actual downloaded models and an independent terrain raycast. */
export async function verifyGrounding() {
  const geometry = new PlaneGeometry(240, 240, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS); geometry.rotateX(-Math.PI / 2);
  const vertices = geometry.attributes.position as BufferAttribute;
  for (let i = 0; i < vertices.count; i++) vertices.setY(i, sampleWorld(vertices.getX(i), vertices.getZ(i)).height);
  geometry.computeVertexNormals();
  const terrain = new Mesh(geometry, new MeshBasicMaterial()); terrain.updateMatrixWorld(true);
  const ray = new Raycaster(), bounds = new Box3(), records: { speciesId: number; displayHeight: number; animation: string; frames: number; maxGap: number; maxHeight: number; maxHorizontalSpan: number }[] = [];
  const loader = new GLTFLoader();
  let surfaceError = 0;
  for (const speciesId of [1, 4, 7, 10, 13, 25, 129, 150]) {
    const gltf = await loader.loadAsync(`/models/pokemon/${speciesId}.glb`);
    const displayHeight = Math.min(2.8, Math.max(.65, (getSpecies(speciesId).heightMeters ?? 1) * 1.25));
    const normalized = normalizePokemonModel(gltf.scene, gltf.animations, displayHeight);
    const world = new Group(), offset = new Group(); world.add(offset); offset.add(normalized.visual);
    const ground = createGrounding(normalized.visual, offset), mixer = new AnimationMixer(normalized.animatedRoot);
    for (const name of ['idle', 'walk', 'attack']) {
      const clip = gltf.animations.find(clip => clip.name === name); if (!clip) throw new Error(`Missing ${speciesId}/${name}`);
      mixer.stopAllAction(); mixer.clipAction(clip).reset().play();
      let maxGap = 0, maxHeight = 0, maxHorizontalSpan = 0;
      for (let frame = 0; frame < 24; frame++) {
        const x = -10 + frame * .3, z = 4 + frame * .17;
        ray.set(new Vector3(x, 100, z), new Vector3(0, -1, 0));
        const hit = ray.intersectObject(terrain)[0]; if (!hit) throw new Error('Terrain ray missed');
        const y = terrainSurfaceHeight(sampleWorld, x, z);
        surfaceError = Math.max(surfaceError, Math.abs(y - hit.point.y));
        world.position.set(x, y, z); world.rotation.y = frame * .09;
        mixer.update(1 / 12); ground(y);
        world.updateMatrixWorld(true); normalized.animatedRoot.traverse(object => { if (object instanceof SkinnedMesh) object.skeleton.update(); });
        bounds.setFromObject(normalized.visual, true);
        maxGap = Math.max(maxGap, Math.abs(bounds.min.y - hit.point.y));
        const animatedSize = bounds.getSize(new Vector3());
        maxHeight = Math.max(maxHeight, animatedSize.y);
        maxHorizontalSpan = Math.max(maxHorizontalSpan, animatedSize.x, animatedSize.z);
      }
      records.push({ speciesId, displayHeight, animation: name, frames: 24, maxGap, maxHeight, maxHorizontalSpan });
    }
    mixer.stopAllAction(); mixer.uncacheRoot(normalized.animatedRoot);
  }
  const result = {
    surfaceError,
    maxAnimatedGroundGap: Math.max(...records.map(record => record.maxGap)),
    maxAnimatedHeight: Math.max(...records.map(record => record.maxHeight)),
    maxAnimatedHorizontalSpan: Math.max(...records.map(record => record.maxHorizontalSpan)),
    records,
  };
  if (result.maxAnimatedGroundGap > .002 || surfaceError > .002 || records.some(record => record.maxHeight > record.displayHeight * 1.75 || record.maxHorizontalSpan > record.displayHeight * 2.5)) throw new Error(JSON.stringify(result));
  return result;
}
