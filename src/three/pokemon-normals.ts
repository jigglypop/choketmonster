import { Box3, BufferGeometry, Float32BufferAttribute, Matrix3, Mesh, Object3D, Triangle, Vector3 } from 'three';

/** Rounded bodies whose pinned exports split smooth surfaces into per-face normals.
 * Not a blanket smoothing pass: unreviewed species and sharp creases stay authored. */
export const SMOOTH_POKEMON_SPECIES: ReadonlySet<number> = new Set([
  188, 190, 195, 217, 224, 237, 238, 239, 240, 270, 276, 278, 279, 285, 298,
  307, 352, 355, 373, 387, 390, 393, 394, 396, 397, 398, 399, 406, 408, 424,
  426, 430, 434, 435, 438, 439, 441, 453, 467, 468, 477, 500, 504, 505, 511,
  513, 517, 518, 520, 522, 523, 528, 532, 533, 534, 535, 537, 538, 539, 540,
  542, 543, 544, 545, 546, 550, 552, 555, 559, 568, 569, 573, 574, 575, 576,
  579, 580, 581, 588, 596, 607, 611, 612, 613, 614, 617, 626, 628, 630,
  743, 755, 756,
]);

/** Change only the normal buffer; UV seams, topology, morphs and skinning stay intact.
 * A 60 degree crease preserves teeth/claws and opposing thin faces. */
export function smoothCoincidentNormals(geometry: BufferGeometry, creaseRadians = Math.PI / 3): number {
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
  if (!position || !normal || position.count !== normal.count || geometry.morphAttributes.normal?.length) return 0;
  const keys = new Array<string>(position.count), groups = new Map<string, number[]>();
  const skinIndex = geometry.getAttribute('skinIndex'), skinWeight = geometry.getAttribute('skinWeight');
  const morphs = geometry.morphAttributes.position ?? [];
  const quantize = (value: number) => Math.round(value * 100_000);
  for (let i = 0; i < position.count; i++) {
    let key = `${quantize(position.getX(i))},${quantize(position.getY(i))},${quantize(position.getZ(i))}`;
    if (skinIndex && skinWeight) for (let j = 0; j < skinIndex.itemSize; j++) key += `:${skinIndex.getComponent(i, j)},${quantize(skinWeight.getComponent(i, j))}`;
    for (const morph of morphs) key += `/${quantize(morph.getX(i))},${quantize(morph.getY(i))},${quantize(morph.getZ(i))}`;
    keys[i] = key;
    const group = groups.get(key); if (group) group.push(i); else groups.set(key, [i]);
  }
  const output = new Float32Array(position.count * 3), threshold = Math.cos(creaseRadians);
  let changed = 0;
  for (let i = 0; i < position.count; i++) {
    const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i), length = Math.hypot(nx, ny, nz);
    let x = 0, y = 0, z = 0;
    const directions = new Set<string>();
    for (const j of groups.get(keys[i])!) {
      const ax = normal.getX(j), ay = normal.getY(j), az = normal.getZ(j), adjacentLength = Math.hypot(ax, ay, az);
      if (!length || !adjacentLength || (nx * ax + ny * ay + nz * az) / (length * adjacentLength) < threshold - 1e-6) continue;
      // A triangulated quad contributes one direction, not twice the influence.
      const direction = `${quantize(ax / adjacentLength)},${quantize(ay / adjacentLength)},${quantize(az / adjacentLength)}`;
      if (directions.has(direction)) continue;
      directions.add(direction); x += ax / adjacentLength; y += ay / adjacentLength; z += az / adjacentLength;
    }
    const total = Math.hypot(x, y, z);
    if (total > 1e-8) { x /= total; y /= total; z /= total; } else { x = nx; y = ny; z = nz; }
    if (Math.hypot(x - nx, y - ny, z - nz) > 1e-4) changed++;
    output.set([x, y, z], i * 3);
  }
  if (changed) geometry.setAttribute('normal', new Float32BufferAttribute(output, 3));
  return changed;
}

/** Run once at decode time, before authored rigs and the shared loader cache. */
export function preparePokemonNormals(root: Object3D, speciesId: number): void {
  if (!SMOOTH_POKEMON_SPECIES.has(speciesId) || root.userData.choketmonSmoothNormals) return;
  const seen = new Set<BufferGeometry>();
  let vertices = 0, meshes = 0;
  root.traverse(object => {
    if (!(object instanceof Mesh) || seen.has(object.geometry)) return;
    const geometry = object.geometry;
    seen.add(geometry);
    // Eye planes and deliberately small rigid details are not body surfaces.
    if ((geometry.getAttribute('position')?.count ?? 0) < 300) return;
    const changed = smoothCoincidentNormals(geometry);
    if (changed) { vertices += changed; meshes++; }
  });
  const eyeVertices = alignEyePatchNormals(root);
  root.userData.choketmonSmoothNormals = { speciesId, meshes, vertices, eyeVertices, creaseDegrees: 60, topologyChanged: false };
}

/** Older exports overlay eye textures on separate polygons. Give those decals
 * the supporting body's interpolated normal so their rectangular edges do not
 * acquire a different lighting response. Do not move or recolor the eye. */
function alignEyePatchNormals(root: Object3D): number {
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
