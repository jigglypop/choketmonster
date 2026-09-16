import { BufferGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three';

export type PokemonMaterialContext = {
  speciesId?: number;
  types?: readonly string[];
};

export type PokemonMaterialReport = {
  materials: number;
  metalnessAdjusted: number;
  roughnessAdjusted: number;
  transparencyAdjusted: number;
  normalsGenerated: number;
};

const METALLIC_SURFACE = /metal|steel|armor|armour|blade|sword|bell|chrome|gold|silver|iron/i;
const GLOSSY_SURFACE = /eye|pupil|cornea|glass|gem|crystal|jewel|water|wet/i;
const OBVIOUS_NON_METAL = /eye|pupil|cornea|mouth|tongue|tooth|fire|flame|leaf|flower|fur|skin/i;

/**
 * Corrects invalid glTF metallic defaults on biological Pokemon surfaces.
 * Geometry topology, UVs, skin weights, morph targets and authored maps remain unchanged.
 */
export function normalizePokemonMaterials(root: Object3D, context: PokemonMaterialContext = {}): PokemonMaterialReport {
  const report: PokemonMaterialReport = { materials: 0, metalnessAdjusted: 0, roughnessAdjusted: 0, transparencyAdjusted: 0, normalsGenerated: 0 };
  const normalized = new Map<MeshStandardMaterial, MeshStandardMaterial>();
  const geometries = new Set<BufferGeometry>();
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry;
    if (!geometries.has(geometry)) {
      geometries.add(geometry);
      if (!geometry.getAttribute('normal') && geometry.getAttribute('position')) {
        geometry.computeVertexNormals();
        report.normalsGenerated++;
      }
    }
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const materials = sourceMaterials.map(source => {
      if (!(source instanceof MeshStandardMaterial)) return source;
      const cached = normalized.get(source);
      if (cached) return cached;
      report.materials++;
      const namedMetal = METALLIC_SURFACE.test(source.name);
      // A Steel type describes the creature, not every surface. Preserve authored
      // metal only when the material or its map says so; biological parts must not
      // inherit a chrome response merely from the species type.
      const preserveMetal = (namedMetal && !OBVIOUS_NON_METAL.test(source.name)) || Boolean(source.metalnessMap);
      const adjustMetalness = !preserveMetal && source.metalness > .15;
      const adjustRoughness = !preserveMetal && !source.roughnessMap && !GLOSSY_SURFACE.test(source.name) && source.roughness < .45;
      const adjustTransparency = source.transparent && source.opacity >= .999 && !source.alphaMap && !source.map;
      if (!adjustMetalness && !adjustRoughness && !adjustTransparency) {
        normalized.set(source, source);
        return source;
      }
      // SkeletonUtils shares materials. Clone only surfaces that actually need a
      // correction so the cache template stays immutable without multiplying all
      // material objects and shader state per creature.
      const material = source.clone();
      material.userData.choketmonInstanceMaterial = true;
      normalized.set(source, material);
      const original = { metalness: source.metalness, roughness: source.roughness };
      if (adjustMetalness) {
        material.metalness = 0;
        report.metalnessAdjusted++;
      }
      if (adjustRoughness) {
        material.roughness = .62;
        report.roughnessAdjusted++;
      }
      if (material.metalness !== original.metalness || material.roughness !== original.roughness) {
        material.userData.choketmonPokemonSurface = {
          speciesId: context.speciesId,
          original,
          normalized: { metalness: material.metalness, roughness: material.roughness },
        };
        material.needsUpdate = true;
      }
      // BLEND with no alpha source and full opacity needlessly enters the sorted
      // transparent pass and can disappear behind other body pieces. Opaque maps
      // retain their authored alpha mode because their pixel alpha is not knowable
      // from the Three texture object at this stage.
      if (adjustTransparency) {
        material.transparent = false;
        material.depthWrite = true;
        report.transparencyAdjusted++;
        material.userData.choketmonTransparencyNormalized = { speciesId: context.speciesId, reason: 'no-alpha-source' };
        material.needsUpdate = true;
      }
      return material;
    });
    object.material = Array.isArray(object.material) ? materials : materials[0];
  });
  root.userData.choketmonPokemonMaterialReport = report;
  return report;
}

/** Dispose correction clones while leaving shared loader-cache materials and texture maps owned by the cache. */
export function disposeNormalizedPokemonMaterials(root: Object3D): void {
  const materials = new Set<MeshStandardMaterial>();
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material instanceof MeshStandardMaterial && material.userData.choketmonInstanceMaterial) materials.add(material);
    }
  });
  materials.forEach(material => material.dispose());
}
