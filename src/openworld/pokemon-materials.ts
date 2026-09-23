import { BufferGeometry, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Object3D } from 'three';
import { OPAQUE_POKEMON_SURFACES, POKEMON_METAL_SURFACES } from '../data/pokemon-material-overrides';
import { POKEMON_CUTOUT_SURFACES } from '../data/pokemon-cutout-surfaces';

export type PokemonMaterialContext = {
  speciesId?: number;
  types?: readonly string[];
  /** Form model key for cutout lookup; defaults to the loader's `pokemonFormIdentifier` tag. */
  formIdentifier?: string;
};

export type PokemonMaterialReport = {
  materials: number;
  metalnessAdjusted: number;
  roughnessAdjusted: number;
  transparencyAdjusted: number;
  normalsGenerated: number;
  emissiveRemoved: number;
  shadingConverted: number;
  cutouts: number;
  hiddenLayers: number;
};

/** Eyes keep a small catch-light; every other biological surface is matte. */
const EYE_SURFACE = /eye|pupil|cornea|iris|sclera|highlight/i;
export const POKEMON_ROUGHNESS_FLOOR = .6;
export const POKEMON_EYE_ROUGHNESS_FLOOR = .35;
/** Audited metal armor (Corviknight) stays metal, capped so it never turns into a dark mirror. */
export const POKEMON_METAL_CAP = .5;
const POKEMON_METAL_ROUGHNESS_FLOOR = .45;
export const POKEMON_ENV_INTENSITY_CAP = .5;
/** Authored translucent shells (Solosis gel, Dewpider bubble, Spiritomb vortex) keep blending. */
const TRANSLUCENT_SHELL = { min: .05, max: .8 } as const;
export const POKEMON_CUTOUT_ALPHA_TEST = .5;

const vertexAlpha = new WeakMap<BufferGeometry, boolean>();
type PokemonSurface = MeshStandardMaterial | MeshBasicMaterial;
const isPokemonSurface = (material: unknown): material is PokemonSurface => material instanceof MeshStandardMaterial || material instanceof MeshBasicMaterial;

/** Lit, non-physical copy. Unlit surfaces glow against the scene lighting; physical extensions add sheen. */
function toStandard(source: PokemonSurface): MeshStandardMaterial {
  if (source instanceof MeshStandardMaterial) {
    // MeshStandardMaterial.copy reads only standard fields, dropping specular, clearcoat,
    // sheen, iridescence, transmission and ior from a MeshPhysicalMaterial source.
    const material = new MeshStandardMaterial().copy(source);
    material.userData = { ...source.userData };
    return material;
  }
  const material = new MeshStandardMaterial({
    name: source.name, color: source.color, map: source.map, alphaMap: source.alphaMap, aoMap: source.aoMap, aoMapIntensity: source.aoMapIntensity,
    lightMap: source.lightMap, lightMapIntensity: source.lightMapIntensity, vertexColors: source.vertexColors, fog: source.fog,
    transparent: source.transparent, opacity: source.opacity, alphaTest: source.alphaTest, side: source.side, depthWrite: source.depthWrite,
    depthTest: source.depthTest, visible: source.visible, wireframe: source.wireframe, metalness: 0, roughness: .85,
  });
  material.userData = { ...source.userData };
  return material;
}

/**
 * Pokemon surfaces render as matte, opaque, non-emissive dielectrics:
 * - metalness 0 (audited metal armor capped at 0.5), roughness >= 0.6 (eyes >= 0.35), no metal/roughness maps;
 * - unlit and KHR physical materials (specular, clearcoat, transmission, sheen, iridescence) become standard;
 * - emission is removed, so nothing glows or blooms; an emissive-only color moves to the base color;
 * - BLEND becomes opaque. Audited cutout textures use alphaTest; zero-opacity layers stay hidden;
 *   explicitly translucent shells (opacity 0.05-0.8) keep blending.
 * Geometry topology, UVs, skin weights, morph targets and color maps remain unchanged.
 */
export function normalizePokemonMaterials(root: Object3D, context: PokemonMaterialContext = {}): PokemonMaterialReport {
  const report: PokemonMaterialReport = { materials: 0, metalnessAdjusted: 0, roughnessAdjusted: 0, transparencyAdjusted: 0, normalsGenerated: 0, emissiveRemoved: 0, shadingConverted: 0, cutouts: 0, hiddenLayers: 0 };
  const normalized = new Map<PokemonSurface, PokemonSurface>();
  const geometries = new Set<BufferGeometry>();
  const opaqueSurfaces = OPAQUE_POKEMON_SURFACES[context.speciesId ?? -1] ?? [];
  const metallicSurfaces = POKEMON_METAL_SURFACES[context.speciesId ?? -1] ?? [];
  const formIdentifier = context.formIdentifier ?? root.userData.pokemonFormIdentifier as string | undefined;
  const cutoutSurfaces = POKEMON_CUTOUT_SURFACES[formIdentifier ?? String(context.speciesId ?? -1)] ?? [];
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
      const standard = source instanceof MeshStandardMaterial;
      const convert = !standard || source instanceof MeshPhysicalMaterial;
      const metal = metallicSurfaces.includes(source.name);
      const eye = EYE_SURFACE.test(source.name);
      const metalCap = metal ? POKEMON_METAL_CAP : 0;
      const roughnessFloor = metal ? POKEMON_METAL_ROUGHNESS_FLOOR : eye ? POKEMON_EYE_ROUGHNESS_FLOOR : POKEMON_ROUGHNESS_FLOOR;
      const adjustMetalness = standard && (source.metalness > metalCap || (!metal && !!source.metalnessMap));
      const adjustRoughness = standard && (source.roughness < roughnessFloor || !!source.roughnessMap);
      const emissive = standard && ((source.emissive.r + source.emissive.g + source.emissive.b > 0 && source.emissiveIntensity > 0) || !!source.emissiveMap);
      // Scene environment light uses scene.environmentIntensity; only an own envMap uses this factor.
      const adjustEnvironment = standard && !!source.envMap && source.envMapIntensity > POKEMON_ENV_INTENSITY_CAP;
      // glTF BLEND arrives as transparent with depthWrite off. Its alpha is usually exporter data
      // (Sun/Moon body masks, fully opaque images) and shows the body's inside through itself.
      const hidden = source.transparent && source.opacity <= TRANSLUCENT_SHELL.min;
      const shell = source.transparent && source.opacity > TRANSLUCENT_SHELL.min && source.opacity <= TRANSLUCENT_SHELL.max;
      const cutout = source.transparent && !hidden && !shell && cutoutSurfaces.includes(source.name) && !opaqueSurfaces.includes(source.name);
      const adjustTransparency = source.transparent && !shell;
      if (!convert && !adjustMetalness && !adjustRoughness && !emissive && !adjustEnvironment && !adjustTransparency) {
        normalized.set(source, source);
        return source;
      }
      // SkeletonUtils shares materials. Clone only surfaces that actually need a
      // correction so the cache template stays immutable without multiplying all
      // material objects and shader state per creature.
      const material = convert ? toStandard(source) : source.clone() as MeshStandardMaterial;
      material.userData.choketmonInstanceMaterial = true;
      normalized.set(source, material);
      if (convert) {
        report.shadingConverted++;
        material.userData.choketmonShadingConverted = source instanceof MeshBasicMaterial ? 'unlit' : 'physical';
      }
      const original = standard ? { metalness: source.metalness, roughness: source.roughness } : undefined;
      if (adjustMetalness) {
        material.metalness = Math.min(material.metalness, metalCap);
        if (!metal) material.metalnessMap = null;
        report.metalnessAdjusted++;
      }
      if (adjustRoughness) {
        material.roughness = Math.max(material.roughness, roughnessFloor);
        material.roughnessMap = null;
        report.roughnessAdjusted++;
      }
      if (original && (material.metalness !== original.metalness || material.roughness !== original.roughness)) {
        material.userData.choketmonPokemonSurface = {
          speciesId: context.speciesId,
          original,
          normalized: { metalness: material.metalness, roughness: material.roughness },
        };
      }
      if (emissive) {
        // A few sources carry their only color in the emissive channel (black base, no map).
        const base = material.color.r + material.color.g + material.color.b;
        const glow = material.emissive.r + material.emissive.g + material.emissive.b;
        if (!material.map && base < .15 && glow > base) {
          material.color.copy(material.emissive);
          material.map = material.emissiveMap;
        }
        material.emissive.setRGB(0, 0, 0);
        material.emissiveIntensity = 0;
        material.emissiveMap = null;
        report.emissiveRemoved++;
      }
      if (adjustEnvironment) material.envMapIntensity = POKEMON_ENV_INTENSITY_CAP;
      if (adjustTransparency) {
        material.transparent = false;
        material.depthWrite = true;
        material.opacity = 1;
        material.alphaTest = cutout ? POKEMON_CUTOUT_ALPHA_TEST : 0;
        if (hidden) { material.visible = false; report.hiddenLayers++; }
        if (cutout) report.cutouts++;
        report.transparencyAdjusted++;
        material.userData.choketmonTransparencyNormalized = {
          speciesId: context.speciesId,
          reason: hidden ? 'zero-opacity-layer' : cutout ? 'audited-cutout' : translucentVertices.has(source) ? 'vertex-alpha-ignored' : 'blend-made-opaque',
        };
      }
      material.needsUpdate = true;
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
