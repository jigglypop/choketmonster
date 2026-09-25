import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from 'three';
import { releaseOnDetach, releaseRenderObjects, trackRenderObjects } from '../src/three/render-objects';

/** Mirrors three r185: RenderObjects.createRenderObject builds the object and installs onDispose; dispose() calls it. */
function fakeRenderer() {
  const released: Object3D[] = [];
  const objects = {
    createRenderObject(object: Object3D) {
      const renderObject = {
        object, onDispose: null as (() => void) | null,
        dispose() { renderObject.onDispose?.(); },
      };
      renderObject.onDispose = () => { released.push(object); };
      return renderObject;
    },
  };
  return { renderer: { _objects: objects }, objects, released };
}

describe('render object release for meshes on long-lived materials', () => {
  it('frees every render object of an unmounted subtree, once, and leaves other meshes alone', () => {
    const { renderer, objects, released } = fakeRenderer();
    expect(trackRenderObjects(renderer)).toBe(true);
    expect(trackRenderObjects(renderer)).toBe(true);
    const material = new MeshStandardMaterial(), geometry = new BoxGeometry();
    const root = new Group(), child = new Mesh(geometry, material), other = new Mesh(geometry, material);
    root.add(child);
    objects.createRenderObject(child); objects.createRenderObject(child); objects.createRenderObject(other);
    releaseRenderObjects(root);
    expect(released).toEqual([child, child]);
    releaseRenderObjects(root);
    expect(released).toHaveLength(2);
    releaseOnDetach(other)?.();
    expect(released).toEqual([child, child, other]);
  });

  it('forgets render objects the renderer already disposed through their material', () => {
    const { renderer, objects, released } = fakeRenderer();
    trackRenderObjects(renderer);
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const renderObject = objects.createRenderObject(mesh);
    renderObject.dispose();
    releaseRenderObjects(mesh);
    expect(released).toEqual([mesh]);
  });

  it('drives three r185 RenderObjects: the material stops holding a released mesh', async () => {
    // @ts-expect-error three ships no declarations for its renderer internals.
    const { default: RenderObjects } = await import('three/src/renderers/common/RenderObjects.js');
    const deleted: unknown[] = [];
    const renderer = { contextNode: { id: 1, version: 0 }, backend: { isWebGPUBackend: true }, _currentSourceMaterial: null };
    const nodes = { getCacheKey: () => 0, delete: (item: unknown) => deleted.push(item) };
    const objects = new RenderObjects(renderer, nodes, {}, { delete() {} }, { deleteForRender() {} }, {});
    const host = { _objects: objects };
    expect(trackRenderObjects(host)).toBe(true);
    const material = new MeshStandardMaterial(), mesh = new Mesh(new BoxGeometry(), material);
    const context = { id: 7 }, lights = {};
    const first = objects.get(mesh, material, {}, {}, lights, context, null);
    expect(objects.get(mesh, material, {}, {}, lights, context, null)).toBe(first);
    expect(material.hasEventListener('dispose', first.onMaterialDispose)).toBe(true);
    releaseRenderObjects(mesh);
    expect(material.hasEventListener('dispose', first.onMaterialDispose)).toBe(false);
    expect(deleted).toEqual([first]);
    expect(objects.get(mesh, material, {}, {}, lights, context, null)).not.toBe(first);
  });

  it('does nothing before the renderer has its render objects', () => {
    const create = vi.fn();
    expect(trackRenderObjects({ _objects: null })).toBe(false);
    expect(trackRenderObjects({ _objects: { createRenderObject: create } })).toBe(true);
    expect(releaseOnDetach(null)).toBeUndefined();
    expect(() => releaseRenderObjects(null)).not.toThrow();
  });
});
