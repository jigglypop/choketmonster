import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

const loading = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../src/three/gltf-loader', () => ({ createGLTFLoader: (options?: { signal?: AbortSignal }) => ({ loadAsync: (url: string) => loading.load(url, options?.signal) }) }));
import { acquireModel, modelCacheStats, retryFailedModels } from '../src/three/model-cache';

describe('shared model cache ownership', () => {
  it('keeps remote-source priority while draining a burst without re-sorting it', async () => {
    loading.load.mockImplementation(async () => ({ scene: new Group(), animations: [] }));
    const leases = [
      acquireModel('/test/queue-local-a.glb'),
      acquireModel('/test/queue-local-b.glb'),
      acquireModel('https://raw.githubusercontent.com/example/models/main/priority.glb'),
      acquireModel('/test/queue-local-c.glb'),
    ];
    await Promise.all(leases.map(lease => lease.promise));
    expect(loading.load.mock.calls.map(([url]) => url)).toEqual([
      'https://raw.githubusercontent.com/example/models/main/priority.glb',
      '/test/queue-local-a.glb',
      '/test/queue-local-b.glb',
      '/test/queue-local-c.glb',
    ]);
    leases.forEach(lease => lease.release());
    loading.load.mockClear();
  });

  it('allows an explicit retry immediately after a failed request', async () => {
    loading.load.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ scene: new Group(), animations: [] });
    const first = acquireModel('/test/retry.glb');
    await expect(first.promise).rejects.toThrow('offline'); first.release();
    const blocked = acquireModel('/test/retry.glb');
    await expect(blocked.promise).rejects.toThrow('temporarily unavailable'); blocked.release();
    retryFailedModels();
    const retry = acquireModel('/test/retry.glb');
    await expect(retry.promise).resolves.toHaveProperty('scene'); retry.release();
    loading.load.mockClear();
  });

  it('times out a stalled load and disposes its late result without accepting it', async () => {
    vi.useFakeTimers();
    let finish!: (asset: unknown) => void;
    loading.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const lease = acquireModel('/test/stalled.glb');
    const rejected = expect(lease.promise).rejects.toThrow('timed out');
    try {
      await vi.advanceTimersByTimeAsync(45_001); await rejected;
      const geometry = new BoxGeometry(), disposed = vi.fn(); geometry.addEventListener('dispose', disposed);
      const scene = new Group(); scene.add(new Mesh(geometry, new MeshStandardMaterial()));
      finish({ scene, animations: [] }); await vi.advanceTimersByTimeAsync(0);
      expect(disposed).toHaveBeenCalledTimes(1);
    } finally { lease.release(); vi.useRealTimers(); loading.load.mockClear(); }
  });
  it('aborts a timed-out load, so its download and preparation stop instead of running beside a retry', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    loading.load.mockImplementationOnce((_url: string, given?: AbortSignal) => { signal = given; return new Promise(() => undefined); });
    const lease = acquireModel('/test/aborted.glb');
    const rejected = expect(lease.promise).rejects.toThrow('timed out');
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(45_001); await rejected;
      expect(signal?.aborted).toBe(true);
      expect(modelCacheStats().activeLoads).toBe(0);
    } finally { lease.release(); vi.useRealTimers(); loading.load.mockClear(); retryFailedModels(); }
  });

  it('counts only visible time toward the load deadline', async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const page = { hidden: true, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
    vi.stubGlobal('document', page);
    loading.load.mockImplementationOnce(() => new Promise(() => undefined));
    const lease = acquireModel('/test/hidden.glb'), settled = vi.fn();
    lease.promise.then(settled, settled);
    try {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).not.toHaveBeenCalled();
      page.hidden = false; listeners.forEach(listener => listener());
      await vi.advanceTimersByTimeAsync(45_001);
      expect(settled).toHaveBeenCalledTimes(1);
    } finally { lease.release(); vi.unstubAllGlobals(); vi.useRealTimers(); loading.load.mockClear(); retryFailedModels(); }
  });

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
    // Effect replacement releases the previous lease before acquiring its
    // successor in the same task. The deferred prune must preserve that handoff.
    const handoff = acquireModel('/test/shared.glb');
    expect(await handoff.promise).toBe(asset);
    handoff.release();
    for (let i = 25; i < 50; i++) { const lease = acquireModel(`/test/${i}.glb`); await lease.promise; lease.release(); }
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(modelCacheStats().cachedModels).toBe(24);
  });
});
