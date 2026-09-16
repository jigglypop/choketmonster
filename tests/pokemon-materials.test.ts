import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Texture } from 'three';
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

  it('preserves deliberately fractional metallic coatings without requiring a material name', () => {
    const material = new MeshStandardMaterial({ metalness: .839096, roughness: .22 }); material.name = 'Material.004';
    const root = new Object3D(); root.add(new Mesh(new BoxGeometry(), material));
    expect(normalizePokemonMaterials(root, { speciesId: 379 }).metalnessAdjusted).toBe(0);
    expect((root.children[0] as Mesh).material).toBe(material);
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

  it('repairs audited Corviknight alpha without replacing maps or removing its metal armor', () => {
    const map = new Texture(), geometry = new BoxGeometry();
    const material = new MeshStandardMaterial({ map, metalness: 1, roughness: .8586, transparent: true });
    material.name = 'BodyA';
    const root = new Object3D(); root.add(new Mesh(geometry, material));
    const uv = geometry.getAttribute('uv');
    const report = normalizePokemonMaterials(root, { speciesId: 823 });
    const normalized = (root.children[0] as Mesh).material as MeshStandardMaterial;
    expect(report.transparencyAdjusted).toBe(1);
    expect(normalized).toMatchObject({ map, metalness: 1, roughness: .8586, transparent: false, depthWrite: true });
    expect(material.transparent).toBe(true);
    expect(geometry.getAttribute('uv')).toBe(uv);
  });

  it('corrects audited unlit GLB surfaces without converting their shading model', () => {
    const material = new MeshBasicMaterial({ map: new Texture(), transparent: true }); material.name = 'body_a_01';
    const root = new Object3D(); root.add(new Mesh(new BoxGeometry(), material));
    expect(normalizePokemonMaterials(root, { speciesId: 726 }).transparencyAdjusted).toBe(1);
    const normalized = (root.children[0] as Mesh).material as MeshBasicMaterial;
    expect(normalized).toBeInstanceOf(MeshBasicMaterial);
    expect(normalized.map).toBe(material.map);
    expect(normalized.transparent).toBe(false);
  });

  it('preserves unreviewed maps, explicit opacity and alpha maps even on an audited species', () => {
    const materials = [
      new MeshStandardMaterial({ map: new Texture(), transparent: true }),
      new MeshStandardMaterial({ map: new Texture(), transparent: true, opacity: .5 }),
      new MeshStandardMaterial({ map: new Texture(), alphaMap: new Texture(), transparent: true }),
    ];
    materials[0].name = 'Unreviewed'; materials[1].name = materials[2].name = 'BodyA';
    const root = new Object3D(); root.add(new Mesh(new BoxGeometry(), materials));
    expect(normalizePokemonMaterials(root, { speciesId: 823 }).transparencyAdjusted).toBe(0);
    for (const material of (root.children[0] as Mesh).material as MeshStandardMaterial[]) expect(material.transparent).toBe(true);
  });

  it.each([undefined, new Texture()])('preserves actual vertex alpha with or without a base map', map => {
    const geometry = new BoxGeometry();
    const colors = new Float32Array(geometry.getAttribute('position').count * 4).fill(1); colors[3] = .5;
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 4));
    const material = new MeshStandardMaterial({ map, vertexColors: true, transparent: true }); material.name = 'BodyA';
    const root = new Object3D(); root.add(new Mesh(geometry, material));
    expect(normalizePokemonMaterials(root, { speciesId: 823 }).transparencyAdjusted).toBe(0);
    expect(((root.children[0] as Mesh).material as MeshStandardMaterial).transparent).toBe(true);
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
