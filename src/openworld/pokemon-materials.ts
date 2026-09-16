import { BufferGeometry, Material, Mesh, MeshStandardMaterial, Object3D } from 'three';

export type PokemonMaterialContext = {
  speciesId?: number;
  types?: readonly string[];
};

export type PokemonMaterialReport = {
  materials: number;
  metalnessAdjusted: number;
  roughnessAdjusted: number;
  normalsGenerated: number;
};

const METALLIC_SURFACE = /metal|steel|armor|armour|blade|sword|bell|chrome|gold|silver|iron/i;
const GLOSSY_SURFACE = /eye|pupil|cornea|glass|gem|crystal|jewel|water|wet/i;
const OBVIOUS_NON_METAL = /eye|pupil|cornea|mouth|tongue|tooth|fire|flame|leaf|flower|fur|skin/i;

function standardMaterials(material: Material | Material[]): MeshStandardMaterial[] {
  return (Array.isArray(material) ? material : [material])
    .filter((value): value is MeshStandardMaterial => value instanceof MeshStandardMaterial);
}

/**
 * Corrects invalid glTF metallic defaults on biological Pokemon surfaces.
 * Geometry topology, UVs, skin weights, morph targets and authored maps remain unchanged.
 */
export function normalizePokemonMaterials(root: Object3D, context: PokemonMaterialContext = {}): PokemonMaterialReport {
  const report: PokemonMaterialReport = { materials: 0, metalnessAdjusted: 0, roughnessAdjusted: 0, normalsGenerated: 0 };
  const steelSpecies = context.types?.some(type => type.toLowerCase() === 'steel') ?? false;
  const visited = new Set<MeshStandardMaterial>();
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
    for (const material of standardMaterials(object.material)) {
      if (visited.has(material)) continue;
      visited.add(material); report.materials++;
      const namedMetal = METALLIC_SURFACE.test(material.name);
      const preserveMetal = namedMetal || Boolean(material.metalnessMap)
        || (steelSpecies && !OBVIOUS_NON_METAL.test(material.name));
      const original = { metalness: material.metalness, roughness: material.roughness };
      if (!preserveMetal && material.metalness > .5) {
        material.metalness = 0;
        report.metalnessAdjusted++;
      }
      if (!preserveMetal && !material.roughnessMap && !GLOSSY_SURFACE.test(material.name) && material.roughness < .45) {
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
    }
  });
  root.userData.choketmonPokemonMaterialReport = report;
  return report;
}
