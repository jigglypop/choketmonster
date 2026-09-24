import { caveContains, type CaveScene } from './caves';
import type { DungeonProp } from './dungeon-rooms';
import type { ScenePoint } from './world-space';
import { jitter } from './interior-kit';

/** A decoration standing at `angle` (radians in the x-z plane) and `radius` from the lair altar. */
export type LairPiece = ScenePoint & { y: number; angle: number; radius: number };
export type LairLayout = {
  center: ScenePoint & { y: number };
  /** Direction from the altar toward the doorways the player arrives from. */
  approach: number;
  pillars: LairPiece[];
  braziers: LairPiece[];
};
export type CrystalCluster = ScenePoint & { y: number; seed: number; size: number; count: number; lean: { x: number; z: number } };
export type Puddle = ScenePoint & { radius: number; seed: number };

/** The walkable dais around an altar, in metres. Nothing solid stands inside it. */
export const LAIR_DAIS_RADIUS = 2.5;
/** Half-width of a lair pillar's or brazier's base: all of it stands on closed ground. */
export const LAIR_PIECE_FOOTPRINT = .62;
const DOOR_CLEARANCE = 3.6;

export const sceneDoorways = (scene: CaveScene): ScenePoint[] => [...scene.portals, ...scene.stairs].map(item => item.interior);

function footprintDistance(prop: DungeonProp, x: number, z: number): number {
  if (prop.round) return Math.hypot(x - prop.x, z - prop.z) - Math.max(prop.width, prop.depth) / 2;
  return Math.max(Math.abs(x - prop.x) - prop.width / 2, Math.abs(z - prop.z) - prop.depth / 2);
}

/**
 * Ground a solid decoration may occupy: already closed to walking (so nobody walks through it), inside the
 * room's walls or clear of the cave wall, away from doorways and off every piece of furniture. With a
 * `footprint` radius the whole base must sit on closed ground, not just its centre.
 */
export function solidGround(scene: CaveScene, x: number, z: number, wallMargin = .5, footprint = 0): boolean {
  if (!scene.sample(x, z).blocked) return false;
  if (footprint > 0) for (let step = 0; step < 8; step++) {
    const angle = step / 8 * Math.PI * 2;
    if (!scene.sample(x + Math.cos(angle) * footprint, z + Math.sin(angle) * footprint).blocked) return false;
  }
  if (scene.room) {
    if (Math.abs(x) > scene.room.halfWidth - wallMargin || Math.abs(z) > scene.room.halfDepth - wallMargin) return false;
    if (scene.room.props.some(prop => footprintDistance(prop, x, z) < .45)) return false;
  } else if (!caveContains(scene.outline, x, z, 1.7)) return false;
  return sceneDoorways(scene).every(point => Math.hypot(point.x - x, point.z - z) > DOOR_CLEARANCE);
}

const angleGap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/**
 * The end chamber of a legendary lair: pillars (or standing stones) on the solid ground behind the altar,
 * leaving the side facing the doorways open, and a brazier at each end of that arc. Every piece stands where
 * the partner cannot walk, so the altar itself and the walk up to it stay exactly as the floor laid them out.
 */
export function lairLayout(scene: CaveScene): LairLayout | undefined {
  const altar = scene.altar;
  if (!altar || !scene.legendary?.length) return undefined;
  const doors = sceneDoorways(scene), ground = (x: number, z: number) => scene.sample(x, z).height;
  const toward = doors.reduce((sum, door) => ({ x: sum.x + door.x - altar.x, z: sum.z + door.z - altar.z }), { x: 0, z: 0 });
  const approach = Math.atan2(toward.z, toward.x), count = 18;
  const candidates: LairPiece[] = [];
  for (let step = 0; step < count; step++) {
    const angle = approach + (step + .5) / count * Math.PI * 2;
    if (angleGap(angle, approach) < Math.PI / 4) continue;
    for (let radius = 3.2; radius <= 6.6; radius += .2) {
      const x = altar.x + Math.cos(angle) * radius, z = altar.z + Math.sin(angle) * radius;
      if (!solidGround(scene, x, z, .5, LAIR_PIECE_FOOTPRINT)) continue;
      // Stand on the lowest ground under the base, so no edge floats on a slope.
      let y = ground(x, z);
      for (let step = 0; step < 8; step++) y = Math.min(y, ground(x + Math.cos(step * Math.PI / 4) * LAIR_PIECE_FOOTPRINT, z + Math.sin(step * Math.PI / 4) * LAIR_PIECE_FOOTPRINT));
      candidates.push({ x, z, y, angle, radius });
      break;
    }
  }
  // Walk the arc from one side of the approach to the other and keep pieces well apart.
  // From just past the approach on one side, round the back, to just short of it on the other.
  const turn = (piece: LairPiece) => { const signed = Math.atan2(Math.sin(piece.angle - approach), Math.cos(piece.angle - approach)); return signed < 0 ? signed + Math.PI * 2 : signed; };
  candidates.sort((a, b) => turn(a) - turn(b));
  const pieces: LairPiece[] = [];
  for (const piece of candidates) if (pieces.every(other => Math.hypot(other.x - piece.x, other.z - piece.z) >= 1.7)) pieces.push(piece);
  const center = { ...altar, y: ground(altar.x, altar.z) };
  // Without solid ground on two sides the shrine is just its dais and glow; nothing may stand where the partner walks.
  if (pieces.length < 2) return { center, approach, braziers: [], pillars: [] };
  return { center, approach, braziers: [pieces[0], pieces[pieces.length - 1]], pillars: pieces.slice(1, -1) };
}

/** The outline's inward normal at a wall segment. */
function inwardNormal(scene: CaveScene, index: number): ScenePoint {
  const wall = scene.wallSegments[index], tangent = { x: Math.cos(wall.rotationY), z: -Math.sin(wall.rotationY) };
  const a = { x: -tangent.z, z: tangent.x }, b = { x: tangent.z, z: -tangent.x };
  return a.x * -wall.x + a.z * -wall.z > b.x * -wall.x + b.z * -wall.z ? a : b;
}

/** Crystal clusters growing from the foot of a cave's walls, leaning into the chamber. */
export function caveCrystals(scene: CaveScene): CrystalCluster[] {
  if (scene.room) return [];
  const clusters: CrystalCluster[] = [], seed = scene.relief.seed;
  const segments = scene.wallSegments.length;
  for (let index = 0; index < segments; index += 2) {
    if (jitter(index, seed + 17) < .38) continue;
    const wall = scene.wallSegments[index], inward = inwardNormal(scene, index);
    const along = (jitter(index, seed + 23) - .5) * wall.width * .6, depth = 1.75 + jitter(index, seed + 29) * .35;
    const tangent = { x: Math.cos(wall.rotationY), z: -Math.sin(wall.rotationY) };
    const x = wall.x + tangent.x * along + inward.x * depth, z = wall.z + tangent.z * along + inward.z * depth;
    if (!solidGround(scene, x, z, .5, .35) || clusters.some(item => Math.hypot(item.x - x, item.z - z) < 4.5)) continue;
    if (scene.altar && Math.hypot(scene.altar.x - x, scene.altar.z - z) < 7) continue;
    const size = .75 + jitter(index, seed + 31) * .65;
    clusters.push({ x, z, y: scene.sample(x, z).height, seed: index * 7 + seed, size, count: 3 + Math.floor(jitter(index, seed + 37) * 4), lean: inward });
  }
  return clusters;
}

/** Shallow puddles in the floor's hollows, on open ground away from doorways, pools and the altar. */
export function cavePuddles(scene: CaveScene, limit = 7): Puddle[] {
  if (scene.room) return [];
  const height = (x: number, z: number) => scene.sample(x, z).height, doors = sceneDoorways(scene), found: Array<Puddle & { depth: number }> = [];
  for (let z = -scene.depth / 2 + 3; z <= scene.depth / 2 - 3; z += 2.5) for (let x = -scene.width / 2 + 3; x <= scene.width / 2 - 3; x += 2.5) {
    if (scene.sample(x, z).blocked || !caveContains(scene.outline, x, z, 4.4)) continue;
    if (doors.some(door => Math.hypot(door.x - x, door.z - z) < 4.5)) continue;
    if (scene.relief.pools.some(pool => Math.hypot(pool.x - x, pool.z - z) < pool.radius * 1.4 + 2.5)) continue;
    if (scene.altar && Math.hypot(scene.altar.x - x, scene.altar.z - z) < 5.5) continue;
    const here = height(x, z), around = [[1.4, 0], [-1.4, 0], [0, 1.4], [0, -1.4]].map(([dx, dz]) => height(x + dx, z + dz));
    if (Math.max(...around) - Math.min(...around) > .45 || around.some(value => value < here - .01)) continue;
    found.push({ x, z, radius: .9 + jitter(x * 3 + z, scene.relief.seed) * .8, seed: Math.round(x * 13 + z * 7), depth: around.reduce((sum, value) => sum + value, 0) / 4 - here });
  }
  const chosen: Puddle[] = [];
  for (const puddle of found.sort((a, b) => b.depth - a.depth)) {
    if (chosen.length >= limit) break;
    if (chosen.every(other => Math.hypot(other.x - puddle.x, other.z - puddle.z) > 7)) chosen.push({ x: puddle.x, z: puddle.z, radius: puddle.radius, seed: puddle.seed });
  }
  return chosen;
}

/** Spots along a room's walls where floor-standing dressing (braziers, rubble, drifts) can stand without being walked through. */
export function wallBandSpots(scene: CaveScene, spacing = 3.2, inset = .85, footprint = .45): Array<ScenePoint & { side: number; along: number }> {
  const room = scene.room; if (!room) return [];
  const spots: Array<ScenePoint & { side: number; along: number }> = [];
  const sides = [
    { length: room.halfWidth * 2, point: (t: number) => ({ x: t, z: -room.halfDepth + inset }) },
    { length: room.halfDepth * 2, point: (t: number) => ({ x: room.halfWidth - inset, z: t }) },
    { length: room.halfWidth * 2, point: (t: number) => ({ x: -t, z: room.halfDepth - inset }) },
    { length: room.halfDepth * 2, point: (t: number) => ({ x: -room.halfWidth + inset, z: -t }) },
  ];
  sides.forEach((side, index) => {
    const count = Math.max(1, Math.floor((side.length - 3) / spacing));
    for (let step = 0; step < count; step++) {
      const along = -side.length / 2 + 1.5 + (step + .5) * (side.length - 3) / count, point = side.point(along);
      if (solidGround(scene, point.x, point.z, .3, footprint) && (!scene.altar || Math.hypot(scene.altar.x - point.x, scene.altar.z - point.z) > 3.2))
        spots.push({ ...point, side: index, along });
    }
  });
  return spots;
}
