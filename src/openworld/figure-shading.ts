import { Mesh, MeshStandardMaterial, MeshToonMaterial, type Material, type Object3D } from 'three';

const toon = new WeakMap<Material, MeshToonMaterial>();

/**
 * The owner's figures draw cel-shaded: their painted colour map in two flat tones of light, with no gloss, reflection
 * or relief map, so the glossy patches of their generated roughness maps never shine white through the paint.
 * Clones share their model's materials, so each is converted once and the toon copy is shared the same way.
 */
export function shadeFigure(root: Object3D): void {
  const convert = (source: Material): Material => {
    if (!(source instanceof MeshStandardMaterial)) return source;
    let material = toon.get(source);
    if (!material) {
      material = new MeshToonMaterial({
        name: source.name, color: source.color, map: source.map, side: source.side,
        transparent: source.transparent, opacity: source.opacity, alphaTest: source.alphaTest,
      });
      toon.set(source, material);
    }
    return material;
  };
  root.traverse(child => {
    if (child instanceof Mesh) child.material = Array.isArray(child.material) ? child.material.map(convert) : convert(child.material);
  });
}
