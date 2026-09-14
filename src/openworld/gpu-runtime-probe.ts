import {
  AmbientLight, DirectionalLight, InstancedMesh, Matrix4, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene,
} from 'three/webgpu';
import { createOpenWorldRenderer, getOpenWorldRendererInfo } from './gpu-renderer';
import { createWaterNodeMaterial, normalizeStandardMaterial } from './materials';

/** Browser-only acceptance probe used to compile the real TSL wind/water pipelines at scale. */
export async function runOpenWorldGpuProbe(canvas: HTMLCanvasElement, options: { forceWebGL?: boolean; grassCount?: number } = {}) {
  const count = options.grassCount ?? 16_000;
  if (!Number.isInteger(count) || count < 1 || count > 16_000) throw new RangeError('grassCount must be 1..16000');
  const renderer = await createOpenWorldRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' }, options);
  renderer.setPixelRatio(1); renderer.setSize(640, 360, false);
  const runtime = renderer as unknown as {
    renderAsync(scene: Scene, camera: PerspectiveCamera): Promise<void>; dispose(): Promise<void> | void;
    info: { reset(): void };
  };
  const scene = new Scene(), camera = new PerspectiveCamera(55, 640 / 360, .1, 500);
  camera.position.set(0, 40, 72); camera.lookAt(0, 0, 0);
  scene.add(new AmbientLight('#dce8cf', 1.2), new DirectionalLight('#ffffff', 2));

  const source = new MeshStandardMaterial({ color: '#6fa84c', roughness: .9 });
  const grassMaterial = normalizeStandardMaterial(source, { wind: true });
  const grassGeometry = new PlaneGeometry(.18, .8, 1, 2); grassGeometry.translate(0, .4, 0);
  const grass = new InstancedMesh(grassGeometry, grassMaterial, count), matrix = new Matrix4();
  for (let index = 0; index < count; index++) {
    const x = index % 160, z = Math.floor(index / 160);
    matrix.makeTranslation((x - 80) * .42, 0, (z - 50) * .42); grass.setMatrixAt(index, matrix);
  }
  grass.instanceMatrix.needsUpdate = true; scene.add(grass);
  const waterGeometry = new PlaneGeometry(54, 28, 1, 1), waterMaterial = createWaterNodeMaterial({ center: [0, 0], extent: [27, 14] });
  const water = new InstancedMesh(waterGeometry, waterMaterial, 1); water.rotation.x = -Math.PI / 2; water.position.y = -.1; scene.add(water);

  const started = performance.now();
  for (let frame = 0; frame < 12; frame++) { runtime.info.reset(); await runtime.renderAsync(scene, camera); }
  const elapsedMs = performance.now() - started, info = getOpenWorldRendererInfo(renderer)!;
  scene.remove(grass, water); grass.dispose(); water.dispose(); grassGeometry.dispose(); waterGeometry.dispose();
  grassMaterial.dispose(); waterMaterial.dispose(); source.dispose(); await runtime.dispose();
  return {
    ...info, grassCount: count, frames: 12, elapsedMs, averageFrameMs: elapsedMs / 12,
    drawCallsPerFrame: info.render.drawCalls,
    trianglesPerFrame: info.render.triangles,
  };
}
