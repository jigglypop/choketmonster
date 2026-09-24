import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat, RepeatWrapping, SRGBColorSpace } from 'three';

/** Tiling surfaces for dungeon rooms and carved props. */
export type InteriorPattern = 'flagstone' | 'ashlar' | 'planks' | 'tiles' | 'checker' | 'metal' | 'grain' | 'strata' | 'earth';
/** Albedo, tangent-space normals and occlusion (R) / roughness (G), plus the metres one repeat covers. */
export type SurfaceSet = { map: DataTexture; normalMap: DataTexture; ormMap: DataTexture; tile: number };
type Texel = { height: number; albedo: number; roughness: number; warm?: number };

// Periodic lattice noise: every pattern tiles seamlessly at its texture size.
function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 144269504) | 0;
  h = Math.imul(h ^ h >>> 13, 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function wrap(value: number, period: number): number { return ((value % period) + period) % period; }
function smooth(t: number): number { return t * t * (3 - 2 * t); }
function smoothstep(a: number, b: number, value: number): number { return smooth(Math.max(0, Math.min(1, (value - a) / (b - a)))); }
// Hot loops below avoid creating closures: a texture runs them for every one of its 16-65k texels.
function noise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = smooth(x - x0), ty = smooth(y - y0);
  const xa = wrap(x0, period), xb = wrap(x0 + 1, period), ya = wrap(y0, period), yb = wrap(y0 + 1, period);
  return (hash(xa, ya, seed) * (1 - tx) + hash(xb, ya, seed) * tx) * (1 - ty) + (hash(xa, yb, seed) * (1 - tx) + hash(xb, yb, seed) * tx) * ty;
}
/** Fractal noise over `period` lattice cells per texture; every octave stays periodic. */
function fbm(u: number, v: number, cells: number, seed: number, octaves = 4): number {
  let sum = 0, weight = 0, amplitude = 1;
  for (let octave = 0; octave < octaves; octave++) {
    const scale = cells * 2 ** octave;
    sum += noise(u * scale, v * scale, scale, seed + octave * 17) * amplitude; weight += amplitude; amplitude *= .5;
  }
  return sum / weight;
}
/** Distance from `x` to the nearest of `joints` on a ring of `size` pixels. */
function ringDistance(x: number, joints: readonly number[], size: number): { distance: number; index: number } {
  let distance = Infinity, index = 0;
  for (let j = 0; j < joints.length; j++) {
    const d = Math.abs(x - joints[j]), ring = Math.min(d, size - d);
    if (ring < distance) distance = ring;
  }
  for (let j = 0; j < joints.length; j++) if (wrap(x - joints[j], size) < wrap(x - joints[index], size)) index = j;
  return { distance, index };
}

/** Running-bond courses: `rows` boundaries in pixels and each course's joints. Worn, chipped arrises and a few cracks. */
function coursed(size: number, rows: readonly number[], joints: readonly (readonly number[])[], seed: number, options: { grout: number; bevel: number; wear: number; relief: number }) {
  return (x: number, y: number): Texel => {
    let row = 0; while (row < rows.length - 2 && y >= rows[row + 1]) row++;
    const top = rows[row], bottom = rows[row + 1];
    const joint = ringDistance(x, joints[row], size);
    const u = x / size, v = y / size;
    const chip = (fbm(u, v, 8, seed + 3, 3) - .5) * options.wear;
    const edge = Math.min(joint.distance, y - top, bottom - y) + chip;
    const slab = row * 7 + joint.index, tint = hash(slab, row, seed) - .5;
    const bevel = smoothstep(options.grout, options.grout + options.bevel, edge);
    const detail = fbm(u, v, 16, seed + 9, 4);
    // Hairline cracks across some stones.
    let crack = 0;
    if (hash(slab, 3, seed) > .62) {
      const angle = hash(slab, 5, seed) * Math.PI, cx = joints[row][joint.index] + 30, cy = (top + bottom) / 2;
      const dx = wrap(x - cx + size / 2, size) - size / 2, dy = y - cy;
      const along = dx * Math.cos(angle) + dy * Math.sin(angle), across = -dx * Math.sin(angle) + dy * Math.cos(angle);
      const wobble = (noise(along * .15, slab, 64, seed + 11) - .5) * 3;
      crack = (1 - smoothstep(0, 1.1, Math.abs(across + wobble))) * (1 - smoothstep(14, 26, Math.abs(along)));
    }
    const height = bevel * (1 - options.relief + options.relief * detail) - crack * .45;
    const face = .74 + tint * .2 + (detail - .5) * .18 + (bevel < 1 ? (bevel - 1) * .1 : 0);
    return { height, albedo: bevel <= 0 ? .4 + detail * .08 : face * (1 - crack * .45), roughness: bevel <= 0 ? .96 : .7 + detail * .18, warm: tint };
  };
}

const PATTERNS: Record<InteriorPattern, { size: number; tile: number; strength: number; texel: (x: number, y: number) => Texel }> = {
  flagstone: { size: 256, tile: 4, strength: 2.6, texel: coursed(256, [0, 58, 122, 190, 256],
    [[0, 92, 170], [36, 128, 204], [12, 100, 182], [60, 140, 226]], 41, { grout: 1.5, bevel: 5, wear: 5, relief: .18 }) },
  ashlar: { size: 256, tile: 4, strength: 3.2, texel: coursed(256, [0, 32, 64, 96, 128, 160, 192, 224, 256],
    [[0, 70, 138, 200], [34, 104, 170, 232], [10, 82, 150, 214], [44, 116, 180, 246], [0, 64, 134, 196], [30, 98, 166, 228], [16, 86, 152, 220], [50, 118, 186, 250]],
    73, { grout: 1.2, bevel: 6, wear: 4, relief: .24 }) },
  planks: { size: 256, tile: 4, strength: 2.2, texel: (x, y) => {
    const board = Math.floor(y / 16), offset = y % 16, seam = hash(board, 1, 5) * 256, seam2 = wrap(seam + 96 + hash(board, 2, 5) * 64, 256);
    const joint = ringDistance(x, [seam, seam2], 256).distance, edge = Math.min(offset, 16 - offset, joint);
    const u = x / 256, v = y / 256, grain = Math.sin((x * .09 + fbm(u, v, 4, board + 3, 3) * 9) * 2.1) * .5 + .5;
    const bevel = smoothstep(.4, 2.2, edge), tint = hash(board, 7, 5) - .5;
    return { height: bevel * (.92 + tint * .08), albedo: bevel <= 0 ? .3 : .7 + tint * .18 + grain * .12 + (fbm(u, v, 32, 9, 2) - .5) * .08, roughness: .62 + grain * .16, warm: tint };
  } },
  tiles: { size: 256, tile: 4, strength: 2.4, texel: (x, y) => {
    const cellX = Math.floor(x / 32), cellY = Math.floor(y / 32), edge = Math.min(x % 32, 32 - x % 32, y % 32, 32 - y % 32);
    const u = x / 256, v = y / 256, tint = hash(cellX, cellY, 13) - .5, detail = fbm(u, v, 16, 21, 3);
    const bevel = smoothstep(1, 3.5, edge + (fbm(u, v, 32, 3, 2) - .5) * 2);
    return { height: bevel * (.94 + detail * .06), albedo: bevel <= 0 ? .5 : .82 + tint * .12 + (detail - .5) * .1, roughness: bevel <= 0 ? .9 : .42 + detail * .2, warm: tint };
  } },
  checker: { size: 256, tile: 4, strength: 1.6, texel: (x, y) => {
    const dark = (Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 1, edge = Math.min(x % 32, 32 - x % 32, y % 32, 32 - y % 32);
    const u = x / 256, v = y / 256, vein = Math.abs(Math.sin((u * 9 + v * 5 + fbm(u, v, 8, 31, 4) * 3.5) * Math.PI));
    const marble = (1 - smoothstep(0, .08, vein)) * .22, bevel = smoothstep(.5, 2, edge);
    return { height: bevel, albedo: bevel <= 0 ? .45 : (dark ? .62 : .96) - marble + (fbm(u, v, 16, 5, 3) - .5) * .06, roughness: .3 + marble };
  } },
  metal: { size: 256, tile: 4, strength: 2.8, texel: (x, y) => {
    const px = x % 64, py = y % 64, edge = Math.min(px, 64 - px, py, 64 - py), u = x / 256, v = y / 256;
    const rx = Math.min(Math.abs(px - 6), Math.abs(px - 58)), ry = Math.min(Math.abs(py - 6), Math.abs(py - 58)), rivet = rx * rx + ry * ry < 5.76;
    // Raised diamond tread between the seams.
    const a = wrap(x + y, 12), b = wrap(x - y, 12), tread = a > 3 && a < 9 && b > 4.5 && b < 7.5 ? 1 : 0;
    const bevel = smoothstep(1, 3, edge), brushed = fbm(u * 8, v * .5, 8, 17, 3);
    return { height: bevel * (.8 + tread * .12) + (rivet ? .18 : 0), albedo: bevel <= 0 ? .42 : .78 + (brushed - .5) * .16 + tread * .06, roughness: bevel <= 0 ? .8 : .42 + brushed * .2 };
  } },
  // Cave wall: soft, gently warped sedimentary bands with a faint grain. Low contrast, no cracks or speckle.
  strata: { size: 256, tile: 4, strength: 1.8, texel: (x, y) => {
    const u = x / 256, v = y / 256, warp = fbm(u, v, 2, 61, 3), soft = fbm(u, v, 4, 67, 3), grain = fbm(u, v, 32, 71, 2);
    const band = Math.sin((v * 6 + warp * 1.4) * Math.PI * 2) * .5 + .5, lip = smoothstep(.7, .92, band);
    return { height: .5 + (band - .5) * .3 + lip * .12 + (soft - .5) * .3 + (grain - .5) * .05, albedo: .8 + (band - .5) * .1 + lip * .04 + (soft - .5) * .08 + (grain - .5) * .04, roughness: .8 + grain * .14 };
  } },
  // Cave floor: smooth packed earth, broad mottling and a few small rounded pebbles.
  earth: { size: 256, tile: 4, strength: 1.5, texel: (x, y) => {
    const u = x / 256, v = y / 256, broad = fbm(u, v, 3, 83, 3), fine = fbm(u, v, 24, 89, 2);
    // At most one pebble per 32 px cell, kept inside its cell so the texture still tiles.
    const cx = Math.floor(x / 32), cy = Math.floor(y / 32), has = hash(cx, cy, 91) > .55;
    const px = cx * 32 + 10 + hash(cx, cy, 93) * 12, py = cy * 32 + 10 + hash(cx, cy, 97) * 12, radius = 3 + hash(cx, cy, 99) * 5;
    const d = has ? Math.hypot(x - px, y - py) / radius : 9, dome = Math.max(0, 1 - d * d), rim = d > 1 && d < 1.3 ? .05 : 0;
    return { height: .45 + (broad - .5) * .28 + (fine - .5) * .08 + dome * .35, albedo: .78 + (broad - .5) * .12 + (fine - .5) * .05 + dome * .06 - rim, roughness: .88 - dome * .12 + (fine - .5) * .06 };
  } },
  grain: { size: 128, tile: 1.6, strength: 1.4, texel: (x, y) => {
    const u = x / 128, v = y / 128, detail = fbm(u, v, 8, 51, 5), streak = Math.abs(Math.sin((u * 3 + fbm(u, v, 4, 57, 2) * 2) * Math.PI * 3));
    const chisel = (1 - smoothstep(0, .06, streak)) * .35;
    return { height: detail * .8 - chisel * .2, albedo: .84 + (detail - .5) * .22 - chisel * .12, roughness: .74 + detail * .18 };
  } },
};

function dataTexture(pixels: Uint8Array, size: number, color: boolean): DataTexture {
  const texture = new DataTexture(pixels, size, size, RGBAFormat);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.colorSpace = color ? SRGBColorSpace : NoColorSpace;
  texture.generateMipmaps = true; texture.minFilter = LinearMipmapLinearFilter; texture.magFilter = LinearFilter;
  texture.anisotropy = 4; texture.needsUpdate = true;
  return texture;
}

const cache = new Map<InteriorPattern, SurfaceSet>();
/**
 * A shared, procedurally baked texture set: grey albedo (the material colour tints it), normals from the
 * pattern's relief so grout and chipped arrises catch the raking key light, and occlusion/roughness.
 */
export function interiorSurface(pattern: InteriorPattern): SurfaceSet {
  const cached = cache.get(pattern); if (cached) return cached;
  const { size, tile, strength, texel } = PATTERNS[pattern];
  const heights = new Float32Array(size * size), albedo = new Uint8Array(size * size * 4), orm = new Uint8Array(size * size * 4), normals = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sample = texel(x, y), index = y * size + x, warm = (sample.warm ?? 0) * .06;
    heights[index] = sample.height;
    const value = Math.max(0, Math.min(1, sample.albedo));
    albedo[index * 4] = Math.round(Math.min(1, value * (1 + warm)) * 255);
    albedo[index * 4 + 1] = Math.round(value * 255);
    albedo[index * 4 + 2] = Math.round(Math.min(1, value * (1 - warm)) * 255);
    albedo[index * 4 + 3] = 255;
    orm[index * 4] = Math.round((.5 + .5 * Math.max(0, Math.min(1, sample.height))) * 255);
    orm[index * 4 + 1] = Math.round(Math.max(0, Math.min(1, sample.roughness)) * 255);
    orm[index * 4 + 2] = 0; orm[index * 4 + 3] = 255;
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const left = (x + size - 1) % size, right = (x + 1) % size, below = (y + size - 1) % size, above = (y + 1) % size;
    const nx = -(heights[y * size + right] - heights[y * size + left]) * strength, ny = -(heights[above * size + x] - heights[below * size + x]) * strength;
    const length = Math.sqrt(nx * nx + ny * ny + 1);
    const index = (y * size + x) * 4;
    normals[index] = Math.round((nx / length * .5 + .5) * 255);
    normals[index + 1] = Math.round((ny / length * .5 + .5) * 255);
    normals[index + 2] = Math.round((1 / length * .5 + .5) * 255);
    normals[index + 3] = 255;
  }
  const set = { map: dataTexture(albedo, size, true), normalMap: dataTexture(normals, size, false), ormMap: dataTexture(orm, size, false), tile };
  cache.set(pattern, set);
  return set;
}
