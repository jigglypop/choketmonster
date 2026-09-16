import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { disposeNormalizedPokemonMaterials, normalizePokemonMaterials } from '../src/openworld/pokemon-materials';

describe('Pokemon runtime material normalization', () => {
  it('corrects non-metal glTF defaults without changing geometry topology or UVs', () => {
    const geometry = new BoxGeometry();
    geometry.deleteAttribute('normal');
    const uv = geometry.getAttribute('uv'), index = geometry.index;
    const material = new MeshStandardMaterial({ metalness: 1, roughness: .1 });
    material.name = 'BodyA';
    const root = new Object3D(); root.add(new Mesh(geometry, material));
    const report = normalizePokemonMaterials(root, { speciesId: 152, types: ['grass'] });
    expect(report).toEqual({ materials: 1, metalnessAdjusted: 1, roughnessAdjusted: 1, transparencyAdjusted: 0, normalsGenerated: 1 });
    const normalized = (root.children[0] as Mesh).material as MeshStandardMaterial;
    expect(normalized).not.toBe(material);
    expect(normalized).toMatchObject({ metalness: 0, roughness: .62 });
    expect(material).toMatchObject({ metalness: 1, roughness: .1 });
    expect(geometry.getAttribute('uv')).toBe(uv);
    expect(geometry.index).toBe(index);
    expect(geometry.getAttribute('normal')).toBeDefined();
  });

  it('does not turn an entire steel species metallic and preserves explicit metal or glossy surfaces', () => {
    const steel = new MeshStandardMaterial({ metalness: 1, roughness: .1 }); steel.name = 'Body';
    const blade = new MeshStandardMaterial({ metalness: 1, roughness: .1 }); blade.name = 'Blade';
    const eye = new MeshStandardMaterial({ metalness: 1, roughness: .1 }); eye.name = 'Eye';
    const root = new Object3D();
    root.add(new Mesh(new BoxGeometry(), [steel, blade, eye]));
    const report = normalizePokemonMaterials(root, { speciesId: 81, types: ['steel', 'electric'] });
    expect(report.metalnessAdjusted).toBe(2);
    expect(report.roughnessAdjusted).toBe(1);
    const [normalizedSteel, normalizedBlade, normalizedEye] = (root.children[0] as Mesh).material as MeshStandardMaterial[];
    expect(normalizedSteel).toMatchObject({ metalness: 0, roughness: .62 });
    expect(normalizedBlade).toMatchObject({ metalness: 1, roughness: .1 });
    expect(normalizedEye).toMatchObject({ metalness: 0, roughness: .1 });
  });

  it('keeps named metal and glossy eyes on non-steel species', () => {
    const blade = new MeshStandardMaterial({ metalness: 1, roughness: .1 }); blade.name = 'gold_armor';
    const eye = new MeshStandardMaterial({ metalness: 0, roughness: .1 }); eye.name = 'cornea';
    const root = new Object3D(); root.add(new Mesh(new BoxGeometry(), [blade, eye]));
    normalizePokemonMaterials(root, { speciesId: 152, types: ['grass'] });
    const [normalizedBlade, normalizedEye] = (root.children[0] as Mesh).material as MeshStandardMaterial[];
    expect(normalizedBlade).toBe(blade);
    expect(normalizedEye).toBe(eye);
    expect(normalizedBlade).toMatchObject({ metalness: 1, roughness: .1 });
    expect(normalizedEye.roughness).toBe(.1);
  });

  it('moves no-alpha fully opaque blends to the opaque depth-writing pass', () => {
    const material = new MeshStandardMaterial({ transparent: true, opacity: 1, depthWrite: false });
    const root = new Object3D(); root.add(new Mesh(new BoxGeometry(), material));
    const report = normalizePokemonMaterials(root, { speciesId: 25 });
    const normalized = (root.children[0] as Mesh).material as MeshStandardMaterial;
    expect(report.transparencyAdjusted).toBe(1);
    expect(normalized).toMatchObject({ transparent: false, opacity: 1, depthWrite: true });
    expect(material).toMatchObject({ transparent: true, depthWrite: false });
  });

  it('disposes only corrected per-instance clones', () => {
    const corrected = new MeshStandardMaterial({ metalness: 1, roughness: .1 }); corrected.name = 'Body';
    const preserved = new MeshStandardMaterial({ metalness: 1, roughness: .1 }); preserved.name = 'Blade';
    const correctedDispose = vi.spyOn(MeshStandardMaterial.prototype, 'dispose');
    const root = new Object3D(); root.add(new Mesh(new BoxGeometry(), [corrected, preserved]));
    normalizePokemonMaterials(root, { speciesId: 25 });
    const [normalizedCorrected, normalizedPreserved] = (root.children[0] as Mesh).material as MeshStandardMaterial[];

    disposeNormalizedPokemonMaterials(root);
    expect(normalizedCorrected).not.toBe(corrected);
    expect(normalizedPreserved).toBe(preserved);
    expect(correctedDispose).toHaveBeenCalledTimes(1);
    correctedDispose.mockRestore();
  });
});
