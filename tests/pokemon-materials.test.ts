import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { normalizePokemonMaterials } from '../src/openworld/pokemon-materials';

describe('Pokemon runtime material normalization', () => {
  it('corrects non-metal glTF defaults without changing geometry topology or UVs', () => {
    const geometry = new BoxGeometry();
    geometry.deleteAttribute('normal');
    const uv = geometry.getAttribute('uv'), index = geometry.index;
    const material = new MeshStandardMaterial({ metalness: 1, roughness: .1 });
    material.name = 'BodyA';
    const root = new Object3D(); root.add(new Mesh(geometry, material));
    const report = normalizePokemonMaterials(root, { speciesId: 152, types: ['grass'] });
    expect(report).toEqual({ materials: 1, metalnessAdjusted: 1, roughnessAdjusted: 1, normalsGenerated: 1 });
    expect(material).toMatchObject({ metalness: 0, roughness: .62 });
    expect(geometry.getAttribute('uv')).toBe(uv);
    expect(geometry.index).toBe(index);
    expect(geometry.getAttribute('normal')).toBeDefined();
  });

  it('preserves steel species and explicitly metallic or glossy surfaces', () => {
    const steel = new MeshStandardMaterial({ metalness: 1, roughness: .1 }); steel.name = 'Body';
    const blade = new MeshStandardMaterial({ metalness: 1, roughness: .1 }); blade.name = 'Blade';
    const eye = new MeshStandardMaterial({ metalness: 1, roughness: .1 }); eye.name = 'Eye';
    const root = new Object3D();
    root.add(new Mesh(new BoxGeometry(), [steel, blade, eye]));
    const report = normalizePokemonMaterials(root, { speciesId: 81, types: ['steel', 'electric'] });
    expect(report.metalnessAdjusted).toBe(1);
    expect(report.roughnessAdjusted).toBe(0);
    expect(steel).toMatchObject({ metalness: 1, roughness: .1 });
    expect(blade).toMatchObject({ metalness: 1, roughness: .1 });
    expect(eye).toMatchObject({ metalness: 0, roughness: .1 });
  });

  it('keeps named metal and glossy eyes on non-steel species', () => {
    const blade = new MeshStandardMaterial({ metalness: 1, roughness: .1 }); blade.name = 'gold_armor';
    const eye = new MeshStandardMaterial({ metalness: 0, roughness: .1 }); eye.name = 'cornea';
    const root = new Object3D(); root.add(new Mesh(new BoxGeometry(), [blade, eye]));
    normalizePokemonMaterials(root, { speciesId: 152, types: ['grass'] });
    expect(blade).toMatchObject({ metalness: 1, roughness: .1 });
    expect(eye.roughness).toBe(.1);
  });
});
