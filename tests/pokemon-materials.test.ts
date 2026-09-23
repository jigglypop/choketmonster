import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Color, Float32BufferAttribute, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, Texture } from 'three';
import {
  POKEMON_CUTOUT_ALPHA_TEST, POKEMON_EYE_ROUGHNESS_FLOOR, POKEMON_METAL_CAP, POKEMON_ROUGHNESS_FLOOR,
  disposeNormalizedPokemonMaterials, normalizePokemonMaterials,
} from '../src/openworld/pokemon-materials';
import { POKEMON_CUTOUT_SURFACES } from '../src/data/pokemon-cutout-surfaces';

const withMaterials = (...materials: Array<MeshStandardMaterial | MeshBasicMaterial>) => {
  const root = new Object3D(); root.add(new Mesh(new BoxGeometry(), materials.length === 1 ? materials[0] : materials));
  return root;
};
const normalizedOf = <T,>(root: Object3D) => (root.children[0] as Mesh).material as T;

describe('Pokemon runtime material normalization', () => {
  it('turns glossy metal defaults matte without changing geometry topology or UVs', () => {
    const geometry = new BoxGeometry();
    geometry.deleteAttribute('normal');
    const uv = geometry.getAttribute('uv'), index = geometry.index;
    const material = new MeshStandardMaterial({ metalness: 1, roughness: .1 });
    material.name = 'BodyA';
    const root = new Object3D(); root.add(new Mesh(geometry, material));
    const report = normalizePokemonMaterials(root, { speciesId: 152, types: ['grass'] });
    expect(report).toMatchObject({ materials: 1, metalnessAdjusted: 1, roughnessAdjusted: 1, transparencyAdjusted: 0, normalsGenerated: 1 });
    const normalized = normalizedOf<MeshStandardMaterial>(root);
    expect(normalized).not.toBe(material);
    expect(normalized).toMatchObject({ metalness: 0, roughness: POKEMON_ROUGHNESS_FLOOR });
    expect(material).toMatchObject({ metalness: 1, roughness: .1 });
    expect(geometry.getAttribute('uv')).toBe(uv);
    expect(geometry.index).toBe(index);
    expect(geometry.getAttribute('normal')).toBeDefined();
  });

  it('removes converter metal (0.4), fractional coatings and metal/roughness maps from biological surfaces', () => {
    const map = new Texture();
    const materials = [
      new MeshStandardMaterial({ metalness: .4, roughness: .5 }),
      new MeshStandardMaterial({ metalness: .839096, roughness: .31 }),
      new MeshStandardMaterial({ metalness: 1, roughness: 1, metalnessMap: map, roughnessMap: map }),
      new MeshStandardMaterial({ metalness: 1, roughness: .1 }),
    ];
    ['PaletteMaterial001', 'Material.004', 'body_a', 'Blade'].forEach((name, i) => { materials[i].name = name; });
    const root = withMaterials(...materials);
    normalizePokemonMaterials(root, { speciesId: 379, types: ['steel'] });
    for (const normalized of normalizedOf<MeshStandardMaterial[]>(root)) {
      expect(normalized.metalness).toBe(0);
      expect(normalized.roughness).toBeGreaterThanOrEqual(POKEMON_ROUGHNESS_FLOOR);
      expect(normalized.metalnessMap).toBeNull();
      expect(normalized.roughnessMap).toBeNull();
    }
  });

  it('lets eyes keep a small catch-light but never a mirror finish', () => {
    const eye = new MeshStandardMaterial({ metalness: 0, roughness: 0 }); eye.name = 'pm0832_00_Eye1_tga';
    const root = withMaterials(eye);
    normalizePokemonMaterials(root, { speciesId: 787 });
    expect(normalizedOf<MeshStandardMaterial>(root).roughness).toBe(POKEMON_EYE_ROUGHNESS_FLOOR);
  });

  it('keeps audited Corviknight armor metal, capped and rough enough not to mirror, and makes it opaque', () => {
    const map = new Texture(), geometry = new BoxGeometry();
    const material = new MeshStandardMaterial({ map, metalness: 1, roughness: .2, transparent: true, depthWrite: false });
    material.name = 'BodyA';
    const eye = new MeshStandardMaterial({ metalness: 1, roughness: .1 }); eye.name = 'Eye';
    const root = new Object3D(); root.add(new Mesh(geometry, [material, eye]));
    const uv = geometry.getAttribute('uv');
    const report = normalizePokemonMaterials(root, { speciesId: 823 });
    const [armor, normalizedEye] = normalizedOf<MeshStandardMaterial[]>(root);
    expect(report.transparencyAdjusted).toBe(1);
    expect(armor).toMatchObject({ map, metalness: POKEMON_METAL_CAP, transparent: false, depthWrite: true, opacity: 1, alphaTest: 0 });
    expect(armor.roughness).toBeGreaterThanOrEqual(.45);
    expect(normalizedEye.metalness).toBe(0);
    expect(material.transparent).toBe(true);
    expect(geometry.getAttribute('uv')).toBe(uv);
  });

  it('makes BLEND surfaces opaque, including textured alpha masks and vertex alpha', () => {
    const geometry = new BoxGeometry();
    const colors = new Float32Array(geometry.getAttribute('position').count * 4).fill(1); colors[3] = .2;
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 4));
    const plain = new MeshStandardMaterial({ transparent: true, opacity: 1, depthWrite: false, roughness: .8 });
    const masked = new MeshStandardMaterial({ map: new Texture(), transparent: true, depthWrite: false, roughness: .8 }); masked.name = 'Body';
    const vertex = new MeshStandardMaterial({ vertexColors: true, transparent: true, depthWrite: false, roughness: .8 }); vertex.name = 'BodyVco';
    const root = new Object3D(); root.add(new Mesh(geometry, [plain, masked, vertex]));
    const report = normalizePokemonMaterials(root, { speciesId: 724 });
    expect(report.transparencyAdjusted).toBe(3);
    for (const material of normalizedOf<MeshStandardMaterial[]>(root)) expect(material).toMatchObject({ transparent: false, depthWrite: true, opacity: 1, alphaTest: 0 });
    expect(masked.transparent).toBe(true);
  });

  it('renders audited cutout overlays with alphaTest instead of blending', () => {
    const [name] = POKEMON_CUTOUT_SURFACES['152'];
    const overlay = new MeshStandardMaterial({ map: new Texture(), transparent: true, depthWrite: false, roughness: .8 }); overlay.name = name;
    const root = withMaterials(overlay);
    expect(normalizePokemonMaterials(root, { speciesId: 152 }).cutouts).toBe(1);
    expect(normalizedOf<MeshStandardMaterial>(root)).toMatchObject({ transparent: false, depthWrite: true, alphaTest: POKEMON_CUTOUT_ALPHA_TEST });
  });

  it('finds form-model cutouts through the loader form tag', () => {
    const [name] = POKEMON_CUTOUT_SURFACES['raichu-mega-x'];
    const overlay = new MeshStandardMaterial({ map: new Texture(), transparent: true, roughness: .8 }); overlay.name = name;
    const root = withMaterials(overlay); root.userData.pokemonFormIdentifier = 'raichu-mega-x';
    normalizePokemonMaterials(root, { speciesId: 26 });
    expect(normalizedOf<MeshStandardMaterial>(root).alphaTest).toBe(POKEMON_CUTOUT_ALPHA_TEST);
  });

  it('hides zero-opacity layers and keeps explicitly translucent shells', () => {
    const hidden = new MeshStandardMaterial({ transparent: true, opacity: 0, roughness: .8 }); hidden.name = 'l_eye_b';
    const gel = new MeshStandardMaterial({ transparent: true, opacity: .25, depthWrite: false, roughness: .8 }); gel.name = 'green';
    const root = withMaterials(hidden, gel);
    expect(normalizePokemonMaterials(root, { speciesId: 577 }).hiddenLayers).toBe(1);
    const [normalizedHidden, normalizedGel] = normalizedOf<MeshStandardMaterial[]>(root);
    expect(normalizedHidden.visible).toBe(false);
    expect(normalizedGel).toBe(gel);
  });

  it('removes emission so nothing glows, moving an emissive-only color to the base color', () => {
    const map = new Texture(), glowMap = new Texture();
    const fire = new MeshStandardMaterial({ map, emissive: '#ff8800', emissiveIntensity: 8.9, emissiveMap: map, roughness: .8 }); fire.name = 'fire_gltf';
    const onlyGlow = new MeshStandardMaterial({ color: '#000000', emissive: '#ffee00', emissiveMap: glowMap, roughness: .8 }); onlyGlow.name = 'Yellow';
    const root = withMaterials(fire, onlyGlow);
    expect(normalizePokemonMaterials(root, { speciesId: 4 }).emissiveRemoved).toBe(2);
    const [normalizedFire, normalizedGlow] = normalizedOf<MeshStandardMaterial[]>(root);
    for (const material of [normalizedFire, normalizedGlow]) {
      expect(material.emissive.getHex()).toBe(0);
      expect(material.emissiveIntensity).toBe(0);
      expect(material.emissiveMap).toBeNull();
    }
    expect(normalizedFire.map).toBe(map);
    expect(normalizedGlow.color.getHex()).toBe(new Color('#ffee00').getHex());
    expect(normalizedGlow.map).toBe(glowMap);
  });

  it('converts KHR physical extensions to a plain standard surface', () => {
    const map = new Texture();
    const physical = new MeshPhysicalMaterial({ map, roughness: .2, metalness: 0, transmission: 1, clearcoat: 1, specularIntensity: 1, sheen: 1, iridescence: 1 });
    physical.name = 'Body';
    const root = withMaterials(physical);
    expect(normalizePokemonMaterials(root, { speciesId: 171 }).shadingConverted).toBe(1);
    const normalized = normalizedOf<MeshStandardMaterial>(root);
    expect(normalized).toBeInstanceOf(MeshStandardMaterial);
    expect(normalized).not.toBeInstanceOf(MeshPhysicalMaterial);
    expect(normalized.map).toBe(map);
    expect(normalized.roughness).toBe(POKEMON_ROUGHNESS_FLOOR);
  });

  it('lights unlit surfaces so they stop glowing against the scene', () => {
    const map = new Texture();
    const unlit = new MeshBasicMaterial({ map, transparent: true, depthWrite: false }); unlit.name = 'body_a_01';
    const root = withMaterials(unlit);
    expect(normalizePokemonMaterials(root, { speciesId: 726 })).toMatchObject({ shadingConverted: 1, transparencyAdjusted: 1 });
    const normalized = normalizedOf<MeshStandardMaterial>(root);
    expect(normalized).toBeInstanceOf(MeshStandardMaterial);
    expect(normalized).toMatchObject({ map, metalness: 0, transparent: false, depthWrite: true });
    expect(normalized.roughness).toBeGreaterThanOrEqual(POKEMON_ROUGHNESS_FLOOR);
  });

  it('disposes only corrected per-instance clones', () => {
    const corrected = new MeshStandardMaterial({ metalness: 1, roughness: .1 }); corrected.name = 'Body';
    const preserved = new MeshStandardMaterial({ metalness: 0, roughness: .8 }); preserved.name = 'Body2';
    const correctedDispose = vi.spyOn(MeshStandardMaterial.prototype, 'dispose');
    const root = withMaterials(corrected, preserved);
    normalizePokemonMaterials(root, { speciesId: 25 });
    const [normalizedCorrected, normalizedPreserved] = normalizedOf<MeshStandardMaterial[]>(root);

    disposeNormalizedPokemonMaterials(root);
    expect(normalizedCorrected).not.toBe(corrected);
    expect(normalizedPreserved).toBe(preserved);
    expect(correctedDispose).toHaveBeenCalledTimes(1);
    correctedDispose.mockRestore();
  });
});
