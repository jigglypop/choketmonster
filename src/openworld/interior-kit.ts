import {
  BoxGeometry, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DataTexture, Euler, Float32BufferAttribute, IcosahedronGeometry, LinearFilter, Matrix3, Matrix4,
  Quaternion, RGBAFormat, SphereGeometry, TorusGeometry, Vector3, type ColorRepresentation,
} from 'three';

export type Tint = ColorRepresentation;
export const tone = (value: Tint, amount: number) => new Color(value).multiplyScalar(amount);
export const mix = (a: Tint, b: Tint, t: number) => new Color(a).lerp(new Color(b), t);
/** Stable 0..1 variation for decoration; never touches simulation RNG. */
export const jitter = (index: number, seed: number) => { const n = Math.sin(index * 127.1 + seed * 311.7) * 43758.5453; return n - Math.floor(n); };

/** Transform with Y rotation first, then optional tilts about X and Z. */
export function place(x: number, y: number, z: number, sx = 1, sy = sx, sz = sx, rotationY = 0, tiltX = 0, tiltZ = 0): Matrix4 {
  return new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(new Euler(tiltX, rotationY, tiltZ, 'YXZ')), new Vector3(sx, sy, sz));
}

const scratch = { position: new Vector3(), normal: new Vector3(), color: new Color() };

/**
 * Accumulates transformed primitives into one indexed, vertex-coloured geometry with world-projected UVs,
 * so a whole set of props shares one material, one draw call and a consistent texture scale (`tile` metres).
 */
export class PartBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];
  constructor(readonly tile = 1.6) {}

  get empty(): boolean { return this.positions.length === 0; }

  add(source: BufferGeometry, matrix: Matrix4, tint: Tint, options: { top?: Tint; dispose?: boolean } = {}): this {
    const position = source.getAttribute('position'), normal = source.getAttribute('normal');
    if (!normal) source.computeVertexNormals();
    const normals = source.getAttribute('normal'), normalMatrix = new Matrix3().getNormalMatrix(matrix);
    const bottom = new Color(tint), top = options.top === undefined ? bottom : new Color(options.top);
    source.computeBoundingBox();
    const minY = source.boundingBox!.min.y, span = Math.max(1e-6, source.boundingBox!.max.y - minY);
    const base = this.positions.length / 3;
    for (let index = 0; index < position.count; index++) {
      const localY = position.getY(index);
      scratch.position.fromBufferAttribute(position, index).applyMatrix4(matrix);
      scratch.normal.fromBufferAttribute(normals, index).applyMatrix3(normalMatrix).normalize();
      const { x, y, z } = scratch.position, n = scratch.normal, ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      // Box projection by the dominant normal axis keeps texel density equal on every part.
      const [u, v] = ay >= ax && ay >= az ? [x, z] : ax >= az ? [z, y] : [x, y];
      scratch.color.copy(bottom).lerp(top, (localY - minY) / span);
      this.positions.push(x, y, z);
      this.normals.push(n.x, n.y, n.z);
      this.uvs.push(u / this.tile, v / this.tile);
      this.colors.push(scratch.color.r, scratch.color.g, scratch.color.b);
    }
    const index = source.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.indices.push(base + index.getX(i));
    else for (let i = 0; i < position.count; i++) this.indices.push(base + i);
    if (options.dispose !== false) source.dispose();
    return this;
  }

  /** Box centred at (x, y, z). */
  box(x: number, y: number, z: number, width: number, height: number, depth: number, tint: Tint, rotationY = 0, top?: Tint): this {
    return this.add(new BoxGeometry(width, height, depth), place(x, y, z, 1, 1, 1, rotationY), tint, { top });
  }
  /** Box with chamfered, worn arrises that catch a raking light, centred at (x, y, z). */
  block(x: number, y: number, z: number, width: number, height: number, depth: number, tint: Tint, rotationY = 0, bevel = Math.min(width, height, depth) * .12, tilt: readonly [number, number] = [0, 0]): this {
    return this.add(chamferBox(width, height, depth, bevel), place(x, y, z, 1, 1, 1, rotationY, tilt[0], tilt[1]), tint);
  }
  /** Cylinder standing on `y0`. */
  cylinder(x: number, y0: number, z: number, radiusTop: number, radiusBottom: number, height: number, tint: Tint, segments = 12, top?: Tint): this {
    return this.add(new CylinderGeometry(radiusTop, radiusBottom, height, segments), place(x, y0 + height / 2, z), tint, { top });
  }
  cone(x: number, y0: number, z: number, radius: number, height: number, tint: Tint, segments = 4, rotationY = 0): this {
    return this.add(new ConeGeometry(radius, height, segments), place(x, y0 + height / 2, z, 1, 1, 1, rotationY), tint);
  }
  ring(x: number, y: number, z: number, radius: number, tube: number, tint: Tint, segments = 20): this {
    return this.add(new TorusGeometry(radius, tube, 6, segments), place(x, y, z, 1, 1, 1, 0, Math.PI / 2), tint);
  }
  /** Squashed dome sitting on `y0`. */
  dome(x: number, y0: number, z: number, radiusX: number, height: number, radiusZ: number, tint: Tint, rotationY = 0, top?: Tint): this {
    return this.add(new SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), place(x, y0, z, radiusX, height, radiusZ, rotationY), tint, { top });
  }
  /** Irregular faceted rock; `seed` picks the silhouette. */
  rock(x: number, y: number, z: number, sx: number, sy: number, sz: number, tint: Tint, seed: number, rotationY = 0, tilt: readonly [number, number] = [0, 0]): this {
    return this.add(roughRock(seed), place(x, y, z, sx, sy, sz, rotationY, tilt[0], tilt[1]), tint);
  }
  /** A tapering shaft standing on `y0` whose surface dips into `flutes` channels. */
  fluted(x: number, y0: number, z: number, radiusTop: number, radiusBottom: number, height: number, tint: Tint, flutes = 12, top?: Tint): this {
    const geometry = flutedShaft(flutes).clone(), position = geometry.getAttribute('position');
    // The taper is slight, so the unit shaft's normals still hold.
    for (let index = 0; index < position.count; index++) {
      const t = position.getY(index), radius = radiusBottom + (radiusTop - radiusBottom) * t;
      position.setXYZ(index, position.getX(index) * radius, t * height, position.getZ(index) * radius);
    }
    return this.add(geometry, place(x, y0, z), tint, { top });
  }

  build(): BufferGeometry | undefined {
    if (this.empty) return undefined;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2));
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/**
 * A box whose twelve edges are cut by a flat bevel and whose corners are capped by small triangles:
 * 26 flat faces, 96 vertices. Far lighter than a rounded box and crisper under a raking light.
 */
export function chamferBox(width: number, height: number, depth: number, bevel: number): BufferGeometry {
  const hx = width / 2, hy = height / 2, hz = depth / 2, b = Math.max(0, Math.min(bevel, hx * .45, hy * .45, hz * .45));
  if (b <= 0) return new BoxGeometry(width, height, depth);
  const ix = hx - b, iy = hy - b, iz = hz - b, positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const edge = new Vector3(), other = new Vector3(), normal = new Vector3(), centroid = new Vector3();
  const polygon = (points: number[][]) => {
    centroid.set(0, 0, 0); for (const point of points) centroid.add(other.fromArray(point)); centroid.divideScalar(points.length);
    edge.fromArray(points[1]).sub(other.fromArray(points[0]));
    normal.fromArray(points[2]).sub(other.fromArray(points[0])); normal.crossVectors(edge, normal).normalize();
    // Convex and centred on the origin: an outward face points away from the middle.
    const ordered = normal.dot(centroid) < 0 ? [...points].reverse() : points;
    if (ordered !== points) normal.negate();
    const base = positions.length / 3;
    for (const point of ordered) { positions.push(point[0], point[1], point[2]); normals.push(normal.x, normal.y, normal.z); }
    for (let index = 1; index < ordered.length - 1; index++) indices.push(base, base + index, base + index + 1);
  };
  for (const s of [-1, 1]) {
    polygon([[s * hx, -iy, -iz], [s * hx, iy, -iz], [s * hx, iy, iz], [s * hx, -iy, iz]]);
    polygon([[-ix, s * hy, -iz], [ix, s * hy, -iz], [ix, s * hy, iz], [-ix, s * hy, iz]]);
    polygon([[-ix, -iy, s * hz], [ix, -iy, s * hz], [ix, iy, s * hz], [-ix, iy, s * hz]]);
  }
  for (const a of [-1, 1]) for (const c of [-1, 1]) {
    polygon([[a * hx, c * iy, -iz], [a * ix, c * hy, -iz], [a * ix, c * hy, iz], [a * hx, c * iy, iz]]);
    polygon([[-ix, a * hy, c * iz], [-ix, a * iy, c * hz], [ix, a * iy, c * hz], [ix, a * hy, c * iz]]);
    polygon([[a * hx, -iy, c * iz], [a * ix, -iy, c * hz], [a * ix, iy, c * hz], [a * hx, iy, c * iz]]);
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
    polygon([[sx * hx, sy * iy, sz * iz], [sx * ix, sy * hy, sz * iz], [sx * ix, sy * iy, sz * hz]]);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

let blobTexture: DataTexture | undefined;
/** Soft round stain: opaque in the middle, fading out well before the rim. White, so a material or vertex colour tints it. */
export function contactShadowTexture(): DataTexture {
  if (blobTexture) return blobTexture;
  const size = 64, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const distance = Math.hypot((x + .5) / size * 2 - 1, (y + .5) / size * 2 - 1), fade = Math.max(0, Math.min(1, (1 - distance) / .62));
    const index = (y * size + x) * 4;
    pixels[index] = pixels[index + 1] = pixels[index + 2] = 255;
    pixels[index + 3] = Math.round(fade * fade * (3 - 2 * fade) * 255);
  }
  blobTexture = new DataTexture(pixels, size, size, RGBAFormat);
  blobTexture.minFilter = blobTexture.magFilter = LinearFilter; blobTexture.needsUpdate = true;
  return blobTexture;
}

/**
 * Flat stains (contact shadows, moss, soot) as one geometry: each an ellipse fan whose UVs run from the centre
 * to the rim of `contactShadowTexture`. `height` lifts every vertex onto the floor under it.
 */
export function stainGeometry(stains: ReadonlyArray<{ x: number; z: number; radiusX: number; radiusZ: number; color: Tint; rotation?: number; wobble?: number }>, height: (x: number, z: number) => number, lift = .02): BufferGeometry {
  const positions: number[] = [], uvs: number[] = [], colors: number[] = [], indices: number[] = [], segments = 18, color = new Color();
  for (const stain of stains) {
    const base = positions.length / 3, cos = Math.cos(stain.rotation ?? 0), sin = Math.sin(stain.rotation ?? 0);
    color.set(stain.color);
    positions.push(stain.x, height(stain.x, stain.z) + lift, stain.z); uvs.push(.5, .5); colors.push(color.r, color.g, color.b);
    for (let step = 0; step <= segments; step++) {
      const angle = step / segments * Math.PI * 2, w = stain.wobble;
      // An optional irregular rim for puddles and moss; it closes because it is periodic in the angle.
      const rim = w === undefined ? 1 : 1 + .18 * Math.sin(angle * 3 + w) + .1 * Math.sin(angle * 5 + w * 1.7);
      const lx = Math.cos(angle) * stain.radiusX * rim, lz = Math.sin(angle) * stain.radiusZ * rim;
      const x = stain.x + lx * cos - lz * sin, z = stain.z + lx * sin + lz * cos;
      positions.push(x, height(x, z) + lift, z); uvs.push(.5 + Math.cos(angle) * .5, .5 + Math.sin(angle) * .5); colors.push(color.r, color.g, color.b);
    }
    for (let step = 0; step < segments; step++) indices.push(base, base + step + 2, base + step + 1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(positions.map((_, index) => index % 3 === 1 ? 1 : 0), 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices); geometry.computeBoundingSphere();
  return geometry;
}

const flutedShafts = new Map<number, BufferGeometry>();
/** Unit shaft (radius 1, height 1 from y 0) whose surface dips into `flutes` channels. */
function flutedShaft(flutes: number): BufferGeometry {
  const cached = flutedShafts.get(flutes); if (cached) return cached;
  const geometry = new CylinderGeometry(1, 1, 1, flutes * 4, 1, true);
  geometry.translate(0, .5, 0);
  const position = geometry.getAttribute('position');
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index), z = position.getZ(index), angle = Math.atan2(z, x);
    const depth = 1 - .07 * (.5 + .5 * Math.cos(angle * flutes));
    position.setX(index, x * depth); position.setZ(index, z * depth);
  }
  geometry.computeVertexNormals();
  flutedShafts.set(flutes, geometry);
  return geometry;
}

const rocks = new Map<number, BufferGeometry>();
/** Unit rock: a subdivided icosahedron with position-seeded dents, so shared corners stay welded. */
export function roughRock(seed: number): BufferGeometry {
  const key = Math.abs(Math.round(seed)) % 12, cached = rocks.get(key); if (cached) return cached.clone();
  const geometry = new IcosahedronGeometry(1, 1), position = geometry.getAttribute('position');
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index), y = position.getY(index), z = position.getZ(index);
    const dent = .78 + .34 * jitter(Math.round(x * 97 + y * 57 + z * 31), key + 5);
    position.setXYZ(index, x * dent, y * dent * (y < 0 ? .7 : 1), z * dent);
  }
  geometry.computeVertexNormals();
  rocks.set(key, geometry);
  return geometry.clone();
}
