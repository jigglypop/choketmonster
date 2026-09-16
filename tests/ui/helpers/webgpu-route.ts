import { createElement, Fragment } from 'react';
import { createRoot, extend } from '@react-three/fiber';
import { Mesh, MeshBasicMaterial, TubeGeometry } from 'three';
import { createOpenWorldRenderer, getOpenWorldRendererInfo } from '../../../src/openworld/gpu-renderer';
import { TargetRoute } from '../../../src/openworld/target-route';
import { SkyLighting } from '../../../src/openworld/materials';
import type { OpenWorldRenderSnapshot, WorldSample } from '../../../src/openworld/types';

/** Real GPU submission catches stale vertex bindings that pageerror cannot see. */
export async function exerciseRouteUpdates() {
  extend({ Mesh, MeshBasicMaterial, TubeGeometry });
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:640px;height:480px';
  document.body.append(canvas);
  const renderer = await createOpenWorldRenderer({ canvas });
  const errors: string[] = [];
  const device = (renderer as unknown as { backend: { device?: {
    addEventListener(type: string, listener: (event: { error: { message: string } }) => void): void;
    queue: { onSubmittedWorkDone(): Promise<void> };
  } } }).backend.device;
  if (!device) throw new Error('This regression requires an actual WebGPU backend');
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const root = createRoot(canvas);
  await root.configure({ gl: renderer, frameloop: 'always',
    size: { width: 640, height: 480, top: 0, left: 0 },
    camera: { position: [10, 25, 35], fov: 50 },
  });
  const sample = (): WorldSample => ({ height: 0, biome: 'meadow', blocked: false });
  const meshes: string[] = [], indexCounts: number[] = [];
  try {
    for (const count of [62, 59, 67, 73, 64, 43, 62]) {
      const snapshot: OpenWorldRenderSnapshot = {
        player: { x: 0, z: 0, heading: 0 }, entities: [],
        guide: { title: 'GPU route regression', detail: '', status: 'route',
          points: Array.from({ length: count }, (_, index) => ({ x: index * .3, z: Math.sin(index / 8) * 3 })) },
      };
      const state = root.render(createElement(Fragment, null, createElement(SkyLighting), createElement(TargetRoute, { snapshot, destination: null, sample })));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const current = state.getState();
      current.camera.lookAt(10, 0, 0);
      const mesh = current.scene.getObjectByName('world-target-route') as Mesh;
      if (!mesh) throw new Error('Route did not mount');
      meshes.push(mesh.uuid); indexCounts.push(mesh.geometry.index!.count);
      renderer.render(current.scene, current.camera);
      await device.queue.onSubmittedWorkDone();
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    return { errors, meshes, indexCounts, backend: getOpenWorldRendererInfo(renderer)?.backend };
  } finally { root.unmount(); }
}
