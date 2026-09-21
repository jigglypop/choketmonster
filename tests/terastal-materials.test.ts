import { expect, it } from 'vitest';
import { Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Texture } from 'three';
import { applyTerastalMaterials } from '../src/openworld/terastal-materials';

it('crystallizes one instance and restores its materials without changing a shared cache or other creature', () => {
  const source = new MeshStandardMaterial({ color: '#e27844', map: new Texture() });
  const root = new Group(), mesh = new Mesh(undefined, source), other = new Mesh(undefined, source);
  root.add(mesh);
  const restore = applyTerastalMaterials(root, '#54c7ff');
  expect(mesh.material).toBeInstanceOf(MeshPhysicalMaterial);
  expect(mesh.material).not.toBe(source);
  expect(mesh.material.map).toBe(source.map);
  expect((mesh.material as MeshPhysicalMaterial).clearcoat).toBe(1);
  expect(other.material).toBe(source);
  expect(source.userData.terastal).toBeUndefined();
  let disposed = false; mesh.material.addEventListener('dispose', () => { disposed = true; });
  restore();
  expect(mesh.material).toBe(source);
  expect(disposed).toBe(true);
});
