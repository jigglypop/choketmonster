import { useCallback, type RefCallback, type RefObject } from 'react';
import type { Object3D, Texture } from 'three';

/** The part of three r185's private RenderObject used here. */
type RenderObject = { object: Object3D; onDispose: (() => void) | null; dispose(): void };
type RenderObjectFactory = { createRenderObject(...args: unknown[]): RenderObject };

const byObject = new WeakMap<Object3D, Set<RenderObject>>();
const tracked = new WeakSet<object>();

/**
 * three r185 frees a RenderObject (bind groups, uniform buffers, its hold on the mesh and geometry) only when
 * its material is disposed. A mesh unmounted while its material lives on stays reachable through that
 * material's dispose listeners, so every render object is recorded under its object for releaseRenderObjects.
 * Call once `renderer.init()` has created the renderer's RenderObjects.
 */
export function trackRenderObjects(renderer: object): boolean {
  const objects = (renderer as { _objects?: Partial<RenderObjectFactory> | null })._objects;
  if (!objects || typeof objects.createRenderObject !== 'function') return false;
  if (tracked.has(objects)) return true;
  tracked.add(objects);
  const create = objects.createRenderObject;
  objects.createRenderObject = function (this: unknown, ...args: unknown[]) {
    const renderObject = create.apply(this, args);
    let live = byObject.get(renderObject.object);
    if (!live) byObject.set(renderObject.object, live = new Set());
    live.add(renderObject);
    const release = renderObject.onDispose;
    renderObject.onDispose = () => { live.delete(renderObject); release?.(); };
    return renderObject;
  };
  return true;
}

/** Frees the render objects of `root` and its descendants. The renderer builds new ones if they are drawn again. */
export function releaseRenderObjects(root: Object3D | null | undefined): void {
  root?.traverse(object => {
    const live = byObject.get(object);
    if (live) for (const renderObject of [...live]) renderObject.dispose();
  });
}

/**
 * Call before disposing a renderer. Its Textures keep a dispose listener on every texture it uploaded; cached
 * textures (model cache, interior sets, baked noise) outlive the renderer, and each listener would keep it reachable.
 */
export function detachRendererTextures(renderer: object): void {
  const internals = renderer as { _textures?: { get(texture: Texture): { onDispose?: () => void } } | null; info?: { memoryMap?: Map<unknown, unknown> } };
  const textures = internals._textures, uploaded = internals.info?.memoryMap;
  if (!textures || !uploaded) return;
  for (const key of uploaded.keys()) {
    const texture = key as Texture | null;
    if (!texture?.isTexture) continue;
    const onDispose = textures.get(texture).onDispose;
    if (onDispose) texture.removeEventListener('dispose', onDispose);
  }
}

/** Ref callback that frees an object's render objects when React detaches it: unmount, or R3F rebuilding it for new args. */
export function releaseOnDetach(object: Object3D | null): (() => void) | undefined {
  return object ? () => releaseRenderObjects(object) : undefined;
}

/** A stable ref for components that also read the object: fills `ref` and releases the object when it is detached. */
export function useReleasingRef<T extends Object3D>(ref: RefObject<T | null>): RefCallback<T> {
  return useCallback((object: T | null) => {
    ref.current = object;
    return object ? () => {
      if (ref.current === object) ref.current = null;
      releaseRenderObjects(object);
    } : undefined;
  }, [ref]);
}
