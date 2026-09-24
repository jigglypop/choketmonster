import { CylinderGeometry, type BufferGeometry } from 'three';
import type { CaveScene } from './caves';
import type { DungeonProp, DungeonPropKind } from './dungeon-rooms';
import type { DungeonStyle } from './dungeons';
import { PartBuilder, jitter, mix, place, tone, type Tint } from './interior-kit';
import { wallBandSpots } from './interior-layout';
import type { ScenePoint } from './world-space';

export type RoomPalette = { floor: string; wall: string; trim: string; props: Partial<Record<DungeonPropKind, string>> };
/** Carved stone halls, timber towers, or plain buildings that only get a skirting and a cornice. */
export type StyleFamily = 'stone' | 'wood' | 'plain';
export const STYLE_FAMILY: Record<DungeonStyle, StyleFamily> = {
  rock: 'stone', ghost: 'stone', ruins: 'stone', stone: 'stone', sand: 'stone',
  pagoda: 'wood', bell: 'wood',
  charred: 'plain', lighthouse: 'plain', mansion: 'plain', industrial: 'plain', warehouse: 'plain',
};
export const ROOM_WALL_HEIGHT = 4.2;
const H = ROOM_WALL_HEIGHT;
const FIRE = '#ffa338', EMBER = '#ff6a24', PAPER = '#e9b872';

export type RoomWall = ScenePoint & { length: number; rotationY: number; inward: ScenePoint };
/** North, east, south and west walls; each plane faces into the room (local +z) and runs along local +x. */
export function roomWalls(halfWidth: number, halfDepth: number): RoomWall[] {
  return [
    { x: 0, z: -halfDepth, length: halfWidth * 2, rotationY: 0, inward: { x: 0, z: 1 } },
    { x: halfWidth, z: 0, length: halfDepth * 2, rotationY: -Math.PI / 2, inward: { x: -1, z: 0 } },
    { x: 0, z: halfDepth, length: halfWidth * 2, rotationY: Math.PI, inward: { x: 0, z: -1 } },
    { x: -halfWidth, z: 0, length: halfDepth * 2, rotationY: Math.PI / 2, inward: { x: 1, z: 0 } },
  ];
}

export type Built = { solid?: BufferGeometry; glow?: BufferGeometry };
const finish = (solid: PartBuilder, glow: PartBuilder): Built => ({ solid: solid.build(), glow: glow.build() });

/** A little clay urn or idol standing on `y`. */
function niche(solid: PartBuilder, glow: PartBuilder, style: DungeonStyle, palette: RoomPalette, x: number, seed: number) {
  const trim = palette.trim, light = mix(palette.wall, '#fff4dc', .22), recess = tone(palette.wall, .32);
  solid.box(x, 1.86, .012, 1.02, 1.66, .02, recess);
  for (const side of [-1, 1]) solid.block(x + side * .62, 1.86, .08, .2, 1.84, .16, trim);
  solid.block(x, .98, .15, 1.44, .13, .3, trim);
  solid.block(x, 2.86, .13, 1.56, .22, .26, trim);
  solid.block(x, 3.0, .15, .32, .32, .3, light);
  if (style === 'ghost') {
    for (const offset of [-.22, .2]) {
      solid.cylinder(x + offset, 1.04, .22, .05, .055, .22 + jitter(seed, offset) * .12, '#e9e1cf');
      glow.cone(x + offset, 1.3 + jitter(seed, offset) * .12, .22, .05, .14, '#ffd98a', 6);
    }
  } else if (style === 'sand') {
    solid.block(x, 1.2, .22, .34, .3, .3, mix(palette.wall, '#e8c98a', .4));
    solid.block(x, 1.5, .22, .22, .34, .22, mix(palette.wall, '#e8c98a', .5));
    solid.dome(x, 1.67, .22, .12, .1, .12, '#c79a3c');
  } else {
    const clay = jitter(seed, 3) > .5 ? '#9a6b4a' : '#7d7466';
    solid.cylinder(x, 1.04, .22, .1, .16, .06, clay);
    solid.add(new CylinderGeometry(.13, .19, .34, 12), place(x, 1.27, .22), clay, { top: tone(clay, 1.15) });
    solid.cylinder(x, 1.44, .22, .09, .12, .1, tone(clay, .9));
  }
}

/** The dressing on one wall, in its local frame: skirting, cornice, pilasters or posts, and niches or lattice windows. */
export function wallDressing(style: DungeonStyle, palette: RoomPalette, length: number, wallIndex: number, seed: number, tile: number): Built {
  const solid = new PartBuilder(tile), glow = new PartBuilder(tile), family = STYLE_FAMILY[style], half = length / 2;
  const trim = palette.trim, stone = mix(palette.wall, '#ffffff', .12), dark = tone(trim, .85);
  const moss = style === 'ruins' ? '#66803f' : undefined;
  if (family === 'wood') {
    const post = palette.props.post ?? '#5c3f27', beam = style === 'bell' ? palette.props.pillar ?? trim : tone(post, 1.1), gold = '#d4ae52';
    solid.block(0, .2, .12, length, .4, .24, '#8e887c');
    solid.box(0, 1.05, .1, length, .16, .12, beam);
    solid.box(0, 3.35, .11, length, .2, .14, beam);
    solid.box(0, H - .14, .17, length, .28, .34, tone(post, .9));
    if (style === 'bell') for (const y of [1.14, 3.46]) solid.box(0, y, .17, length, .035, .02, gold);
    const bays = Math.max(2, Math.round(length / 3.4)), bay = length / bays;
    for (let index = 0; index <= bays; index++) {
      const x = -half + index * bay, inset = index === 0 ? .2 : index === bays ? -.2 : 0;
      solid.block(x + inset, .5, .2, .5, .22, .5, '#9a9489');
      solid.box(x + inset, H / 2, .17, .32, H, .32, post);
    }
    for (let index = 0; index < bays; index++) {
      const x = -half + (index + .5) * bay, width = bay - .9;
      if ((index + wallIndex) % 2 === 0) {
        // Backlit shoji window between the rails.
        glow.box(x, 2.22, .02, width, 1.62, .02, tone(PAPER, .78));
        for (const y of [1.44, 3.0]) solid.box(x, y, .07, width + .08, .08, .08, tone(post, .85));
        for (const side of [-1, 1]) solid.box(x + side * width / 2, 2.22, .07, .08, 1.62, .08, tone(post, .85));
        for (let bar = 1; bar < 4; bar++) solid.box(x - width / 2 + bar * width / 4, 2.22, .06, .035, 1.56, .04, tone(post, .8));
        for (let bar = 1; bar < 3; bar++) solid.box(x, 1.44 + bar * .52, .06, width, .035, .04, tone(post, .8));
      } else {
        // A hanging scroll.
        solid.box(x, 2.3, .03, .74, 1.36, .02, '#efe6cf');
        solid.box(x, 2.3, .04, .5, 1.02, .02, mix('#efe6cf', palette.wall, .35));
        for (const y of [1.6, 3.0]) solid.cylinder(x, y - .03, .05, .03, .03, .06, dark, 6);
      }
    }
    return finish(solid, glow);
  }
  // Skirting and a two-step cornice.
  solid.block(0, .22, .1, length, .44, .2, dark, 0, .04);
  solid.box(0, H - .16, .2, length, .32, .4, trim, 0, moss ? mix(trim, moss, .35) : undefined);
  solid.box(0, H - .4, .09, length, .14, .18, tone(trim, 1.08));
  if (family === 'plain') {
    if (style === 'mansion') {
      // Panelled wainscot under a chair rail.
      solid.box(0, 1.1, .05, length, .1, .1, tone(trim, 1.2));
      const panels = Math.max(2, Math.round(length / 1.6));
      for (let index = 0; index < panels; index++) solid.block(-half + (index + .5) * length / panels, .76, .035, length / panels - .24, .5, .05, mix(palette.wall, trim, .35), 0, .02);
    } else if (style === 'industrial' || style === 'warehouse') {
      const ribs = Math.max(2, Math.round(length / 3));
      for (let index = 1; index < ribs; index++) solid.box(-half + index * length / ribs, H / 2, .09, .22, H, .18, tone(palette.wall, .78));
      solid.box(0, 2.6, .12, length, .1, .1, palette.trim);
    }
    return finish(solid, glow);
  }
  // Pilasters split the wall into bays; the corners get square piers.
  const bays = Math.max(2, Math.round(length / 4.4)), bay = length / bays;
  const pilasters = Array.from({ length: bays - 1 }, (_, index) => -half + (index + 1) * bay);
  const pilaster = (x: number, depth: number, index: number) => {
    const broken = style === 'ruins' && jitter(index + wallIndex * 13, seed) < .4;
    solid.block(x, .44 + .15, .04 + depth * .6, .98, .3, depth + .12, dark, 0, .05);
    if (broken) {
      const top = 1.1 + jitter(index, seed + 7) * 1.5;
      solid.box(x, .74 + (top - .74) / 2, depth / 2, .7, top - .74, depth, stone, 0, moss ? mix(stone, moss, .3) : undefined);
      solid.block(x + .05, top + .12, depth / 2 + .02, .66, .26, depth + .04, stone, 0, .06, [.1, .22]);
      return;
    }
    solid.box(x, (.74 + 3.56) / 2, depth / 2, .7, 2.82, depth, stone);
    if (style === 'sand') solid.add(new CylinderGeometry(.66, .44, .44, 4).rotateY(Math.PI / 4), place(x, 3.72, depth / 2 + .02, 1, 1, .6), trim);
    else {
      solid.box(x, 3.6, depth / 2 + .01, .8, .08, depth + .02, tone(trim, 1.1));
      solid.block(x, 3.76, depth / 2 + .04, 1.0, .24, depth + .1, trim, 0, .04);
    }
  };
  pilasters.forEach((x, index) => pilaster(x, .24, index));
  if (wallIndex % 2 === 0) for (const side of [-1, 1]) pilaster(side * (half - .36), .72, 9 + side);
  for (let index = 0; index < bays; index++) {
    const x = -half + (index + .5) * bay;
    if (style === 'ruins') {
      // Weathered relief slabs, some fallen away.
      if (jitter(index + wallIndex * 7, seed + 3) < .6) {
        solid.block(x, 1.9, .05, 1.7, 1.2, .1, mix(palette.wall, '#e3d4b0', .25), 0, .03);
        for (let glyph = 0; glyph < 6; glyph++) solid.box(x - .6 + (glyph % 3) * .6, 1.65 + Math.floor(glyph / 3) * .5, .11, .36, .26, .04, tone(palette.wall, .82));
      }
    } else if ((index + wallIndex) % 2 === 0 && bay > 2.2) niche(solid, glow, style, palette, x, index * 31 + wallIndex);
    if (style === 'sand') for (let glyph = 0; glyph < 5; glyph++) {
      const w = .18 + jitter(glyph + index * 5, seed + wallIndex) * .22;
      solid.box(x - .9 + glyph * .45, 3.28 + (glyph % 2) * .06, .025, w, .22, .03, tone(palette.wall, .78));
    }
    if (style === 'stone' || style === 'ghost') solid.box(x, 3.3, .03, bay - .8, .08, .06, mix(palette.wall, '#ffffff', .2));
  }
  return finish(solid, glow);
}

/** A stone brazier with its fire. Returns the flame's height for the light. */
export function brazier(solid: PartBuilder, glow: PartBuilder, x: number, y: number, z: number, stone: Tint, scale = 1): number {
  const s = scale;
  solid.block(x, y + .09 * s, z, .7 * s, .18 * s, .7 * s, tone(stone, .85), 0, .04);
  solid.add(new CylinderGeometry(.16 * s, .24 * s, .72 * s, 8), place(x, y + .54 * s, z), stone);
  solid.add(new CylinderGeometry(.5 * s, .28 * s, .32 * s, 12), place(x, y + 1.05 * s, z), '#4a3c33', { top: '#6e5a48' });
  solid.ring(x, y + 1.2 * s, z, .48 * s, .05 * s, '#7a6048');
  // Glowing coals under a cluster of slim tongues of flame.
  glow.dome(x, y + 1.1 * s, z, .36 * s, .1 * s, .36 * s, EMBER);
  glow.cone(x, y + 1.14 * s, z, .2 * s, .66 * s, FIRE, 6);
  glow.cone(x + .07 * s, y + 1.16 * s, z - .04 * s, .09 * s, .8 * s, '#ffd27a', 5);
  for (let tongue = 0; tongue < 3; tongue++) {
    const angle = tongue * 2.1 + x, reach = .17 * s;
    glow.cone(x + Math.cos(angle) * reach, y + 1.13 * s, z + Math.sin(angle) * reach, .09 * s, (.36 + tongue * .08) * s, tongue ? FIRE : EMBER, 5);
  }
  return y + 1.45 * s;
}

export type Glow = ScenePoint & { y: number; color: string };
export type Stain = ScenePoint & { radiusX: number; radiusZ: number; color: Tint; rotation?: number; wobble?: number };

/** Braziers, rubble and sand drifts standing in the band along the walls, the fires worth a light, and contact shadows and moss for the floor. */
export function floorDressing(scene: CaveScene, palette: RoomPalette, tile: number): Built & { fires: Glow[]; shadows: Stain[]; moss: Stain[] } {
  const solid = new PartBuilder(tile), glow = new PartBuilder(tile), fires: Glow[] = [], shadows: Stain[] = [], moss: Stain[] = [];
  const style = scene.style, seed = scene.relief.seed, spots = wallBandSpots(scene);
  if (style === 'stone' || style === 'ruins' || style === 'sand') {
    // Two braziers facing each other across the room's long axis.
    const room = scene.room!, long = room.halfWidth >= room.halfDepth ? [0, 2] : [1, 3];
    for (const side of long) {
      const onSide = spots.filter(spot => spot.side === side).sort((a, b) => Math.abs(a.along) - Math.abs(b.along));
      if (!onSide.length) continue;
      const spot = onSide[0], top = brazier(solid, glow, spot.x, 0, spot.z, mix(palette.wall, '#ffffff', .1));
      fires.push({ x: spot.x, y: top, z: spot.z, color: '#ffb266' });
      shadows.push({ x: spot.x, z: spot.z, radiusX: .95, radiusZ: .95, color: '#000000' });
    }
  }
  const free = spots.filter(spot => fires.every(fire => Math.hypot(fire.x - spot.x, fire.z - spot.z) > 1.6));
  free.forEach((spot, index) => {
    const pick = jitter(index, seed + 101);
    // Each pile keeps within the spot's footprint, so it stays on the closed band along the wall.
    if (style === 'ruins' && pick < .55) {
      const count = 3 + Math.floor(pick * 6);
      for (let rock = 0; rock < count; rock++) {
        const r = .12 + jitter(rock + index * 9, seed) * .16, angle = jitter(rock, index + seed) * Math.PI * 2, d = rock ? .06 + jitter(rock + 3, index) * .1 : 0;
        solid.rock(spot.x + Math.cos(angle) * d, r * .55, spot.z + Math.sin(angle) * d, r * 1.2, r, r * 1.05, mix(palette.wall, '#d9c9a4', jitter(rock, 5) * .3), rock + index, angle);
      }
      moss.push({ x: spot.x, z: spot.z, radiusX: 1.3, radiusZ: 1, color: '#46632c', rotation: pick * 3, wobble: index });
    } else if (style === 'sand' && pick < .7) {
      // Drifts heap up along the wall's foot.
      const along = .9 + pick * 1.1, across = .42;
      solid.dome(spot.x, -.02, spot.z, spot.side % 2 ? across : along, .26 + pick * .28, spot.side % 2 ? along : across, palette.props.sand ?? '#d9bd84', 0, mix(palette.props.sand ?? '#d9bd84', '#f2dcaa', .4));
    } else if (style === 'stone' && pick < .22) {
      const clay = pick < .1 ? '#8c6a4c' : '#7a7466';
      solid.add(new CylinderGeometry(.2, .27, .56, 12), place(spot.x, .28, spot.z), clay, { top: tone(clay, 1.18) });
      solid.cylinder(spot.x, .56, spot.z, .13, .17, .12, tone(clay, .9));
      shadows.push({ x: spot.x, z: spot.z, radiusX: .6, radiusZ: .6, color: '#000000' });
    }
  });
  if (style === 'ruins') for (let index = 0; index < 8; index++) {
    // Moss creeping over the floor near the walls.
    const x = (jitter(index, seed + 5) * 2 - 1) * (scene.room!.halfWidth - 1.8), z = (jitter(index, seed + 9) > .5 ? 1 : -1) * (scene.room!.halfDepth - 1.6 - jitter(index, seed + 13) * 1.5);
    moss.push({ x, z, radiusX: 1 + jitter(index, 3) * 1.4, radiusZ: .7 + jitter(index, 4), color: '#4f6b30', rotation: index, wobble: index * 3 });
  }
  return { ...finish(solid, glow), fires, shadows, moss };
}

/** Kinds `roomProps` models in detail; the rest keep their instanced blocks. */
export const DETAILED_PROPS = new Set<DungeonPropKind>(['column', 'pillar', 'post', 'screen', 'lantern', 'tablet', 'block', 'rubble', 'sand']);

function column(solid: PartBuilder, glow: PartBuilder, prop: DungeonProp, style: DungeonStyle, color: string, index: number, seed: number) {
  const r = prop.width / 2, h = prop.height, x = prop.x, z = prop.z, light = mix(color, '#ffffff', .12);
  if (style === 'lighthouse') {
    solid.cylinder(x, 0, z, r * 1.08, r * 1.14, .3, tone(color, .86));
    solid.cylinder(x, .3, z, r, r, h - .3, color, 24);
    for (const y of [1.2, 2.6, 4]) solid.cylinder(x, y, z, r * 1.02, r * 1.02, .14, '#9b4a3c', 24);
    return;
  }
  const broken = (style === 'stone' || style === 'ruins') && jitter(index, seed + 41) < .22;
  solid.block(x, .13, z, r * 2.5, .26, r * 2.5, tone(color, .82), 0, .05);
  solid.ring(x, .33, z, r * .98, .09, tone(color, .92));
  const top = broken ? h * (.45 + jitter(index, seed + 43) * .3) : h - .52;
  if (style === 'sand') {
    solid.cylinder(x, .3, z, r * .84, r * .92, top - .3, color, 16);
    for (const y of [.9, top - .5]) solid.cylinder(x, y, z, r * .9, r * .9, .1, tone(color, .82), 16);
  } else solid.fluted(x, .3, z, r * .8, r * .9, top - .3, color, 12, light);
  if (broken) {
    solid.add(new CylinderGeometry(r * .8, r * .8, .22, 12), place(x + .04, top + .08, z, 1, 1, 1, index, .18, -.12), light);
    return;
  }
  if (style === 'sand') solid.add(new CylinderGeometry(r * 1.3, r * .8, .5, 16), place(x, top + .25, z), mix(color, '#e8c98a', .3));
  else {
    solid.cylinder(x, top, z, r * 1.08, r * .82, .24, light);
    solid.block(x, top + .36, z, r * 2.5, .24, r * 2.5, tone(color, .9), 0, .04);
  }
  void glow;
}

function pillar(solid: PartBuilder, glow: PartBuilder, prop: DungeonProp, style: DungeonStyle, color: string) {
  const r = prop.width / 2, h = prop.height, x = prop.x, z = prop.z, bell = style === 'bell';
  // Lotus stone base, lacquered octagonal trunk, a sacred rope with paper streamers and a bracketed head.
  solid.add(new CylinderGeometry(r * 1.05, r * 1.32, .42, 16), place(x, .21, z), '#8e887c', { top: '#a39d90' });
  solid.cylinder(x, .42, z, r, r, h - .9, color, 8);
  if (bell) for (const y of [.9, h - 1.05]) solid.cylinder(x, y, z, r * 1.03, r * 1.03, .12, '#d4ae52', 8);
  solid.ring(x, 2.35, z, r * 1.04, .09, '#d8c9a0', 16);
  for (let streamer = 0; streamer < 6; streamer++) {
    const angle = streamer / 6 * Math.PI * 2;
    solid.box(x + Math.cos(angle) * (r + .1), 2.05, z + Math.sin(angle) * (r + .1), .12, .42, .02, '#f4efe2', -angle + Math.PI / 2);
  }
  // A slim bracketed head: anything wider would hide the partner from the overhead camera.
  solid.cylinder(x, h - .48, z, r * 1.12, r * 1.02, .26, tone(color, .85), 8);
  solid.block(x, h - .11, z, r * 2.3, .22, r * .55, tone(color, .78), 0, .03);
  solid.block(x, h - .11, z, r * .55, .22, r * 2.3, tone(color, .78), 0, .03);
  void glow;
}

function lantern(solid: PartBuilder, glow: PartBuilder, prop: DungeonProp, style: DungeonStyle, color: string): Glow {
  const x = prop.x, z = prop.z;
  if (style === 'lighthouse') {
    solid.cylinder(x, 0, z, .16, .2, .12, '#4a4f52');
    solid.cylinder(x, .12, z, .05, .05, 1.1, '#4a4f52', 8);
    glow.box(x, 1.36, z, .26, .32, .26, '#fff0b8');
    solid.cone(x, 1.52, z, .24, .16, '#4a4f52', 4, Math.PI / 4);
    return { x, y: 1.36, z, color: '#fff0c8' };
  }
  // A stone tōrō: plinth, post, deck, lit firebox, flared roof and finial.
  const stone = '#9d978b';
  solid.block(x, .1, z, .56, .2, .56, tone(stone, .9), 0, .04);
  solid.cylinder(x, .2, z, .09, .11, .62, stone, 8);
  solid.block(x, .88, z, .5, .1, .5, stone, 0, .02);
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) solid.box(x + dx * .15, 1.1, z + dz * .15, .06, .34, .06, stone);
  glow.box(x, 1.1, z, .26, .28, .26, color);
  solid.add(new CylinderGeometry(.08, .44, .26, 4), place(x, 1.4, z, 1, 1, 1, Math.PI / 4), tone(stone, .85));
  solid.dome(x, 1.53, z, .07, .1, .07, tone(stone, .8));
  return { x, y: 1.1, z, color: style === 'bell' ? '#ffc76a' : '#ffb45e' };
}

/**
 * Furniture modelled in detail: fluted columns, lacquered pillars, shoji screens, stone lanterns, carved steles,
 * masonry and drifts. Everything stays inside each prop's footprint, so walking is unchanged.
 */
export function roomProps(scene: CaveScene, palette: RoomPalette, tile: number): Built & { lanterns: Glow[] } {
  const solid = new PartBuilder(tile), glow = new PartBuilder(tile), lanterns: Glow[] = [], style = scene.style, seed = scene.relief.seed;
  const color = (kind: DungeonPropKind, fallback: string) => palette.props[kind] ?? fallback;
  scene.room!.props.forEach((prop, index) => {
    const { x, z, width, depth, height } = prop;
    if (prop.kind === 'column') column(solid, glow, prop, style, color('column', '#a3a09a'), index, seed);
    else if (prop.kind === 'pillar') pillar(solid, glow, prop, style, color('pillar', '#6a4a2e'));
    else if (prop.kind === 'post') {
      const r = width / 2, wood = color('post', '#5c3f27');
      solid.add(new CylinderGeometry(r * 1.2, r * 1.45, .3, 10), place(x, .15, z), '#8e887c');
      solid.cylinder(x, .3, z, r, r * 1.04, height - .3, wood, 10, tone(wood, 1.12));
      if (style !== 'charred') solid.block(x, height - .1, z, r * 3.2, .2, r * 1.4, tone(wood, .85), 0, .03);
    } else if (prop.kind === 'screen') {
      const along = width >= depth, length = along ? width : depth, frame = tone(palette.props.post ?? '#5c3f27', 1.05), rotation = along ? 0 : Math.PI / 2;
      const local = (u: number, v: number) => along ? [x + u, z + v] : [x + v, z - u];
      const panels = Math.max(2, Math.round(length / 1.1)), panelWidth = length / panels;
      for (let panel = 0; panel < panels; panel++) {
        const u = -length / 2 + (panel + .5) * panelWidth, [px, pz] = local(u, 0);
        solid.box(px, height / 2 + .05, pz, panelWidth - .1, height - .3, .04, '#f1e7cf', rotation);
        for (const side of [-1, 1]) { const [bx, bz] = local(u + side * (panelWidth / 2 - .03), 0); solid.box(bx, height / 2, bz, .06, height, .16, frame, rotation); }
        for (let bar = 1; bar < 4; bar++) { const [lx, lz] = local(u, 0); solid.box(lx, .2 + bar * (height - .4) / 4, lz, panelWidth - .1, .03, .1, frame, rotation); }
        const [cx, cz] = local(u, 0); solid.box(cx, height / 2 + .05, cz, .03, height - .3, .1, frame, rotation);
      }
      for (const y of [.08, height - .06]) solid.box(x, y, z, along ? length : .18, .12, along ? .18 : length, frame);
    } else if (prop.kind === 'lantern') lanterns.push(lantern(solid, glow, prop, style, color('lantern', '#ffc76a')));
    else if (prop.kind === 'tablet') {
      // A stele facing into the room: base, slab with a rounded head and carved glyph rows.
      const stone = color('tablet', '#b3a47f'), facing = x > 0 ? -1 : 1;
      solid.block(x, .1, z, .44, .2, depth + .1, tone(stone, .85), 0, .04);
      solid.block(x, .2 + (height - .5) / 2, z, width, height - .5, depth * .86, stone, 0, .03);
      solid.add(new CylinderGeometry(depth * .43, depth * .43, width, 16, 1, false, 0, Math.PI), place(x, height - .3, z, 1, 1, 1, 0, 0, Math.PI / 2), stone);
      for (let row = 0; row < 4; row++) for (let glyph = 0; glyph < 3; glyph++)
        solid.box(x + facing * width / 2, .5 + row * .24, z - .36 + glyph * .36, .03, .14, .22 + jitter(row * 3 + glyph, index) * .08, tone(stone, .7));
    } else if (prop.kind === 'block') {
      const stone = color('block', '#8f8268'), tilt = (jitter(index, seed) - .5) * .12;
      solid.block(x, height * .42, z, width * .96, height * .84, depth * .96, stone, tilt, .08);
      solid.block(x + (jitter(index, 2) - .5) * .1, height * .92, z, width * .7, height * .18, depth * .66, mix(stone, '#ffffff', .1), -tilt * 2, .05, [(jitter(index, 5) - .5) * .12, 0]);
      solid.box(x, height * .55, z, width * .98, .06, depth * .98, tone(stone, .8), tilt);
    } else if (prop.kind === 'rubble') {
      const stone = color('rubble', '#6f6c66'), r = width / 2;
      for (let rock = 0; rock < 6; rock++) {
        const angle = rock / 6 * Math.PI * 2 + index, d = rock ? r * .5 : 0, size = rock ? r * .42 : r * .62;
        solid.rock(x + Math.cos(angle) * d, size * .6, z + Math.sin(angle) * d, size * 1.2, size * (rock ? .9 : 1.1), size, mix(stone, '#ffffff', jitter(rock, index) * .15), rock + index, angle);
      }
    } else if (prop.kind === 'sand') {
      const sand = color('sand', '#d9bd84'), r = width / 2;
      solid.dome(x, -.04, z, r, height, r, tone(sand, .92), index, mix(sand, '#f6e2b4', .45));
      solid.dome(x + r * .3, -.02, z - r * .25, r * .55, height * .7, r * .5, sand, index + 1, mix(sand, '#f6e2b4', .35));
    }
  });
  return { ...finish(solid, glow), lanterns };
}
