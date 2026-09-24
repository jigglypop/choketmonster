import type { DungeonStyle } from './dungeons';
import type { ScenePoint } from './world-space';

export type DungeonPropKind = 'pillar' | 'post' | 'grave' | 'candle' | 'machine' | 'generator' | 'pipe' | 'statue' | 'partition'
  | 'screen' | 'shelf' | 'table' | 'beam' | 'hole' | 'rubble' | 'crate' | 'lantern' | 'tablet' | 'block' | 'column' | 'rug' | 'sand';
/** Axis-aligned furniture. Blocking props are walls to movement; the rest is decoration. */
export type DungeonProp = { kind: DungeonPropKind; x: number; z: number; width: number; depth: number; height: number; round?: boolean; blocking: boolean };
export type DungeonRoom = { halfWidth: number; halfDepth: number; props: readonly DungeonProp[] };

/** Walls stop the partner this far from the room edge. */
export const ROOM_WALL_CLEARANCE = 1.4;
const PROP_CLEARANCE = .7, LINK_CLEARANCE = 4.2, GRID = .75;

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => { state = state + 0x6d2b79f5 >>> 0; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export function propBlocks(prop: DungeonProp, x: number, z: number, margin = PROP_CLEARANCE): boolean {
  if (!prop.blocking) return false;
  if (prop.round) return Math.hypot(x - prop.x, z - prop.z) <= Math.max(prop.width, prop.depth) / 2 + margin;
  return Math.abs(x - prop.x) <= prop.width / 2 + margin && Math.abs(z - prop.z) <= prop.depth / 2 + margin;
}

export function roomBlocked(room: Pick<DungeonRoom, 'halfWidth' | 'halfDepth' | 'props'>, x: number, z: number): boolean {
  return Math.abs(x) > room.halfWidth - ROOM_WALL_CLEARANCE || Math.abs(z) > room.halfDepth - ROOM_WALL_CLEARANCE
    || room.props.some(prop => propBlocks(prop, x, z));
}

const box = (kind: DungeonPropKind, x: number, z: number, width: number, depth: number, height: number, blocking = true): DungeonProp => ({ kind, x, z, width, depth, height, blocking });
const round = (kind: DungeonPropKind, x: number, z: number, radius: number, height: number, blocking = true): DungeonProp => ({ kind, x, z, width: radius * 2, depth: radius * 2, height, round: true, blocking });

/** Deterministic furniture for one floor, before stairs clearings are applied. */
function furnish(style: DungeonStyle, next: () => number, hw: number, hd: number, floorIndex: number, floorCount: number): DungeonProp[] {
  const props: DungeonProp[] = [], within = (range: number) => (next() * 2 - 1) * range;
  const posts = (radius: number, height: number, kind: DungeonPropKind = 'post') => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) props.push(round(kind, sx * hw * .5, sz * hd * .5, radius, height));
  };
  if (style === 'ghost') {
    props.push(box('rug', 0, 0, 2.4, hd * 2 - 4, .02, false));
    for (let z = -hd + 4.2; z <= hd - 4.2; z += 3) for (let x = -hw + 4.4; x <= hw - 4.4; x += 3.3) {
      if (Math.abs(x) < 2.2 || next() < .26) continue;
      const gx = x + within(.35);
      props.push(box('grave', gx, z, 1.05, .45, 1.1));
      if (next() < .35) props.push(round('candle', gx + .75, z - .45, .09, .32, false));
    }
  } else if (style === 'pagoda' || style === 'bell') {
    // Sprout Tower's floors turn around the swaying central pillar.
    props.push(round('pillar', 0, 0, style === 'pagoda' ? 1.35 : 1.1, 4.6));
    posts(.34, 4.2);
    for (let index = 0; index < 2 + (floorIndex % 2); index++) {
      const alongX = next() < .5, length = 3.4 + next() * 1.8;
      const x = alongX ? within(hw * .45) : (next() < .5 ? -1 : 1) * hw * (.3 + next() * .25);
      const z = alongX ? (next() < .5 ? -1 : 1) * hd * (.3 + next() * .25) : within(hd * .45);
      props.push(box('screen', x, z, alongX ? length : .32, alongX ? .32 : length, 2.1));
    }
    for (const sx of [-1, 1]) props.push(box('lantern', sx * (hw - 1.1), 0, .5, .5, 1.6, false));
  } else if (style === 'charred') {
    posts(.4, 2.2 + next() * 1.4);
    for (let index = 0; index < 4; index++) {
      const alongX = next() < .5, length = 4.6 + next() * 3.2;
      props.push(box('beam', within(hw * .55), within(hd * .55), alongX ? length : .7, alongX ? .7 : length, .6));
    }
    for (let index = 0; index < 2 + floorIndex; index++) props.push(round('hole', within(hw * .6), within(hd * .6), 1 + next() * .6, .02));
    for (let index = 0; index < 4; index++) props.push(round('rubble', within(hw * .7), within(hd * .7), .55 + next() * .35, .55));
  } else if (style === 'lighthouse') {
    props.push(round('column', 0, 0, 1.9, 4.6));
    for (let index = 0; index < 2; index++) props.push(box('crate', (next() < .5 ? -1 : 1) * (hw - 2.4), within(hd * .4), 1.2, 1.2, 1.1));
    for (const sz of [-1, 1]) props.push(box('lantern', 0, sz * (hd - 1.1), .5, .5, 1.6, false));
  } else if (style === 'mansion') {
    // One ruined partition with a doorway, statues and scattered furniture.
    const wallX = (next() < .5 ? -1 : 1) * hw * (.18 + next() * .16), gap = within(hd * .45), gapHalf = 2.1;
    const lower = -hd + ROOM_WALL_CLEARANCE, upper = hd - ROOM_WALL_CLEARANCE;
    props.push(box('partition', wallX, (lower + gap - gapHalf) / 2, .45, gap - gapHalf - lower, 2.6));
    props.push(box('partition', wallX, (gap + gapHalf + upper) / 2, .45, upper - gap - gapHalf, 2.6));
    for (let index = 0; index < 2; index++) props.push(round('statue', within(hw * .6), within(hd * .5), .6, 1.9));
    props.push(box('table', -wallX * 1.4, within(hd * .3), 2.1, 1.2, .85));
    for (const sz of [-1, 1]) props.push(box('shelf', within(hw * .5), sz * (hd - 1.7), 2.6, .6, 2.2));
    props.push(box('rug', -wallX * 1.4, 0, 4.4, 3.2, .02, false));
    if (floorIndex !== floorCount - 1) props.push(round('hole', within(hw * .5), within(hd * .5), 1.1, .02));
  } else if (style === 'industrial') {
    for (const sz of [-1, 1]) for (let x = -hw + 5.5; x <= hw - 5.5; x += 4.4) if (next() < .78) props.push(box('machine', x + within(.3), sz * hd * .4, 2.8, 1.8, 2.3));
    props.push(round('generator', -hw * .22, 0, 1.15, 2.1), round('generator', hw * .22, 0, 1.15, 2.1));
    for (const sz of [-1, 1]) props.push(box('pipe', 0, sz * (hd - .95), hw * 2 - 2.4, .36, .36, false));
  } else if (style === 'ruins') {
    for (const sx of [-1, 1]) for (let z = -hd + 2.5; z <= hd - 2.5; z += 3) props.push(box('tablet', sx * (hw - .5), z, .25, 1.4, 1.6, false));
    props.push(box('block', 0, 0, 2, 1.2, .8));
    for (let index = 0; index < 3; index++) props.push(box('block', within(hw * .55), within(hd * .5), 1.1, 1.1, .9));
  } else if (style === 'stone') {
    for (let index = 0; index < 6; index++) {
      const angle = index / 6 * Math.PI * 2 + floorIndex * .4;
      props.push(round('column', Math.cos(angle) * hw * .5, Math.sin(angle) * hd * .5, .55, 4.2));
    }
    for (let index = 0; index < 3; index++) props.push(round('rubble', within(hw * .6), within(hd * .6), .5 + next() * .3, .5));
  } else if (style === 'sand') {
    for (let index = 0; index < 4 + floorIndex; index++) props.push(round('sand', within(hw * .6), within(hd * .6), 1.1 + next() * .7, .7));
    posts(.55, 2 + next() * 1.6, 'column');
  } else if (style === 'warehouse') {
    for (let index = 0; index < 5; index++) {
      const x = within(hw * .6), z = within(hd * .6), stacked = next() < .4;
      props.push(box('crate', x, z, 1.5, 1.5, stacked ? 2.8 : 1.4));
    }
    props.push(box('machine', within(hw * .3), (next() < .5 ? -1 : 1) * hd * .45, 5, 2.2, 2.4));
  }
  return props;
}

function unreachable(room: DungeonRoom, from: ScenePoint, targets: readonly ScenePoint[]): number {
  const columns = Math.ceil(room.halfWidth * 2 / GRID) + 1, rows = Math.ceil(room.halfDepth * 2 / GRID) + 1;
  const cell = (point: ScenePoint) => [Math.round((point.x + room.halfWidth) / GRID), Math.round((point.z + room.halfDepth) / GRID)] as const;
  const open = (column: number, row: number) => column >= 0 && row >= 0 && column < columns && row < rows
    && !roomBlocked(room, column * GRID - room.halfWidth, row * GRID - room.halfDepth);
  const seen = new Uint8Array(columns * rows), queue: number[] = [];
  const [startColumn, startRow] = cell(from);
  if (open(startColumn, startRow)) { seen[startRow * columns + startColumn] = 1; queue.push(startRow * columns + startColumn); }
  for (let head = 0; head < queue.length; head++) {
    const column = queue[head] % columns, row = Math.floor(queue[head] / columns);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nextColumn = column + dx, nextRow = row + dz, index = nextRow * columns + nextColumn;
      if (!open(nextColumn, nextRow) || seen[index]) continue;
      seen[index] = 1; queue.push(index);
    }
  }
  return targets.findIndex(target => { const [column, row] = cell(target); return !seen[row * columns + column]; });
}

/** Furniture that never covers stairs or doors and always leaves every doorway reachable from the others. */
export function roomLayout(style: DungeonStyle, seed: number, halfWidth: number, halfDepth: number, links: readonly ScenePoint[], floorIndex: number, floorCount: number): DungeonRoom {
  const next = random(seed);
  const reach = (prop: DungeonProp) => Math.max(prop.width, prop.depth) / 2;
  const props = furnish(style, next, halfWidth, halfDepth, floorIndex, floorCount)
    .filter(prop => !prop.blocking || !links.some(link => Math.abs(link.x - prop.x) < LINK_CLEARANCE + (prop.round ? reach(prop) : prop.width / 2)
      && Math.abs(link.z - prop.z) < LINK_CLEARANCE + (prop.round ? reach(prop) : prop.depth / 2)));
  const room = { halfWidth, halfDepth, props };
  for (let guard = 0; links.length > 1 && guard < 64; guard++) {
    const missing = unreachable(room, links[0], links.slice(1));
    if (missing < 0) break;
    const from = links[0], target = links[missing + 1], dx = target.x - from.x, dz = target.z - from.z, length = dx * dx + dz * dz || 1;
    const offPath = (prop: DungeonProp) => {
      const t = Math.max(0, Math.min(1, ((prop.x - from.x) * dx + (prop.z - from.z) * dz) / length));
      return Math.hypot(prop.x - from.x - dx * t, prop.z - from.z - dz * t) - reach(prop);
    };
    const blocking = room.props.filter(prop => prop.blocking);
    if (!blocking.length) break;
    // Clear the obstruction nearest the straight walk to the unreachable doorway, then check again.
    const nearest = blocking.reduce((best, prop) => offPath(prop) < offPath(best) ? prop : best);
    room.props = room.props.filter(prop => prop !== nearest);
  }
  return room;
}
