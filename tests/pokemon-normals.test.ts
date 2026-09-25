import { describe, expect, it } from 'vitest';
import {
  Box3, BoxGeometry, BufferGeometry, Float32BufferAttribute, Matrix3, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry, SphereGeometry, Triangle, Vector3,
} from 'three';
import { alignEyePatchNormals, preparePokemonNormals, smoothCoincidentNormals } from '../src/three/pokemon-normals';

/** The original all-pairs eye alignment, kept as the reference the grid version must match exactly. */
function bruteForceEyeNormals(root: Object3D): number {
  const bodies: Mesh[] = [], eyes: Mesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const names = (Array.isArray(object.material) ? object.material : [object.material]).map(material => material.name).join(' ');
    if (/eye(?:dh|nl)/i.test(names)) eyes.push(object);
    else if (/(?:dh|bodynl)(?:\.|$)/i.test(names)) bodies.push(object);
  });
  if (!eyes.length || !bodies.length) return 0;
  const bounds = new Box3();
  const triangles: { triangle: Triangle; normals: [Vector3, Vector3, Vector3] }[] = [];
  for (const body of bodies) {
    const geometry = body.geometry, p = geometry.getAttribute('position'), n = geometry.getAttribute('normal');
    if (!p || !n || geometry.morphAttributes.position?.length) continue;
    const normalMatrix = new Matrix3().getNormalMatrix(body.matrixWorld), index = geometry.index;
    for (let i = 0, count = index?.count ?? p.count; i + 2 < count; i += 3) {
      const ids = [index?.getX(i) ?? i, index?.getX(i + 1) ?? i + 1, index?.getX(i + 2) ?? i + 2];
      const positions = ids.map(id => new Vector3().fromBufferAttribute(p, id).applyMatrix4(body.matrixWorld)) as [Vector3, Vector3, Vector3];
      positions.forEach(point => bounds.expandByPoint(point));
      triangles.push({ triangle: new Triangle(...positions), normals: ids.map(id => new Vector3().fromBufferAttribute(n, id).applyNormalMatrix(normalMatrix)) as [Vector3, Vector3, Vector3] });
    }
  }
  const toleranceSquared = (bounds.getSize(new Vector3()).length() * .02) ** 2;
  const point = new Vector3(), closest = new Vector3(), barycentric = new Vector3(), target = new Vector3(), candidate = new Vector3();
  let changed = 0;
  for (const eye of eyes) {
    const p = eye.geometry.getAttribute('position'), n = eye.geometry.getAttribute('normal');
    if (!p || !n || eye.geometry.morphAttributes.position?.length || eye.geometry.morphAttributes.normal?.length) continue;
    const normalMatrix = new Matrix3().getNormalMatrix(eye.matrixWorld), inverseNormal = normalMatrix.clone().invert();
    const output = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      point.fromBufferAttribute(p, i).applyMatrix4(eye.matrixWorld);
      target.fromBufferAttribute(n, i).applyNormalMatrix(normalMatrix);
      let distance = toleranceSquared, found = false;
      for (const { triangle, normals } of triangles) {
        triangle.closestPointToPoint(point, closest);
        const d = closest.distanceToSquared(point);
        if (d >= distance || !triangle.getBarycoord(closest, barycentric)) continue;
        candidate.copy(normals[0]).multiplyScalar(barycentric.x).addScaledVector(normals[1], barycentric.y).addScaledVector(normals[2], barycentric.z).normalize();
        if (candidate.dot(target) < .5) continue;
        distance = d; found = true;
        output[i * 3] = candidate.x; output[i * 3 + 1] = candidate.y; output[i * 3 + 2] = candidate.z;
      }
      if (found) { target.fromArray(output, i * 3).applyMatrix3(inverseNormal).normalize(); changed++; }
      else target.fromBufferAttribute(n, i);
      target.toArray(output, i * 3);
    }
    eye.geometry.setAttribute('normal', new Float32BufferAttribute(output, 3));
  }
  return changed;
}

/** A body of two transformed meshes (indexed and not) with eye decals floating on, off and inside it. */
function eyedModel() {
  const root = new Object3D();
  root.rotation.set(.3, -.7, .2); root.scale.set(1.4, .9, 1.1);
  const head = new Mesh(new SphereGeometry(1, 28, 20), new MeshStandardMaterial({ name: 'pm0025_BodyNl' }));
  head.position.set(.2, 1.6, -.1);
  const torso = new Mesh(new SphereGeometry(1.3, 14, 10).toNonIndexed(), new MeshStandardMaterial({ name: 'Torso_dh' }));
  torso.scale.set(1, 1.2, .9);
  // A flat panel whose facets share exact distances with the plane, to exercise ties.
  const panel = new Mesh(new PlaneGeometry(2, 2, 4, 4), new MeshStandardMaterial({ name: 'Panel_dh' }));
  panel.position.set(0, -1, 1.6);
  root.add(head, torso, panel);
  const eyes: Mesh[] = [];
  for (const [x, y, z, turn] of [[.55, 1.75, .78, .4], [-.2, 1.7, .95, -.3], [0, -1, 1.62, 0], [3, 3, 3, 1], [.1, 1.6, -.05, 2.5]]) {
    const eye = new Mesh(new PlaneGeometry(.4, .3, 3, 2), new MeshStandardMaterial({ name: 'pm0025_EyeNl' }));
    eye.position.set(x, y, z); eye.rotation.set(0, turn, .1);
    root.add(eye); eyes.push(eye);
  }
  return { root, eyes };
}

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

  it('aligns eye decals exactly as the all-pairs search did, while testing only nearby body triangles', () => {
    const reference = eyedModel(), grid = eyedModel();
    const expected = bruteForceEyeNormals(reference.root), changed = alignEyePatchNormals(grid.root);
    expect(changed).toBe(expected);
    expect(changed).toBeGreaterThan(0);
    reference.eyes.forEach((eye, index) => {
      expect(Array.from(grid.eyes[index].geometry.getAttribute('normal').array)).toEqual(Array.from(eye.geometry.getAttribute('normal').array));
    });
    // The far decal keeps its authored normals.
    const far = grid.eyes[3].geometry.getAttribute('normal');
    expect([far.getX(0), far.getY(0), far.getZ(0)]).toEqual([0, 0, 1]);
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
