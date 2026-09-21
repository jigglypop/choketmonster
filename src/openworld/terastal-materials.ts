import { Color, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, type Material, type Object3D } from 'three';

/** Instance-only crystal finish: leave cached textures, geometry and normal form untouched. */
export function applyTerastalMaterials(root: Object3D, tint: string): () => void {
  const originals = new Map<Mesh, Material | Material[]>();
  const crystals = new Map<Material, MeshPhysicalMaterial>();
  const color = new Color(tint);
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    originals.set(object, object.material);
    const convert = (source: Material): Material => {
      if (!(source instanceof MeshStandardMaterial || source instanceof MeshBasicMaterial)) return source;
      const existing = crystals.get(source);
      if (existing) return existing;
      const material = new MeshPhysicalMaterial();
      if (source instanceof MeshStandardMaterial) MeshStandardMaterial.prototype.copy.call(material, source);
      else {
        material.color.copy(source.color); material.map = source.map;
        material.alphaMap = source.alphaMap; material.alphaTest = source.alphaTest;
        material.opacity = source.opacity; material.transparent = source.transparent;
        material.side = source.side; material.vertexColors = source.vertexColors;
      }
      material.name = `${source.name}:terastal`;
      material.color.lerp(color, .25);
      material.metalness = .2;
      material.roughness = .05;
      material.envMapIntensity = 2;
      material.clearcoat = 1;
      material.clearcoatRoughness = .05;
      material.iridescence = .8;
      material.iridescenceIOR = 1.35;
      material.flatShading = true;
      material.userData = { ...material.userData, terastal: true };
      crystals.set(source, material);
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  return () => {
    originals.forEach((materials, mesh) => { mesh.material = materials; });
    crystals.forEach(material => material.dispose());
  };
}
