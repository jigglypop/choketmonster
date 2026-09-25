import { Mesh, Object3D, Texture, type Material, type BufferGeometry } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { createGLTFLoader } from './gltf-loader';
import { visibleTimeout } from './visible-time';

// One reference-counted cache serves field, team, box and dex viewers.
const MODEL_CACHE_LIMIT = 24;
const MODEL_LOAD_TIMEOUT_MS = 45_000;

type CachedModel = {
  promise: Promise<GLTF>;
  gltf?: GLTF;
  refs: number;
  lastUsed: number;
};

const modelCache = new Map<string, CachedModel>();

function disposeTree(root: Object3D): void {
  const geometry = new Set<BufferGeometry>(), materials = new Set<Material>(), textures = new Set<Texture>();
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    geometry.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const material of materials) { for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value); material.dispose(); }
  for (const texture of textures) {
    // WebGPU can defer copyExternalImageToTexture until after Texture.dispose().
    // Closing the shared ImageBitmap here detaches that pending upload and poisons
    // the whole command buffer. Dropping the cache reference lets the browser
    // reclaim the source after every renderer has finished with it.
    texture.dispose();
  }
  geometry.forEach(buffer => buffer.dispose());
}

function pruneModelCache(): void {
  if (modelCache.size <= MODEL_CACHE_LIMIT) return;
  while (modelCache.size > MODEL_CACHE_LIMIT) {
    let oldest: [string, CachedModel] | undefined;
    for (const candidate of modelCache) {
      const entry = candidate[1];
      if (entry.refs !== 0 || !entry.gltf || oldest && oldest[1].lastUsed <= entry.lastUsed) continue;
      oldest = candidate;
    }
    if (!oldest) break;
    const [url, entry] = oldest;
    if (entry.gltf) disposeTree(entry.gltf.scene);
    modelCache.delete(url);
  }
}

let pruneScheduled = false;
function scheduleModelCachePrune(): void {
  if (pruneScheduled || modelCache.size <= MODEL_CACHE_LIMIT) return;
  pruneScheduled = true;
  // React effect replacement releases the old lease before acquiring the new
  // one. Deferring eviction one microtask prevents a still-rendered clone from
  // losing shared geometry during that handoff.
  queueMicrotask(() => { pruneScheduled = false; pruneModelCache(); });
}

type LoadTask = { url: string; entry: CachedModel; resolve(value: GLTF): void; reject(error: unknown): void };
const loadQueue: LoadTask[] = [];
let activeLoads = 0;
let drainScheduled = false;
const failedModels = new Map<string, number>();
/** Explicit retries bypass the cooldown, without evicting live geometry or in-flight work. */
export function retryFailedModels(): void { failedModels.clear(); }
function isPriorityRemote(url: string): boolean { return /raw\.githubusercontent\.com/.test(url); }
function enqueueLoad(task: LoadTask): void {
  // Preserve the established remote-source priority without repeatedly sorting
  // the whole queue when several creatures enter view together.
  const priority = isPriorityRemote(task.url);
  let index = loadQueue.length;
  if (priority) {
    const firstNormal = loadQueue.findIndex(item => !isPriorityRemote(item.url));
    if (firstNormal >= 0) index = firstNormal;
  }
  loadQueue.splice(index, 0, task);
}
function scheduleModelQueueDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  queueMicrotask(() => { drainScheduled = false; drainModelQueue(); });
}
function drainModelQueue(): void {
  while (activeLoads < 3 && loadQueue.length) {
    const task = loadQueue.shift()!;
    if (!task.entry.refs) {
      if (modelCache.get(task.url) === task.entry) modelCache.delete(task.url);
      task.reject(new Error('Model left the visible area before loading')); continue;
    }
    activeLoads++;
    // A timed-out load is aborted: its download stops and no later preparation step runs, so it
    // neither keeps working beside the three live loads nor downloads again beside a retry.
    const controller = new AbortController();
    let expired = false, finished = false;
    const fail = (error: unknown) => {
      failedModels.set(task.url, performance.now());
      if (modelCache.get(task.url) === task.entry) modelCache.delete(task.url);
      task.reject(error);
    };
    const finish = () => {
      if (finished) return;
      finished = true; cancelDeadline(); activeLoads--; scheduleModelCachePrune(); drainModelQueue();
    };
    // Hidden tabs stretch the loader's yields to a second or more each; only visible time counts.
    const cancelDeadline = visibleTimeout(() => {
      expired = true;
      const error = new Error('Model load timed out');
      controller.abort(error); fail(error); finish();
    }, MODEL_LOAD_TIMEOUT_MS);
    createGLTFLoader({ signal: controller.signal }).loadAsync(task.url).then(gltf => {
      if (expired) { disposeTree(gltf.scene); return; }
      failedModels.delete(task.url); task.entry.gltf = gltf; task.resolve(gltf);
    }, error => { if (!expired) fail(error); }).finally(finish);
  }
}

export function acquireModel(url: string): { promise: Promise<GLTF>; release(): void } {
  let entry = modelCache.get(url);
  if (!entry) {
    const lastFailure = failedModels.get(url);
    if (lastFailure !== undefined && performance.now() - lastFailure < 60_000) {
      return { promise: Promise.reject(new Error('Model temporarily unavailable')), release() {} };
    }
    let resolve!: (value: GLTF) => void, reject!: (error: unknown) => void;
    const promise = new Promise<GLTF>((yes, no) => { resolve = yes; reject = no; });
    entry = { promise, refs: 0, lastUsed: performance.now() };
    modelCache.set(url, entry);
    enqueueLoad({ url, entry, resolve, reject });
  }
  entry.refs++;
  entry.lastUsed = performance.now();
  const acquired = entry;
  scheduleModelQueueDrain();
  let released = false;
  return { promise: entry.promise, release() {
    if (released) return; released = true;
    acquired.refs = Math.max(0, acquired.refs - 1);
    acquired.lastUsed = performance.now();
    scheduleModelCachePrune();
  } };
}

export function modelCacheStats() { return { cachedModels: modelCache.size, activeLoads, queuedLoads: loadQueue.length, cacheLimit: MODEL_CACHE_LIMIT }; }
