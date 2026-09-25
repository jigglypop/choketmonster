import { DUNGEON_PLANS } from './dungeons';
import { scaleWorldDistance } from './world-space';

type Place = { readonly id: string; readonly x: number; readonly z: number };
type Road = readonly [string, string];

/** One side of a through cave: the road it faces and how far along that road its mouth stands. */
export type PassageMouth = { locationId: string; outX: number; outZ: number; reach: number };
/**
 * A cave standing across the road between its two neighbours. Its hill closes the cave's own clearing, so the only
 * way from one side to the other is in at one mouth and out at the other, as in the games.
 */
export type CavePassage = { dungeonId: string; x: number; z: number; mouths: readonly PassageMouth[] };

/** Entrances start this far out along each road from the cave's place. */
export const CAVE_MOUTH_REACH = scaleWorldDistance(2.2);
/** Road half-width left open in front of a passage mouth. */
export const PASSAGE_APPROACH = scaleWorldDistance(3.2);
/** The hill closes the cave's clearing out to here; its roads run on beyond it. */
export const PASSAGE_RADIUS = scaleWorldDistance(6);
/** Roads leaving a cave at least this far apart run through it; a narrower pair stays open around it. */
const THROUGH_ANGLE = 115 * Math.PI / 180;

/** How far along two roads two entrances stand so they are at least eight metres apart. */
export function mouthReach(aX: number, aZ: number, bX: number, bZ: number): number {
  const apart = Math.hypot(aX - bX, aZ - bZ);
  let reach = CAVE_MOUTH_REACH;
  while (apart * reach < 8 && reach < 24) reach += .5;
  return reach;
}

/** Unit direction from a place toward another, and the distance between them. */
function heading(from: Place, to: Place): { x: number; z: number; length: number } {
  const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz) || 1;
  return { x: dx / length, z: dz / length, length };
}

/** Every cave of the region that stands across a road, from the dungeon plans and the region's own places and roads. */
export function cavePassages(regionId: string, places: readonly Place[], roads: readonly Road[]): CavePassage[] {
  const byId = new Map(places.map(place => [place.id, place]));
  const linked = (a: string, b: string) => roads.some(([from, to]) => (from === a && to === b) || (from === b && to === a));
  return DUNGEON_PLANS.flatMap(plan => {
    if (plan.regionId !== regionId || plan.kind !== 'cave' || !plan.crossing || plan.surfaceLocations.length !== 2) return [];
    const cave = byId.get(plan.id), ends = plan.surfaceLocations.map(id => byId.get(id));
    if (!cave || ends.some(end => !end) || !plan.surfaceLocations.every(id => linked(plan.id, id))) return [];
    const out = ends.map(end => heading(cave, end!));
    if (out.some(road => road.length <= 12)) return [];
    if (Math.acos(Math.max(-1, Math.min(1, out[0].x * out[1].x + out[0].z * out[1].z))) < THROUGH_ANGLE) return [];
    const reach = mouthReach(out[0].x, out[0].z, out[1].x, out[1].z);
    return [{ dungeonId: plan.id, x: cave.x, z: cave.z, mouths: out.map((road, index) => ({ locationId: plan.surfaceLocations[index], outX: road.x, outZ: road.z, reach })) }];
  });
}

/** The doorstep in front of one of a passage's mouths: where the player steps out of the cave on that side. */
export function passageMouthArrival(passage: CavePassage, index: number): { x: number; z: number } {
  const mouth = passage.mouths[index], distance = mouth.reach + scaleWorldDistance(3);
  return { x: passage.x + mouth.outX * distance, z: passage.z + mouth.outZ * distance };
}

/** Whether (x, z) is on a passage's hill: inside the cave's clearing but not on the road in front of one of its mouths. */
export function onPassageHill(passages: readonly CavePassage[], x: number, z: number): boolean {
  for (const passage of passages) {
    const dx = x - passage.x, dz = z - passage.z;
    if (dx * dx + dz * dz >= PASSAGE_RADIUS * PASSAGE_RADIUS) continue;
    if (!passage.mouths.some(mouth => dx * mouth.outX + dz * mouth.outZ >= mouth.reach - .25 && Math.abs(dz * mouth.outX - dx * mouth.outZ) <= PASSAGE_APPROACH)) return true;
  }
  return false;
}

/**
 * Where a cave with a single way in opens on its place: on the side of the clearing farthest from every road, facing
 * back along them, so the road leads straight up to it. Returns the outward direction (toward the roads).
 */
export function deadEndFacing(place: Place, neighbours: readonly Place[]): { x: number; z: number } {
  const roads = neighbours.map(neighbour => heading(place, neighbour)).filter(road => road.length > 1e-6);
  if (!roads.length) return { x: 0, z: 1 };
  // The back of the cave points where no road leaves; its mouth faces the opposite way.
  let best = { x: 0, z: -1 }, clearance = -Infinity;
  for (let step = 0; step < 32; step++) {
    const angle = step / 32 * Math.PI * 2, x = Math.cos(angle), z = Math.sin(angle);
    const nearest = Math.min(...roads.map(road => Math.acos(Math.max(-1, Math.min(1, road.x * x + road.z * z)))));
    if (nearest > clearance + 1e-6) { clearance = nearest; best = { x, z }; }
  }
  return { x: -best.x, z: -best.z };
}
