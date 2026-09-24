import { BufferGeometry, ConeGeometry, CylinderGeometry, Float32BufferAttribute, Matrix4, TorusGeometry } from 'three';
import type { CaveScene } from './caves';
import { PartBuilder, jitter, mix, place, tone, type Tint } from './interior-kit';
import { LAIR_DAIS_RADIUS, type LairLayout } from './interior-layout';
import { brazier, type Glow } from './temple-geometry';

const IDENTITY = new Matrix4();

/**
 * A round tier following the floor: its top sits `lift` above the ground under every vertex and a skirt runs
 * `drop` below it, so on cave relief it reads as a laid platform rather than a floating disc.
 */
function tier(centerX: number, centerZ: number, radius: number, lift: number, ground: (x: number, z: number) => number, drop = .35, sectors = 40): BufferGeometry {
  const rings = Math.max(2, Math.ceil(radius / .6)), positions: number[] = [], indices: number[] = [];
  positions.push(centerX, ground(centerX, centerZ) + lift, centerZ);
  for (let ring = 1; ring <= rings; ring++) for (let sector = 0; sector < sectors; sector++) {
    const angle = sector / sectors * Math.PI * 2, r = radius * ring / rings, x = centerX + Math.cos(angle) * r, z = centerZ + Math.sin(angle) * r;
    positions.push(x, ground(x, z) + lift, z);
  }
  const at = (ring: number, sector: number) => ring === 0 ? 0 : 1 + (ring - 1) * sectors + sector % sectors;
  for (let sector = 0; sector < sectors; sector++) indices.push(0, at(1, sector + 1), at(1, sector));
  for (let ring = 1; ring < rings; ring++) for (let sector = 0; sector < sectors; sector++)
    indices.push(at(ring, sector), at(ring, sector + 1), at(ring + 1, sector), at(ring, sector + 1), at(ring + 1, sector + 1), at(ring + 1, sector));
  // Skirt: the rim again, dropped below the floor.
  const skirt = positions.length / 3;
  for (let sector = 0; sector < sectors; sector++) {
    const angle = sector / sectors * Math.PI * 2, x = centerX + Math.cos(angle) * radius, z = centerZ + Math.sin(angle) * radius;
    positions.push(x, ground(x, z) - drop, z);
  }
  for (let sector = 0; sector < sectors; sector++) {
    const top = at(rings, sector), next = at(rings, sector + 1), low = skirt + sector, lowNext = skirt + (sector + 1) % sectors;
    indices.push(top, lowNext, low, top, next, lowNext);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  // The rim is shared by the top and the skirt, which rounds the tier's edge slightly.
  geometry.computeVertexNormals();
  return geometry;
}

/** A flat ring strip between two radii, `lift` above the floor. */
function band(centerX: number, centerZ: number, inner: number, outer: number, lift: number, ground: (x: number, z: number) => number): BufferGeometry {
  const sectors = 48, positions: number[] = [], indices: number[] = [];
  for (let sector = 0; sector < sectors; sector++) for (const r of [inner, outer]) {
    const angle = sector / sectors * Math.PI * 2, x = centerX + Math.cos(angle) * r, z = centerZ + Math.sin(angle) * r;
    positions.push(x, ground(x, z) + lift, z);
  }
  for (let sector = 0; sector < sectors; sector++) {
    const a = sector * 2, b = a + 1, c = (sector + 1) % sectors * 2, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(positions.map((_, index) => index % 3 === 1 ? 1 : 0), 3));
  geometry.setIndex(indices);
  return geometry;
}

const CAVE_STONE: Record<CaveScene['relief']['theme'], string> = { limestone: '#a8a294', water: '#7f918c', ice: '#bccfd3', volcanic: '#74665f', interior: '#8d8b86' };

export type LairGeometry = { solid?: BufferGeometry; glow?: BufferGeometry; fires: Glow[] };

/**
 * The shrine at the end of a lair: a two-tier dais with a glowing inlay around the altar, an arc of pillars or
 * standing stones on the solid ground behind it, braziers where the arc ends and a paved approach from the doorways.
 */
export function lairGeometry(scene: CaveScene, layout: LairLayout, walls: { stone: Tint; trim: Tint }, accent: string, tile: number): LairGeometry {
  const solid = new PartBuilder(tile), glow = new PartBuilder(tile), fires: Glow[] = [];
  const cave = !scene.room, ground = (x: number, z: number) => scene.sample(x, z).height;
  const { x: cx, z: cz } = layout.center, seed = scene.relief.seed;
  const stone = cave ? CAVE_STONE[scene.relief.theme] : mix(walls.stone, '#fff6e6', .22), trim = cave ? tone(stone, .8) : walls.trim;
  const bright = mix(accent, '#ffffff', .35);

  // Dais: a wide low step, the platform, a carved lip and a glowing inlaid circle with a sigil at its heart.
  solid.add(tier(cx, cz, LAIR_DAIS_RADIUS, .05, ground), IDENTITY, tone(stone, .86));
  solid.add(tier(cx, cz, LAIR_DAIS_RADIUS - .62, .1, ground), IDENTITY, stone);
  glow.add(band(cx, cz, 1.3, 1.38, .104, ground), IDENTITY, accent);
  glow.add(band(cx, cz, .42, .48, .104, ground), IDENTITY, bright);
  for (let spoke = 0; spoke < 8; spoke++) {
    const angle = spoke / 8 * Math.PI * 2 + layout.approach, x = cx + Math.cos(angle) * .9, z = cz + Math.sin(angle) * .9;
    glow.add(band(x, z, 0, .07, .106, ground), IDENTITY, accent);
    const outer = cx + Math.cos(angle) * 1.62, outerZ = cz + Math.sin(angle) * 1.62;
    solid.add(new CylinderGeometry(.09, .12, .08, 6), place(outer, ground(outer, outerZ) + .12, outerZ), trim);
  }

  // Pillars (rooms) or standing stones (caves), each banded with the accent glow.
  layout.pillars.forEach((piece, index) => {
    const facing = Math.atan2(cx - piece.x, cz - piece.z), height = (cave ? 2.3 : 3.3) + jitter(index, seed + 61) * (cave ? 1 : .5), y = piece.y;
    if (cave) {
      const lean = (jitter(index, seed + 67) - .5) * .16;
      solid.rock(piece.x, y + height * .3, piece.z, .58, height * .56, .46, mix(stone, '#ffffff', jitter(index, 3) * .12), index + 3, facing, [lean, lean * .5]);
      glow.add(new TorusGeometry(.6, .045, 5, 20), place(piece.x, y + height * .55, piece.z, 1, 1, .85, facing, Math.PI / 2 + lean), accent);
      return;
    }
    const shaft = height - 1.05, band = height * .62;
    solid.block(piece.x, y + .16, piece.z, 1, .32, 1, trim, facing, .05);
    solid.add(new CylinderGeometry(.34, .44, shaft, 4).rotateY(Math.PI / 4), place(piece.x, y + .32 + shaft / 2, piece.z, 1, 1, 1, facing), stone, { top: mix(stone, '#ffffff', .15) });
    // Glyph plates on each face of the tapering shaft; the one facing the altar burns brightest.
    const reach = (.44 - .1 * (band - .32) / shaft) / Math.SQRT2 + .012;
    for (let face = 0; face < 4; face++) {
      const angle = facing + face * Math.PI / 2;
      glow.box(piece.x + Math.sin(angle) * reach, y + band, piece.z + Math.cos(angle) * reach, .26, .56, .02, face === 0 ? bright : accent, angle);
    }
    solid.block(piece.x, y + height - .63, piece.z, .86, .2, .86, trim, facing, .03);
    solid.add(new ConeGeometry(.46, .5, 4).rotateY(Math.PI / 4), place(piece.x, y + height - .28, piece.z, 1, 1, 1, facing), tone(stone, 1.05));
  });

  // Braziers where the arc meets the approach.
  for (const piece of layout.braziers) {
    const top = brazier(solid, glow, piece.x, piece.y, piece.z, cave ? stone : mix(walls.stone, '#ffffff', .1), 1.05);
    fires.push({ x: piece.x, y: top, z: piece.z, color: '#ffb266' });
  }

  // Paired stepping stones toward the doorways, as far as the open floor allows; each follows the floor under it.
  const dx = Math.cos(layout.approach), dz = Math.sin(layout.approach);
  for (let step = 0; step < 7; step++) {
    const distance = LAIR_DAIS_RADIUS + .75 + step * 1.05, x = cx + dx * distance, z = cz + dz * distance;
    if (scene.sample(x, z).blocked) break;
    const spread = .42 - step * .015;
    for (const side of [-1, 1]) {
      const sx = x - dz * side * spread + (jitter(step * 2 + side, seed + 71) - .5) * .1, sz = z + dx * side * spread;
      solid.add(tier(sx, sz, .36 - step * .01, .045, ground, .12, 7), IDENTITY, tone(stone, .9 + jitter(step * 2 + side, 5) * .1));
    }
  }
  return { solid: solid.build(), glow: glow.build(), fires };
}
