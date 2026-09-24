import { BoxGeometry, Color, ConeGeometry, CylinderGeometry, IcosahedronGeometry, SphereGeometry, TorusGeometry, type BufferGeometry, type Matrix4 } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { THEME_COLORS, type ExplorationSite, type ExplorationTheme } from './exploration-sites';
import { MergedBuilder, at } from './town-details';

type Tint = string | Color;
const tone = (value: Tint, amount: number) => new Color(value).multiplyScalar(amount);
const mix = (a: Tint, b: Tint, t: number) => new Color(a).lerp(new Color(b), t);
const noise = (value: number) => { const x = Math.sin(value * 12.9898) * 43758.5453; return x - Math.floor(x); };
const soft = (width: number, height: number, depth: number, radius = Math.min(width, height, depth) * .3) => new RoundedBoxGeometry(width, height, depth, 1, radius);
const PAINTED = new Set<ExplorationTheme>(['metro', 'rail']);
const GLOW = '#ffe7a3', CREAM = '#f6ecd4';

/** Warm, light woods keep every theme in the pastel field palette; the theme wood only tints them. */
function woods(theme: ExplorationTheme) {
  const colors = THEME_COLORS[theme];
  return { ...colors, plank: mix(colors.wood, '#e3bf88', .55), post: mix(colors.wood, '#b88a57', .3), beam: tone(colors.wood, .9),
    rail: PAINTED.has(theme) ? mix(colors.accent, '#ffffff', .12) : mix(colors.wood, '#d9ad74', .42), stone: mix(colors.stone, '#e4ddcc', .35) };
}

/** Round post with a squashed dome cap, rising from `y0` to `y1` in the given local frame. */
function addPost(builder: MergedBuilder, frame: Matrix4, x: number, z: number, y0: number, y1: number, radius: number, color: Tint, cap: Tint) {
  builder.add(new CylinderGeometry(radius, radius * 1.08, y1 - y0, 8), color, frame.clone().multiply(at(x, (y0 + y1) / 2, z)));
  builder.add(new SphereGeometry(radius * 1.22, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), cap, frame.clone().multiply(at(x, y1, z, 0, 1, .8, 1)));
}

/**
 * A plank bridge or jetty in the site's local frame (+z along `yaw`). The walking deck follows the rendered
 * ground, because the player stands on that surface; only the handrail arches over full crossings.
 */
export function bridgeGeometry(site: ExplorationSite, groundHeight: (x: number, z: number) => number): BufferGeometry {
  const builder = new MergedBuilder(), wood = woods(site.theme), frame = at(0, 0, 0);
  const length = Math.max(4, site.span ?? 7), half = length / 2, width = 2.25, pier = !!site.pier;
  const sin = Math.sin(site.yaw), cos = Math.cos(site.yaw), base = groundHeight(site.x, site.z);
  const local = (x: number, z: number) => groundHeight(site.x + x * cos + z * sin, site.z - x * sin + z * cos) - base;
  const deck = (z: number) => Math.max(local(-width, z), local(0, z), local(width, z)) + .12;
  const slope = (z: number) => Math.atan2(deck(z + .3) - deck(z - .3), .6);
  const arch = (z: number) => pier ? 0 : Math.sin(Math.PI * (z + half) / length) * Math.min(.28, length * .012);

  // Planks with small gaps and staggered tones; the ends tuck under the stone steps.
  const planks = Math.max(6, Math.round(length / .5));
  for (let index = 0; index < planks; index++) {
    const z = -half + (index + .5) * length / planks, jitter = noise(index + site.x * .1);
    builder.add(soft(width * 2 + (jitter - .5) * .12, .1, length / planks - .07, .03), tone(wood.plank, .92 + jitter * .14),
      at((jitter - .5) * .05, deck(z) - .05, z, 0, 1, 1, 1, -slope(z)));
  }
  // Fascia beams under both deck edges, piece by piece so they follow the deck.
  const posts = Math.max(2, Math.round(length / 2.4)), step = length / posts;
  for (let index = 0; index < posts; index++) {
    const z = -half + (index + .5) * step;
    for (const side of [-1, 1]) builder.add(soft(.16, .22, step + .02, .05), wood.beam, at(side * (width + .02), deck(z) - .16, z, 0, 1, 1, 1, -slope(z)));
  }
  // Posts double as pilings: they run below the waterline and carry an arched handrail and a lower rail.
  for (let index = 0; index <= posts; index++) {
    const z = -half + index * step, end = index === 0 || index === posts, y = deck(z);
    const top = y + .92 + arch(z) + (end && !(pier && index === posts) ? .1 : 0);
    for (const side of [-1, 1]) addPost(builder, frame, side * (width + .1), z, y - 1.3, top, end ? .15 : .1, wood.post, end ? wood.accent : wood.post);
    if (index === posts) break;
    const next = z + step, middle = (z + next) / 2;
    for (const side of [-1, 1]) {
      const rise = Math.atan2(deck(next) + arch(next) - deck(z) - arch(z), step);
      builder.add(soft(.12, .11, step - .12, .04), wood.rail, at(side * (width + .1), deck(middle) + arch(middle) + .84, middle, 0, 1, 1, 1, -rise));
      builder.add(soft(.07, .07, step - .12, .025), tone(wood.rail, .9), at(side * (width + .1), deck(middle) + arch(middle) * .6 + .42, middle, 0, 1, 1, 1, -rise));
    }
  }
  // Stone steps and chunky bank stones at every land end.
  for (const end of pier ? [-1] : [-1, 1]) {
    const z = end * (half + .25), y = deck(end * half);
    builder.add(soft(width * 2 + .5, .2, .7, .06), wood.stone, at(0, y - .1, z));
    for (const side of [-1, 1]) {
      builder.add(new IcosahedronGeometry(.42, 1), tone(wood.stone, .9 + noise(side + end) * .12), at(side * (width + .62), y - .12, z + end * .15, side, 1.15, .72, 1));
      builder.add(new IcosahedronGeometry(.26, 1), tone(wood.stone, 1.05), at(side * (width + .45), y - .15, z + end * .7, side * 2, 1, .7, 1.1));
    }
  }
  if (pier) {
    // The open end: two mooring bollards with rope, a lantern and a striped life ring.
    const z = half - .35, y = deck(half);
    for (const side of [-1, 1]) {
      builder.add(new CylinderGeometry(.14, .16, .42, 10), tone(wood.post, .8), at(side * (width - .45), y + .21, z));
      builder.add(new TorusGeometry(.17, .045, 5, 12), '#d8c28f', at(side * (width - .45), y + .3, z, 0, 1, 1, 1, Math.PI / 2));
    }
    addPost(builder, frame, width + .1, half + .05, y, y + 2.05, .09, wood.post, wood.post);
    builder.add(new BoxGeometry(.05, .05, .42), tone(wood.post, .8), at(width + .1, y + 1.95, half - .15));
    builder.add(soft(.28, .34, .28, .06), GLOW, at(width + .1, y + 1.7, half - .36));
    builder.add(new ConeGeometry(.24, .18, 4), wood.accent, at(width + .1, y + 1.95, half - .36, Math.PI / 4));
    for (let quarter = 0; quarter < 4; quarter++) builder.add(new TorusGeometry(.3, .075, 6, 6, Math.PI / 2), quarter % 2 ? '#fbf6ec' : wood.accent,
      at(-(width + .22), y + .55, half - 1.4 - step, Math.PI / 2).multiply(at(0, 0, 0, 0, 1, 1, 1, 0, quarter * Math.PI / 2)));
  }
  return builder.build();
}

/** Short garden bollards on land and bobbing-style buoys on water mark long road edges. Origin at the ground. */
export function edgeMarkerGeometry(theme: ExplorationTheme, water: boolean): BufferGeometry {
  const builder = new MergedBuilder(), wood = woods(theme);
  if (water) {
    builder.add(new SphereGeometry(.34, 12, 8), '#fbf6ec', at(0, .02, 0, 0, 1, .72, 1));
    builder.add(new CylinderGeometry(.12, .3, .38, 12), wood.accent, at(0, .32, 0));
    builder.add(new CylinderGeometry(.125, .125, .09, 12), '#fbf6ec', at(0, .52, 0));
    builder.add(new SphereGeometry(.13, 10, 6), wood.accent, at(0, .6, 0, 0, 1, .8, 1));
    return builder.build();
  }
  builder.add(new CylinderGeometry(.2, .24, .12, 10), wood.stone, at(0, .06, 0));
  builder.add(new CylinderGeometry(.1, .115, .7, 8), wood.post, at(0, .47, 0));
  builder.add(new CylinderGeometry(.118, .118, .1, 8), wood.accent, at(0, .64, 0));
  builder.add(new SphereGeometry(.13, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), CREAM, at(0, .8, 0, 0, 1, .85, 1));
  return builder.build();
}

function addBench(builder: MergedBuilder, place: (x: number, y: number, z: number, rotationY?: number, tiltX?: number) => Matrix4, wood: ReturnType<typeof woods>, length: number) {
  for (const x of [-length / 2 + .25, length / 2 - .25]) {
    builder.add(soft(.14, .46, .5, .04), tone(wood.post, .8), place(x, .23, 0));
    builder.add(soft(.12, .62, .1, .04), tone(wood.post, .8), place(x, .72, -.24, 0, -.12));
  }
  for (const z of [-.15, .02, .19]) builder.add(soft(length, .07, .15, .03), tone(wood.plank, .95 + (z + .15) * .3), place(0, .5, z));
  for (const y of [.74, .92]) builder.add(soft(length - .1, .12, .06, .03), wood.plank, place(0, y, -.27 + (y - .74) * -.12, 0, -.12));
}

const restCache = new Map<ExplorationTheme, BufferGeometry>();
/** A roadside rest: slatted bench, a stone-ringed campfire and a stump seat. */
export function restSpotGeometry(theme: ExplorationTheme): BufferGeometry {
  let geometry = restCache.get(theme);
  if (geometry) return geometry;
  const builder = new MergedBuilder(), wood = woods(theme);
  const place = (x: number, y: number, z: number, rotationY = 0, tiltX = 0) => at(x, y, z, rotationY, 1, 1, 1, tiltX);
  addBench(builder, place, wood, 2.2);
  const fire = { x: -2, z: .55 };
  for (let stone = 0; stone < 9; stone++) {
    const angle = stone / 9 * Math.PI * 2;
    builder.add(new IcosahedronGeometry(.15, 1), tone(wood.stone, .88 + noise(stone) * .2), at(fire.x + Math.cos(angle) * .5, .07, fire.z + Math.sin(angle) * .5, angle, 1.2, .75, 1));
  }
  for (let log = 0; log < 3; log++) {
    const angle = log / 3 * Math.PI * 2 + .4;
    builder.add(new CylinderGeometry(.06, .07, .62, 6), tone(wood.wood, 1.1), at(fire.x + Math.cos(angle) * .12, .16, fire.z + Math.sin(angle) * .12, -angle, 1, 1, 1, 0, 1.05));
  }
  builder.add(new ConeGeometry(.2, .5, 7), '#ff9d47', at(fire.x, .38, fire.z));
  builder.add(new ConeGeometry(.11, .32, 6), '#ffe27a', at(fire.x + .03, .33, fire.z + .03));
  builder.add(new CylinderGeometry(.27, .3, .42, 12), tone(wood.wood, 1.05), at(2.05, .21, .55));
  builder.add(new CylinderGeometry(.24, .24, .03, 12), '#e7c996', at(2.05, .43, .55));
  restCache.set(theme, geometry = builder.build());
  return geometry;
}

const lookoutCache = new Map<ExplorationTheme, BufferGeometry>();
/** A round plank platform with a curved rail and a coin viewer, facing local -z. */
export function lookoutGeometry(theme: ExplorationTheme): BufferGeometry {
  let geometry = lookoutCache.get(theme);
  if (geometry) return geometry;
  const builder = new MergedBuilder(), wood = woods(theme), frame = at(0, 0, 0);
  builder.add(new CylinderGeometry(2.25, 2.4, .26, 20), wood.stone, at(0, .1, 0));
  for (let row = -4; row <= 4; row++) {
    const z = row * .44, chord = Math.sqrt(Math.max(0, 2.05 ** 2 - z * z)) * 2;
    builder.add(soft(chord, .08, .38, .03), tone(wood.plank, .94 + noise(row) * .12), at(0, .27, z));
  }
  // Rail around the far half, opening toward the road.
  const posts = 7;
  for (let index = 0; index < posts; index++) {
    const angle = Math.PI * (1.08 + index / (posts - 1) * .84), x = Math.cos(angle) * 2.02, z = Math.sin(angle) * 2.02;
    addPost(builder, frame, x, z, .25, 1.18, .08, wood.post, index === 0 || index === posts - 1 ? wood.accent : wood.post);
    if (index === posts - 1) break;
    const next = Math.PI * (1.08 + (index + 1) / (posts - 1) * .84), nx = Math.cos(next) * 2.02, nz = Math.sin(next) * 2.02;
    const length = Math.hypot(nx - x, nz - z), yaw = Math.atan2(nx - x, nz - z);
    builder.add(soft(.1, .1, length, .035), wood.rail, at((x + nx) / 2, 1.08, (z + nz) / 2, yaw));
    builder.add(soft(.06, .06, length, .02), tone(wood.rail, .9), at((x + nx) / 2, .68, (z + nz) / 2, yaw));
  }
  // Coin viewer on a pedestal.
  builder.add(new CylinderGeometry(.2, .26, .14, 10), tone(wood.stone, .85), at(0, .37, -.9));
  builder.add(new CylinderGeometry(.06, .08, .9, 8), '#6f7a7e', at(0, .85, -.9));
  builder.add(soft(.5, .32, .36, .1), wood.accent, at(0, 1.38, -.9, 0, 1, 1, 1, .18));
  for (const side of [-1, 1]) {
    builder.add(new CylinderGeometry(.09, .1, .26, 10), tone(wood.accent, .85), at(side * .12, 1.43, -1.13, 0, 1, 1, 1, Math.PI / 2 + .18));
    builder.add(new CylinderGeometry(.075, .075, .03, 10), '#bfe3ef', at(side * .12, 1.455, -1.26, 0, 1, 1, 1, Math.PI / 2 + .18));
  }
  lookoutCache.set(theme, geometry = builder.build());
  return geometry;
}

const signpostCache = new Map<ExplorationTheme, BufferGeometry>();
/** Junction signpost frame: stone footing, round post and a little roofed cap. Direction boards stay separate. */
export function signpostGeometry(theme: ExplorationTheme): BufferGeometry {
  let geometry = signpostCache.get(theme);
  if (geometry) return geometry;
  const builder = new MergedBuilder(), wood = woods(theme);
  builder.add(new CylinderGeometry(.34, .42, .22, 10), wood.stone, at(0, .11, 0));
  builder.add(new CylinderGeometry(.13, .16, 2.7, 10), wood.post, at(0, 1.45, 0));
  builder.add(new CylinderGeometry(.19, .19, .12, 10), tone(wood.post, .8), at(0, 2.78, 0));
  builder.add(new ConeGeometry(.36, .34, 4), wood.accent, at(0, 3.01, 0, Math.PI / 4));
  builder.add(new SphereGeometry(.08, 8, 5), CREAM, at(0, 3.2, 0));
  signpostCache.set(theme, geometry = builder.build());
  return geometry;
}
