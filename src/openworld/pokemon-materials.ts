import { BufferGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D } from 'three';
import { OPAQUE_POKEMON_SURFACES, POKEMON_METAL_SURFACES } from '../data/pokemon-material-overrides';

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
const vertexAlpha = new WeakMap<BufferGeometry, boolean>();
type PokemonSurface = MeshStandardMaterial | MeshBasicMaterial;
const isPokemonSurface = (material: unknown): material is PokemonSurface => material instanceof MeshStandardMaterial || material instanceof MeshBasicMaterial;

/**
 * Corrects invalid glTF metallic defaults on biological Pokemon surfaces.
 * Geometry topology, UVs, skin weights, morph targets and authored maps remain unchanged.
 */
export function normalizePokemonMaterials(root: Object3D, context: PokemonMaterialContext = {}): PokemonMaterialReport {
  const report: PokemonMaterialReport = { materials: 0, metalnessAdjusted: 0, roughnessAdjusted: 0, transparencyAdjusted: 0, normalsGenerated: 0 };
  const normalized = new Map<PokemonSurface, PokemonSurface>();
  const geometries = new Set<BufferGeometry>();
  const opaqueSurfaces = OPAQUE_POKEMON_SURFACES[context.speciesId ?? -1] ?? [];
  const metallicSurfaces = POKEMON_METAL_SURFACES[context.speciesId ?? -1] ?? [];
  const translucentVertices = new Set<PokemonSurface>();
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const color = object.geometry.getAttribute('color');
    if (!color || color.itemSize < 4) return;
    let translucent = vertexAlpha.get(object.geometry);
    if (translucent === undefined) {
      translucent = false;
      for (let i = 0; i < color.count; i++) if (color.getW(i) < .999) { translucent = true; break; }
      vertexAlpha.set(object.geometry, translucent);
    }
    if (translucent) for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (isPokemonSurface(material) && material.vertexColors) translucentVertices.add(material);
    }
  });
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
      if (!isPokemonSurface(source)) return source;
      const cached = normalized.get(source);
      if (cached) return cached;
      report.materials++;
      const namedMetal = METALLIC_SURFACE.test(source.name) || metallicSurfaces.includes(source.name);
      // A Steel type describes the creature, not every surface. Preserve authored
      // metal only when the material or its map says so; biological parts must not
      // inherit a chrome response merely from the species type.
      const standard = source instanceof MeshStandardMaterial;
      // glTF's omitted metallicFactor is 1. A deliberately fractional authored
      // value is not that exporter default (e.g. Registeel's 0.839 body coating).
      const authoredMetal = standard && source.metalness > .15 && source.metalness < .999;
      const preserveMetal = (namedMetal && !OBVIOUS_NON_METAL.test(source.name)) || authoredMetal || (standard && Boolean(source.metalnessMap));
      const adjustMetalness = standard && !preserveMetal && source.metalness > .15;
      const adjustRoughness = standard && !preserveMetal && !source.roughnessMap && !GLOSSY_SURFACE.test(source.name) && source.roughness < .45;
      const auditedOpaque = opaqueSurfaces.includes(source.name) && !translucentVertices.has(source);
      const adjustTransparency = source.transparent && source.opacity >= .999 && !source.alphaMap
        && !translucentVertices.has(source) && (!source.map || auditedOpaque);
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
      const original = standard ? { metalness: source.metalness, roughness: source.roughness } : undefined;
      if (adjustMetalness && material instanceof MeshStandardMaterial) {
        material.metalness = 0;
        report.metalnessAdjusted++;
      }
      if (adjustRoughness && material instanceof MeshStandardMaterial) {
        material.roughness = .62;
        report.roughnessAdjusted++;
      }
      if (original && material instanceof MeshStandardMaterial && (material.metalness !== original.metalness || material.roughness !== original.roughness)) {
        material.userData.choketmonPokemonSurface = {
          speciesId: context.speciesId,
          original,
          normalized: { metalness: material.metalness, roughness: material.roughness },
        };
        material.needsUpdate = true;
      }
      // BLEND with no alpha source and full opacity needlessly enters the sorted
      // transparent pass and can disappear behind other body pieces. Textured
      // surfaces change only when the pinned-source pixel audit identifies them;
      // unreviewed maps and actual vertex/explicit opacity remain untouched.
      if (adjustTransparency) {
        material.transparent = false;
        material.depthWrite = true;
        report.transparencyAdjusted++;
        material.userData.choketmonTransparencyNormalized = { speciesId: context.speciesId, reason: auditedOpaque ? 'audited-opaque-surface' : 'no-alpha-source' };
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
  const materials = new Set<PokemonSurface>();
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (isPokemonSurface(material) && material.userData.choketmonInstanceMaterial) materials.add(material);
    }
  });
  materials.forEach(material => material.dispose());
}
