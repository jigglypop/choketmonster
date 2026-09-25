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

/** Body triangles bucketed by their bounds on a uniform grid, so each eye vertex tests only the triangles near it. */
type TriangleGrid = { originX: number; originY: number; originZ: number; cell: number; nx: number; ny: number; nz: number; offsets: Int32Array; items: Int32Array };

function triangleGrid(corners: readonly number[], bounds: Box3, reach: number): TriangleGrid {
  const size = bounds.getSize(new Vector3()), largest = Math.max(size.x, size.y, size.z);
  // Cells at least one query wide keep a lookup to 2 × 2 × 2 cells; 64 per axis bounds the table.
  const cell = Math.max(reach * 2, largest / 64, 1e-9);
  const nx = Math.floor(size.x / cell) + 1, ny = Math.floor(size.y / cell) + 1, nz = Math.floor(size.z / cell) + 1;
  const { x: originX, y: originY, z: originZ } = bounds.min;
  const triangles = corners.length / 9, spans = new Int32Array(triangles * 6), offsets = new Int32Array(nx * ny * nz + 1);
  const at = (value: number, origin: number, count: number) => Math.min(count - 1, Math.max(0, Math.floor((value - origin) / cell)));
  for (let t = 0; t < triangles; t++) {
    const base = t * 9;
    for (let axis = 0; axis < 3; axis++) {
      const a = corners[base + axis], b = corners[base + 3 + axis], c = corners[base + 6 + axis];
      const origin = axis === 0 ? originX : axis === 1 ? originY : originZ, count = axis === 0 ? nx : axis === 1 ? ny : nz;
      spans[t * 6 + axis * 2] = at(Math.min(a, b, c), origin, count);
      spans[t * 6 + axis * 2 + 1] = at(Math.max(a, b, c), origin, count);
    }
    for (let x = spans[t * 6]; x <= spans[t * 6 + 1]; x++) for (let y = spans[t * 6 + 2]; y <= spans[t * 6 + 3]; y++)
      for (let z = spans[t * 6 + 4]; z <= spans[t * 6 + 5]; z++) offsets[(x * ny + y) * nz + z + 1]++;
  }
  for (let index = 1; index < offsets.length; index++) offsets[index] += offsets[index - 1];
  const items = new Int32Array(offsets[offsets.length - 1]), fill = offsets.slice(0, -1);
  for (let t = 0; t < triangles; t++) {
    for (let x = spans[t * 6]; x <= spans[t * 6 + 1]; x++) for (let y = spans[t * 6 + 2]; y <= spans[t * 6 + 3]; y++)
      for (let z = spans[t * 6 + 4]; z <= spans[t * 6 + 5]; z++) items[fill[(x * ny + y) * nz + z]++] = t;
  }
  return { originX, originY, originZ, cell, nx, ny, nz, offsets, items };
}

/** Older exports overlay eye textures on separate polygons. Give those decals
 * the supporting body's interpolated normal so their rectangular edges do not
 * acquire a different lighting response. Do not move or recolor the eye.
 * Each eye vertex takes the nearest qualifying body triangle (lowest index on a tie). */
export function alignEyePatchNormals(root: Object3D): number {
  const bodies: Mesh[] = [], eyes: Mesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const names = (Array.isArray(object.material) ? object.material : [object.material]).map(material => material.name).join(' ');
    if (/eye(?:dh|nl)/i.test(names)) eyes.push(object);
    else if (/(?:dh|bodynl)(?:\.|$)/i.test(names)) bodies.push(object);
  });
  if (!eyes.length || !bodies.length) return 0;
  // World-space body triangles: nine corner and nine corner-normal values each.
  const corners: number[] = [], normals: number[] = [];
  const bounds = new Box3(), vertex = new Vector3(), normalMatrix = new Matrix3(), inverseNormal = new Matrix3();
  for (const body of bodies) {
    const geometry = body.geometry, p = geometry.getAttribute('position'), n = geometry.getAttribute('normal');
    if (!p || !n || geometry.morphAttributes.position?.length) continue;
    normalMatrix.getNormalMatrix(body.matrixWorld);
    const index = geometry.index;
    for (let i = 0, count = index?.count ?? p.count; i + 2 < count; i += 3) {
      for (let corner = 0; corner < 3; corner++) {
        const id = index ? index.getX(i + corner) : i + corner;
        vertex.fromBufferAttribute(p, id).applyMatrix4(body.matrixWorld);
        bounds.expandByPoint(vertex);
        corners.push(vertex.x, vertex.y, vertex.z);
        vertex.fromBufferAttribute(n, id).applyNormalMatrix(normalMatrix);
        normals.push(vertex.x, vertex.y, vertex.z);
      }
    }
  }
  const toleranceSquared = (bounds.getSize(new Vector3()).length() * .02) ** 2;
  // Any triangle closer than the tolerance overlaps the lookup box; the margin only adds candidates.
  const reach = Math.sqrt(toleranceSquared) * 1.01;
  const searchable = toleranceSquared > 0 && Number.isFinite(reach) && corners.length > 0;
  const grid = searchable ? triangleGrid(corners, bounds, reach) : undefined;
  const visited = new Int32Array(corners.length / 9).fill(-1);
  const triangle = new Triangle(), second = new Vector3(), third = new Vector3();
  const point = new Vector3(), closest = new Vector3(), barycentric = new Vector3(), target = new Vector3(), candidate = new Vector3();
  let changed = 0, query = 0;
  for (const eye of eyes) {
    const p = eye.geometry.getAttribute('position'), n = eye.geometry.getAttribute('normal');
    if (!p || !n || eye.geometry.morphAttributes.position?.length || eye.geometry.morphAttributes.normal?.length) continue;
    normalMatrix.getNormalMatrix(eye.matrixWorld); inverseNormal.copy(normalMatrix).invert();
    const output = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      point.fromBufferAttribute(p, i).applyMatrix4(eye.matrixWorld);
      target.fromBufferAttribute(n, i).applyNormalMatrix(normalMatrix);
      let best = -1, bestDistance = toleranceSquared;
      if (grid) {
        const { cell, nx, ny, nz, offsets, items } = grid;
        const lowX = Math.floor((point.x - reach - grid.originX) / cell), highX = Math.floor((point.x + reach - grid.originX) / cell);
        const lowY = Math.floor((point.y - reach - grid.originY) / cell), highY = Math.floor((point.y + reach - grid.originY) / cell);
        const lowZ = Math.floor((point.z - reach - grid.originZ) / cell), highZ = Math.floor((point.z + reach - grid.originZ) / cell);
        if (highX >= 0 && lowX < nx && highY >= 0 && lowY < ny && highZ >= 0 && lowZ < nz) {
          query++;
          for (let x = Math.max(0, lowX); x <= Math.min(nx - 1, highX); x++) for (let y = Math.max(0, lowY); y <= Math.min(ny - 1, highY); y++) {
            for (let z = Math.max(0, lowZ); z <= Math.min(nz - 1, highZ); z++) {
              const slot = (x * ny + y) * nz + z;
              for (let item = offsets[slot]; item < offsets[slot + 1]; item++) {
                const t = items[item];
                if (visited[t] === query) continue;
                visited[t] = query;
                triangle.a.fromArray(corners, t * 9); triangle.b.fromArray(corners, t * 9 + 3); triangle.c.fromArray(corners, t * 9 + 6);
                triangle.closestPointToPoint(point, closest);
                const d = closest.distanceToSquared(point);
                if (!(d < toleranceSquared) || (best >= 0 && (d > bestDistance || (d === bestDistance && t > best)))) continue;
                if (!triangle.getBarycoord(closest, barycentric)) continue;
                candidate.fromArray(normals, t * 9).multiplyScalar(barycentric.x)
                  .addScaledVector(second.fromArray(normals, t * 9 + 3), barycentric.y).addScaledVector(third.fromArray(normals, t * 9 + 6), barycentric.z).normalize();
                if (candidate.dot(target) < .5) continue;
                best = t; bestDistance = d;
                output[i * 3] = candidate.x; output[i * 3 + 1] = candidate.y; output[i * 3 + 2] = candidate.z;
              }
            }
          }
        }
      }
      if (best >= 0) { target.fromArray(output, i * 3).applyMatrix3(inverseNormal).normalize(); changed++; }
      else target.fromBufferAttribute(n, i);
      target.toArray(output, i * 3);
    }
    eye.geometry.setAttribute('normal', new Float32BufferAttribute(output, 3));
  }
  return changed;
}
