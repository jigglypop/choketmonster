import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

const loading = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../src/three/gltf-loader', () => ({ createGLTFLoader: () => ({ loadAsync: loading.load }) }));
import { acquireModel, modelCacheStats } from '../src/three/model-cache';

describe('shared model cache ownership', () => {
  it('deduplicates simultaneous viewers, retains active geometry, and evicts only released models', async () => {
    loading.load.mockImplementation(async () => {
      const scene = new Group(); scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
      return { scene, animations: [] };
    });
    const field = acquireModel('/test/shared.glb'), specimen = acquireModel('/test/shared.glb');
    const [asset, same] = await Promise.all([field.promise, specimen.promise]);
    expect(same).toBe(asset); expect(loading.load).toHaveBeenCalledTimes(1);
    const geometry = (asset.scene.children[0] as Mesh).geometry, disposed = vi.fn(); geometry.addEventListener('dispose', disposed);
    field.release(); field.release(); // cleanup must be idempotent
    for (let i = 0; i < 25; i++) { const lease = acquireModel(`/test/${i}.glb`); await lease.promise; lease.release(); }
    expect(disposed).not.toHaveBeenCalled();
    expect(modelCacheStats().cachedModels).toBeLessThanOrEqual(24);
    const revisit = acquireModel('/test/shared.glb');
    expect(await revisit.promise).toBe(asset);
    revisit.release(); specimen.release();
    for (let i = 25; i < 50; i++) { const lease = acquireModel(`/test/${i}.glb`); await lease.promise; lease.release(); }
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(modelCacheStats().cachedModels).toBe(24);
  });
});
