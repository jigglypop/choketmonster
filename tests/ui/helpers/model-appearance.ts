import { AnimationMixer, Box3, Color, DirectionalLight, HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Scene, SkinnedMesh, Vector3 } from 'three';
import { createGLTFLoader } from '../../../src/three/gltf-loader';
import { normalizePokemonMaterials } from '../../../src/openworld/pokemon-materials';
import { createOpenWorldRenderer } from '../../../src/openworld/gpu-renderer';
import { createDaylightEnvironment } from '../../../src/openworld/materials';
import { selectPokemonMotionClip } from '../../../src/data/model-motion';

export async function inspectAppearance(url: string, speciesId: number, normalize = true) {
  const asset = await createGLTFLoader().loadAsync(url);
  const rows: unknown[] = [];
  asset.scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const color = object.geometry.getAttribute('color');
    const ranges = color ? Array.from({ length: color.itemSize }, (_, channel) => {
      let min = Infinity, max = -Infinity;
      for (let vertex = 0; vertex < color.count; vertex++) {
        const value = color.getComponent(vertex, channel); min = Math.min(min, value); max = Math.max(max, value);
      }
      return { min, max };
    }) : undefined;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof MeshStandardMaterial || material instanceof MeshBasicMaterial)) continue;
      const image = material.map?.image;
      let pixels: unknown;
      if (image && !image.data) {
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let transparent = 0, opaque = 0, minAlpha = 255, maxAlpha = 0;
        const colors = new Set<number>();
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3]; if (!alpha) transparent++; if (alpha === 255) opaque++;
          minAlpha = Math.min(minAlpha, alpha); maxAlpha = Math.max(maxAlpha, alpha);
          colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        }
        pixels = { width: canvas.width, height: canvas.height, colors: colors.size, transparent, opaque, minAlpha, maxAlpha };
      }
      rows.push({ mesh: object.name, material: material.name, map: !!image, pixels, vertexColors: material.vertexColors,
        colors: ranges, uv: object.geometry.getAttribute('uv')?.count, metalness: material instanceof MeshStandardMaterial ? material.metalness : undefined, opacity: material.opacity, transparent: material.transparent });
    }
  });
  const report = normalize ? normalizePokemonMaterials(asset.scene, { speciesId }) : undefined;
  const surfaces: { name: string; transparent: boolean; textured: boolean; metalness?: number }[] = [];
  asset.scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material instanceof MeshStandardMaterial || material instanceof MeshBasicMaterial) surfaces.push({ name: material.name,
        transparent: material.transparent, textured: !!material.map, metalness: material instanceof MeshStandardMaterial ? material.metalness : undefined });
    }
  });
  const canvas = document.createElement('canvas'); document.body.replaceChildren(canvas);
  const renderer = await createOpenWorldRenderer({ canvas }); renderer.setSize(640, 640);
  const scene = new Scene(); scene.background = new Color('#c2cbd1');
  scene.environment = createDaylightEnvironment(); scene.environmentIntensity = .32;
  scene.add(new HemisphereLight('#ffffff', '#565d65', 2));
  const sun = new DirectionalLight('#ffffff', 3); sun.position.set(-3, 5, 5); scene.add(sun);
  const idle = selectPokemonMotionClip(asset.animations, 'idle').clip;
  if (idle) {
    const mixer = new AnimationMixer(asset.scene); mixer.clipAction(idle).play(); mixer.setTime(Math.min(.5, idle.duration / 2));
    asset.scene.updateMatrixWorld(true);
    asset.scene.traverse(object => { if (object instanceof SkinnedMesh) object.skeleton.update(); });
  }
  const box = new Box3().setFromObject(asset.scene, true), size = box.getSize(new Vector3()), center = box.getCenter(new Vector3());
  const scale = 3 / Math.max(size.x, size.y, size.z);
  asset.scene.position.sub(center); asset.scene.scale.multiplyScalar(scale); asset.scene.position.multiplyScalar(scale);
  scene.add(asset.scene);
  const camera = new PerspectiveCamera(35, 1, .01, 100); camera.position.set(4, 2, 6); camera.lookAt(0, 0, 0);
  const gpuErrors: string[] = [];
  const device = (renderer as unknown as { backend: { device?: { addEventListener: (name: string, listener: (event: any) => void) => void } } }).backend.device;
  device?.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
  renderer.render(scene, camera);
  await new Promise(resolve => setTimeout(resolve, 300));
  return { speciesId, rows, report, surfaces, gpuErrors, pose: idle?.name ?? 'bind' };
}
