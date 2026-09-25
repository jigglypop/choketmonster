import { Mesh, MeshStandardMaterial, type Material, type Object3D } from 'three';

const matte = new WeakMap<Material, MeshStandardMaterial>();

/**
 * The owner's figures draw matte: the glossy patches of their generated roughness maps caught the sky and the sun and
 * read as unpainted white, so every surface is fully rough and non-metallic, keeping its colour and relief maps.
 * Clones share their model's materials, so each is converted once and the matte copy is shared the same way.
 */
export function shadeFigure(root: Object3D): void {
  const convert = (source: Material): Material => {
    if (!(source instanceof MeshStandardMaterial)) return source;
    let material = matte.get(source);
    if (!material) {
      material = new MeshStandardMaterial().copy(source);
      material.roughness = 1; material.roughnessMap = null;
      material.metalness = 0; material.metalnessMap = null;
      matte.set(source, material);
    }
    return material;
  };
  root.traverse(child => {
    if (child instanceof Mesh) child.material = Array.isArray(child.material) ? child.material.map(convert) : convert(child.material);
  });
}
