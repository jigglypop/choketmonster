import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { preparePokemonNormals, smoothCoincidentNormals } from '../src/three/pokemon-normals';

function seam() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 0,0,0, 1,0,0, 0,1,1], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute([0,0,1, 0,0,1, 0,0,1, 0,Math.SQRT1_2,Math.SQRT1_2, 0,Math.SQRT1_2,Math.SQRT1_2, 0,Math.SQRT1_2,Math.SQRT1_2], 3));
  geometry.setAttribute('uv', new Float32BufferAttribute([0,0,1,0,0,1,1,1,0,1,1,0], 2));
  geometry.setIndex([0,1,2,3,4,5]);
  return geometry;
}

describe('normal-only Pokemon surface repair', () => {
  it('joins smooth lighting across UV seams without welding or changing any other buffers', () => {
    const geometry = seam(), position = geometry.attributes.position, uv = geometry.attributes.uv, index = geometry.index;
    const previous = geometry.attributes.normal;
    expect(smoothCoincidentNormals(geometry)).toBe(4);
    const normal = geometry.attributes.normal;
    expect(normal.getY(0)).toBeCloseTo(Math.sin(Math.PI / 8));
    expect(normal.getZ(0)).toBeCloseTo(Math.cos(Math.PI / 8));
    expect(normal.getY(0)).toBe(normal.getY(3));
    expect(previous.getY(0)).toBe(0);
    expect(geometry.attributes.position).toBe(position); expect(geometry.attributes.uv).toBe(uv); expect(geometry.index).toBe(index);
  });

  it('preserves deliberate right-angle hard edges and opposing thin surfaces', () => {
    const box = new BoxGeometry(), normals = box.attributes.normal;
    expect(smoothCoincidentNormals(box)).toBe(0); expect(box.attributes.normal).toBe(normals);
    const geometry = seam();
    for (let i = 3; i < 6; i++) geometry.attributes.normal.setXYZ(i, 0, 0, -1);
    expect(smoothCoincidentNormals(geometry)).toBe(0);
  });

  it('does not join vertices that deform with different bone weights', () => {
    const geometry = seam();
    geometry.setAttribute('skinIndex', new Float32BufferAttribute(Array(6).fill([0,1,0,0]).flat(), 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute([...Array(3).fill([1,0,0,0]).flat(), ...Array(3).fill([0,1,0,0]).flat()], 4));
    const skin = geometry.attributes.skinWeight;
    expect(smoothCoincidentNormals(geometry)).toBe(0); expect(geometry.attributes.skinWeight).toBe(skin);
  });

  it('preserves morph-normal authoring and separates different morph positions', () => {
    const geometry = seam(), normals = geometry.attributes.normal;
    geometry.morphAttributes.normal = [normals.clone()];
    expect(smoothCoincidentNormals(geometry)).toBe(0); expect(geometry.attributes.normal).toBe(normals);
    delete geometry.morphAttributes.normal;
    const morph = geometry.attributes.position.clone(); for (let i = 3; i < 6; i++) morph.setX(i, morph.getX(i) + 1);
    geometry.morphAttributes.position = [morph];
    expect(smoothCoincidentNormals(geometry)).toBe(0);
  });

  it('leaves unreviewed angular species and small eye planes unchanged', () => {
    const root = new Object3D(), geometry = seam(), normals = geometry.attributes.normal;
    root.add(new Mesh(geometry, new MeshStandardMaterial()));
    preparePokemonNormals(root, 525); expect(geometry.attributes.normal).toBe(normals);
    preparePokemonNormals(root, 399); expect(geometry.attributes.normal).toBe(normals);
    expect(root.userData.choketmonSmoothNormals.vertices).toBe(0);
    preparePokemonNormals(root, 399); expect(geometry.attributes.normal).toBe(normals);
  });
});
