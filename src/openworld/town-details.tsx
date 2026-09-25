import { useEffect, useMemo, useState } from 'react';
import {
  BoxGeometry, BufferGeometry, CircleGeometry, Color, ConeGeometry, CylinderGeometry, Float32BufferAttribute, IcosahedronGeometry, Matrix3, Matrix4,
  MeshStandardMaterial, OctahedronGeometry, Quaternion, SphereGeometry, TorusGeometry, Vector3,
} from 'three';
import type { WorldAtlas } from './atlas';
import type { WorldSample } from './types';
import { THEME_COLORS, type ExplorationTheme } from './exploration-sites';
import { cachedSceneryPlacements } from './scenery';
import { PAVING_CELL, createWorldDetails, type DetailKind, type TownLayout, type TownProp, type WorldDetails } from './world-details';
import { releaseOnDetach } from '../three/render-objects';

type Tint = string | Color;
const scratch = { position: new Vector3(), normal: new Vector3(), color: new Color(), axis: new Vector3() };

/** Accumulates transformed primitives into one non-indexed, vertex-coloured geometry. */
export class MergedBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];

  add(source: BufferGeometry, tint: Tint, matrix: Matrix4, options: { top?: Tint; height?: number; soft?: number } = {}): this {
    const geometry = source.index ? source.toNonIndexed() : source;
    const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
    const normalMatrix = new Matrix3().getNormalMatrix(matrix);
    const bottom = new Color(tint), top = options.top ? new Color(options.top) : bottom, height = options.height ?? 1, soft = options.soft ?? 0;
    for (let index = 0; index < position.count; index++) {
      const localY = position.getY(index);
      scratch.position.fromBufferAttribute(position, index).applyMatrix4(matrix);
      scratch.normal.fromBufferAttribute(normal, index).applyMatrix3(normalMatrix).normalize();
      // Foliage uses up-biased normals so thin blades read as soft tufts instead of dark facets.
      if (soft) scratch.normal.multiplyScalar(1 - soft).add(scratch.axis.set(0, soft, 0)).normalize();
      scratch.color.copy(bottom).lerp(top, Math.max(0, Math.min(1, localY / height + .5)));
      this.positions.push(scratch.position.x, scratch.position.y, scratch.position.z);
      this.normals.push(scratch.normal.x, scratch.normal.y, scratch.normal.z);
      this.colors.push(scratch.color.r, scratch.color.g, scratch.color.b);
    }
    if (geometry !== source) geometry.dispose();
    source.dispose();
    return this;
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    geometry.computeBoundingSphere();
    return geometry;
  }
}

export function at(x: number, y: number, z: number, rotationY = 0, sx = 1, sy = sx, sz = sx, tiltX = 0, tiltZ = 0): Matrix4 {
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rotationY);
  if (tiltX || tiltZ) rotation.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), tiltX)).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), tiltZ));
  return new Matrix4().compose(new Vector3(x, y, z), rotation, new Vector3(sx, sy, sz));
}
const shade = (value: Tint, amount: number) => new Color(value).multiplyScalar(amount);
const mixed = (a: Tint, b: Tint, t: number) => new Color(a).lerp(new Color(b), t);

let sharedMaterial: MeshStandardMaterial | undefined;
/** One vertex-coloured material shared by every procedural detail kind. It is never disposed, so every mesh
 * drawn with it frees its own render objects when it unmounts (see render-objects). */
export function detailMaterial(): MeshStandardMaterial {
  return sharedMaterial ??= new MeshStandardMaterial({ vertexColors: true, roughness: .86, metalness: 0 });
}

const GRASS = ['#5aa64a', '#bde482'] as const;
const LEAF = ['#62b152', '#74c35e'] as const;
const FLOWERS = ['#ffe169', '#fff8ec', '#ff9fc6', '#b9a3f5', '#ff9f7a'] as const;

function addBlades(builder: MergedBuilder, count: number, radius: number, salt: number, heightScale = 1) {
  for (let blade = 0; blade < count; blade++) {
    const angle = blade / count * Math.PI * 2 + Math.sin(blade * 7.1 + salt) * .5;
    const reach = radius * (.35 + .65 * Math.abs(Math.sin(blade * 3.7 + salt)));
    const height = (.38 + .24 * Math.abs(Math.cos(blade * 5.3 + salt))) * heightScale;
    builder.add(new ConeGeometry(.05, height, 3, 1, true), GRASS[0],
      at(Math.cos(angle) * reach, height / 2, Math.sin(angle) * reach, angle, 1, 1, 1, Math.cos(angle) * .32, -Math.sin(angle) * .32),
      { top: GRASS[1], height, soft: .6 });
  }
}

/** A bloom on a thin stem: a flat, open head with a small centre, so it reads as a flower rather than a bead. */
function addFlower(builder: MergedBuilder, base: Matrix4, color: Tint, height = .34, size = .09) {
  builder.add(new ConeGeometry(.016, height, 3, 1, true), '#5a9e48', base.clone().multiply(at(0, height / 2, 0)), { soft: .5 });
  builder.add(new IcosahedronGeometry(size, 0), color, base.clone().multiply(at(0, height + size * .2, 0, 0, 1.15, .38, 1.15)), { soft: .35 });
  builder.add(new IcosahedronGeometry(size * .34, 0), '#ffd35a', base.clone().multiply(at(0, height + size * .42, 0, 0, 1, .5, 1)), { soft: .35 });
}

/** Procedural instanced detail kinds; route posts take the region palette. */
export function createDetailGeometry(kind: DetailKind, theme: ExplorationTheme): BufferGeometry {
  const builder = new MergedBuilder(), colors = THEME_COLORS[theme];
  if (kind === 'flower-patch') {
    // A few wild blooms among grass blades: white, yellow and lilac, small and low like meadow flowers.
    addBlades(builder, 6, .2, 2, .7);
    [[.12, .04, 1], [-.1, .1, 0], [.02, -.13, 3]].forEach(([x, z, tint], index) => addFlower(builder, at(x, 0, z), FLOWERS[tint], .18 + (index % 2) * .06, .065));
  } else if (kind === 'pebbles') {
    [[0, 0, .22, '#8d8b80'], [.26, .12, .15, '#a19d8e'], [-.18, .2, .12, '#7b7a70']].forEach(([x, z, size, color]) =>
      builder.add(new IcosahedronGeometry(size as number, 0), color as string, at(x as number, (size as number) * .25, z as number, (x as number) * 9, 1, .55, 1)));
  } else if (kind === 'cactus') {
    // A saguaro as Route 111 and the Desert Resort draw it: a ribbed column with two raised arms.
    const green = '#5a9a4e', deep = '#3f7641';
    builder.add(new CylinderGeometry(.17, .2, 1.6, 8), deep, at(0, .8, 0), { top: green, height: 1.6 });
    builder.add(new SphereGeometry(.17, 8, 6), green, at(0, 1.6, 0));
    ([[1, .7, .34, .45], [-1, .95, .3, .38]] as const).forEach(([side, y, reach, rise]) => {
      builder.add(new CylinderGeometry(.1, .1, reach, 6), deep, at(side * reach / 2, y, 0, 0, 1, 1, 1, 0, Math.PI / 2));
      builder.add(new CylinderGeometry(.1, .1, rise, 6), deep, at(side * reach, y + rise / 2, 0), { top: green, height: rise });
      builder.add(new SphereGeometry(.1, 6, 5), green, at(side * reach, y + rise, 0));
    });
  } else if (kind === 'dry-shrub') {
    // Wiry desert scrub: thin dry stems fanning out from one root.
    for (let stem = 0; stem < 9; stem++) {
      const angle = stem / 9 * Math.PI * 2 + Math.sin(stem * 3.1) * .4, lean = .35 + (stem % 3) * .12, height = .42 + (stem % 4) * .08;
      builder.add(new ConeGeometry(.025, height, 3, 1, true), '#8d7648', at(Math.cos(angle) * .08, height / 2, Math.sin(angle) * .08, angle, 1, 1, 1, Math.cos(angle) * lean, -Math.sin(angle) * lean), { top: '#c2a86e', height, soft: .4 });
    }
  } else if (kind === 'snow-fir') {
    // A fir under snow, as on Route 216 and around Snowpoint: dark tiers, each capped white, over a short trunk.
    builder.add(new CylinderGeometry(.11, .15, .5, 6), '#6b4a31', at(0, .25, 0));
    ([[.95, 1.1, .9], [.74, .95, 1.55], [.5, .8, 2.15]] as const).forEach(([radius, height, y]) => {
      builder.add(new ConeGeometry(radius, height, 8), '#2c5641', at(0, y, 0), { top: '#3d6e52', height });
      builder.add(new ConeGeometry(radius * .74, height * .46, 8), '#f4f8fa', at(0, y + height * .31, 0));
    });
  } else if (kind === 'snow-drift') {
    // Wind-shaped drifts: low, overlapping mounds.
    builder.add(new SphereGeometry(.9, 12, 6), '#dfe9ef', at(0, 0, 0, 0, 1, .32, .72), { top: '#f7fafc', height: 1.8 });
    builder.add(new SphereGeometry(.55, 10, 5), '#e6eef3', at(.62, 0, .3, .6, 1, .36, .8), { top: '#f7fafc', height: 1.1 });
  } else if (kind === 'puddle') {
    // A shallow mire pool, as in the Great Marsh: dark water inside a muddy rim, with a lily pad.
    builder.add(new CircleGeometry(1.02, 18), '#5a4a33', at(0, .018, 0, 0, 1, 1, 1, -Math.PI / 2));
    builder.add(new CircleGeometry(.86, 18), '#34524d', at(0, .026, 0, 0, 1, 1, 1, -Math.PI / 2));
    builder.add(new CircleGeometry(.16, 8), '#5f9a45', at(.32, .032, -.18, 0, 1, 1, 1, -Math.PI / 2));
  } else if (kind === 'reed') {
    // Cattails: tall olive stems, a few with brown heads.
    for (let stem = 0; stem < 8; stem++) {
      const angle = stem / 8 * Math.PI * 2 + Math.sin(stem * 2.3) * .6, reach = .08 + (stem % 3) * .07, height = .85 + (stem % 4) * .14;
      const x = Math.cos(angle) * reach, z = Math.sin(angle) * reach, tilt = .08 + (stem % 2) * .06;
      builder.add(new ConeGeometry(.022, height, 3, 1, true), '#6f7f3f', at(x, height / 2, z, angle, 1, 1, 1, Math.cos(angle) * tilt, -Math.sin(angle) * tilt), { top: '#a3b35e', height, soft: .4 });
      if (stem % 3 === 0) builder.add(new CylinderGeometry(.045, .045, .2, 6), '#6b4a2e', at(x * 1.1, height * .86, z * 1.1));
    }
  } else {
    builder.add(new BoxGeometry(.14, 1.15, .14), colors.wood, at(0, .575, 0));
    builder.add(new BoxGeometry(.66, .38, .06), '#efe4c4', at(0, .98, .08));
    builder.add(new BoxGeometry(.7, .09, .08), colors.accent, at(0, 1.2, .08));
    builder.add(new ConeGeometry(.11, .12, 4), shade(colors.wood, .8), at(0, 1.21, 0, Math.PI / 4));
  }
  return builder.build();
}

type Palette = { wood: string; accent: string; stone: string; town: string };
const STONE_LANTERN = new Set<ExplorationTheme>(['heritage', 'frontier']);
const TORCH = new Set<ExplorationTheme>(['volcanic', 'island']);

function addLamp(builder: MergedBuilder, matrix: Matrix4, theme: ExplorationTheme, palette: Palette) {
  const place = (x: number, y: number, z: number, rotationY = 0) => matrix.clone().multiply(at(x, y, z, rotationY));
  const glow = '#ffe7a3';
  if (STONE_LANTERN.has(theme)) {
    const stone = mixed(palette.stone, '#d8d2c2', .25);
    builder.add(new BoxGeometry(.56, .16, .56), shade(stone, .9), place(0, .03, 0));
    builder.add(new CylinderGeometry(.1, .13, .78, 6), stone, place(0, .5, 0));
    builder.add(new BoxGeometry(.5, .1, .5), stone, place(0, .94, 0));
    builder.add(new BoxGeometry(.3, .28, .3), glow, place(0, 1.13, 0));
    builder.add(new ConeGeometry(.46, .3, 4), shade(stone, .82), place(0, 1.42, 0, Math.PI / 4));
    builder.add(new SphereGeometry(.07, 6, 4), shade(stone, .82), place(0, 1.6, 0));
  } else if (TORCH.has(theme)) {
    builder.add(new CylinderGeometry(.07, .09, 1.9, 6), '#b58b52', place(0, .9, 0));
    builder.add(new CylinderGeometry(.16, .07, .22, 6), shade(palette.wood, .7), place(0, 1.9, 0));
    builder.add(new ConeGeometry(.11, .32, 5), '#ffb347', place(0, 2.16, 0));
  } else {
    const metal = shade(palette.wood, .55);
    builder.add(new CylinderGeometry(.16, .2, .24, 8), shade(palette.stone, .85), place(0, .07, 0));
    builder.add(new CylinderGeometry(.055, .065, 2.45, 6), metal, place(0, 1.3, 0));
    builder.add(new BoxGeometry(.06, .06, .48), metal, place(0, 2.45, .2));
    builder.add(new BoxGeometry(.26, .32, .26), glow, place(0, 2.24, .42));
    builder.add(new ConeGeometry(.24, .18, 4), metal, place(0, 2.49, .42, Math.PI / 4));
  }
}

function addBench(builder: MergedBuilder, matrix: Matrix4, palette: Palette) {
  const place = (x: number, y: number, z: number) => matrix.clone().multiply(at(x, y, z));
  const legs = shade(palette.wood, .5);
  for (const x of [-.62, .62]) builder.add(new BoxGeometry(.09, .44, .42), legs, place(x, .17, 0));
  builder.add(new BoxGeometry(1.5, .08, .46), palette.wood, place(0, .42, 0));
  builder.add(new BoxGeometry(1.5, .3, .07), shade(palette.wood, .92), place(0, .72, -.2));
  for (const x of [-.62, .62]) builder.add(new BoxGeometry(.07, .36, .07), legs, place(x, .56, -.2));
}

function addFlowerBed(builder: MergedBuilder, matrix: Matrix4, palette: Palette, radius: number, stretch: number, flowers: number) {
  const place = (x: number, y: number, z: number, sx = 1, sz = sx) => matrix.clone().multiply(at(x, y, z, 0, sx, 1, sz));
  const stone = mixed(palette.stone, '#ece6d6', .45);
  builder.add(new CylinderGeometry(radius, radius + .06, .3, 14, 1, true), stone, place(0, .1, 0, stretch, 1));
  builder.add(new CylinderGeometry(radius + .06, radius + .06, .05, 14), shade(stone, .95), place(0, .24, 0, stretch, 1));
  builder.add(new CylinderGeometry(radius - .08, radius - .08, .06, 14), '#80583a', place(0, .25, 0, stretch, 1));
  // Round leafy bushes cover most of the soil so beds read as planted, not bare.
  for (let mound = 0; mound < 6; mound++) {
    const angle = mound * 1.047 + .3, reach = (radius - .45) * (mound % 2 ? .55 : .9);
    builder.add(new SphereGeometry(.36, 9, 6), LEAF[mound % 2], place(Math.cos(angle) * reach * stretch, .32, Math.sin(angle) * reach, 1.1, .8), { soft: .3 });
  }
  for (let flower = 0; flower < flowers; flower++) {
    const angle = flower * 2.39996, reach = (radius - .3) * Math.sqrt((flower + .5) / flowers);
    const x = Math.cos(angle) * reach * stretch, z = Math.sin(angle) * reach;
    addFlower(builder, matrix.clone().multiply(at(x, .27, z)), flower % 3 === 0 ? palette.accent : FLOWERS[flower % FLOWERS.length], .34 + (flower % 3) * .06, .14);
  }
}

/** A raised garden bed: tilled rows with a line of pumpkins and a line of carrot tops. */
function addCropPlot(builder: MergedBuilder, matrix: Matrix4, palette: Palette) {
  const place = (x: number, y: number, z: number, rotationY = 0, sx = 1, sy = sx, sz = sx) => matrix.clone().multiply(at(x, y, z, rotationY, sx, sy, sz));
  const wood = mixed(palette.wood, '#d2a36b', .55);
  for (const side of [-1, 1]) {
    builder.add(new BoxGeometry(2.64, .24, .12), wood, place(0, .12, side * .88));
    builder.add(new BoxGeometry(.12, .24, 1.64), shade(wood, .94), place(side * 1.26, .12, 0));
  }
  builder.add(new BoxGeometry(2.4, .12, 1.64), '#7e5334', place(0, .12, 0));
  for (const z of [-.42, .42]) builder.add(new BoxGeometry(2.3, .06, .34), '#8f6040', place(0, .2, z));
  // Pumpkins along the back row.
  [-.78, 0, .78].forEach((x, index) => {
    const size = .24 + (index % 2) * .05;
    builder.add(new SphereGeometry(size, 10, 7), index === 1 ? '#f7a64a' : '#f29238', place(x, .2 + size * .62, -.42, index * .7, 1, .72, 1), { soft: .15 });
    builder.add(new CylinderGeometry(.025, .04, .12, 5), '#5b7a33', place(x, .2 + size * 1.3, -.42));
    builder.add(new IcosahedronGeometry(.13, 0), LEAF[0], place(x + .22, .24, -.3, index, 1.2, .35, .9), { soft: .5 });
  });
  // Carrot tops fan out over little orange shoulders in the front row.
  for (const x of [-.9, -.45, 0, .45, .9]) {
    builder.add(new ConeGeometry(.065, .1, 6), '#ff8a3d', place(x, .25, .42));
    for (let leaf = 0; leaf < 3; leaf++) {
      const angle = leaf / 3 * Math.PI * 2 + x;
      builder.add(new ConeGeometry(.045, .3, 4), LEAF[leaf % 2], place(x + Math.cos(angle) * .04, .42, .42 + Math.sin(angle) * .04).multiply(at(0, 0, 0, 0, 1, 1, 1, Math.sin(angle) * .3, -Math.cos(angle) * .3)), { soft: .5 });
    }
  }
}

/** Colours stay in vertex colours so every town costs one draw call for all of its props. */
function addTownProp(builder: MergedBuilder, prop: TownProp, theme: ExplorationTheme, palette: Palette) {
  const matrix = at(prop.x, -.05, prop.z, prop.rotationY);
  const place = (x: number, y: number, z: number, rotationY = 0, sx = 1, sy = sx, sz = sx) => matrix.clone().multiply(at(x, y, z, rotationY, sx, sy, sz));
  const stone = mixed(palette.stone, '#d9d3c3', .3);
  switch (prop.kind) {
    case 'curb': builder.add(new BoxGeometry(PAVING_CELL + .2, .14, .22), mixed(stone, palette.town, .12), place(0, .07, 0)); break;
    case 'lamp': addLamp(builder, matrix, theme, palette); break;
    case 'bench': addBench(builder, matrix, palette); break;
    case 'planter': {
      builder.add(new BoxGeometry(.82, .4, .46), mixed(palette.town, stone, .55), place(0, .2, 0));
      builder.add(new BoxGeometry(.72, .04, .36), '#80583a', place(0, .41, 0));
      builder.add(new SphereGeometry(.24, 8, 6), LEAF[0], place(0, .52, 0, 0, 1.5, .7, .8), { soft: .3 });
      [[-.22, palette.accent], [.02, FLOWERS[0]], [.24, FLOWERS[1]]].forEach(([x, color]) =>
        builder.add(new IcosahedronGeometry(.09, 0), color as string, place(x as number, .66, .04, 0, 1, .7, 1)));
      break;
    }
    case 'mailbox': {
      builder.add(new BoxGeometry(.08, .82, .08), shade(palette.wood, .7), place(0, .41, 0));
      builder.add(new BoxGeometry(.3, .24, .44), '#c9463d', place(0, .92, 0));
      builder.add(new CylinderGeometry(.15, .15, .44, 8, 1, false, Math.PI / 2, Math.PI), '#c9463d', place(0, 1.04, 0, 0, 1, 1, 1).multiply(at(0, 0, 0, 0, 1, 1, 1, Math.PI / 2)));
      builder.add(new BoxGeometry(.03, .18, .1), '#f2d24b', place(.17, 1.04, -.08));
      break;
    }
    case 'pillar': {
      builder.add(new BoxGeometry(.78, .26, .78), shade(stone, .88), place(0, .13, 0));
      builder.add(new BoxGeometry(.56, 1.25, .56), stone, place(0, .88, 0));
      builder.add(new BoxGeometry(.78, .18, .78), shade(stone, .9), place(0, 1.58, 0));
      builder.add(new IcosahedronGeometry(.2, 0), mixed(palette.town, '#ffffff', .25), place(0, 1.82, 0));
      break;
    }
    case 'fountain': {
      builder.add(new CylinderGeometry(1.95, 2.05, .46, 18, 1, true), stone, place(0, .23, 0));
      builder.add(new CylinderGeometry(2.08, 2.08, .08, 18), shade(stone, 1.05), place(0, .46, 0));
      builder.add(new CylinderGeometry(1.84, 1.84, .06, 18), '#6fb3cf', place(0, .36, 0));
      builder.add(new CylinderGeometry(.26, .34, 1.1, 8), stone, place(0, .75, 0));
      builder.add(new CylinderGeometry(.75, .45, .22, 12), shade(stone, .95), place(0, 1.3, 0));
      builder.add(new CylinderGeometry(.62, .62, .04, 12), '#8cc7dc', place(0, 1.4, 0));
      builder.add(new ConeGeometry(.16, .5, 6), '#cfe9f2', place(0, 1.64, 0));
      break;
    }
    case 'statue': {
      builder.add(new BoxGeometry(1.5, .36, 1.5), shade(stone, .9), place(0, .18, 0));
      builder.add(new BoxGeometry(1.1, .8, 1.1), stone, place(0, .76, 0));
      builder.add(new SphereGeometry(.58, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2), '#d8443b', place(0, 1.76, 0));
      builder.add(new SphereGeometry(.58, 14, 7, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), '#f3efe6', place(0, 1.76, 0));
      builder.add(new TorusGeometry(.58, .05, 5, 20), '#2b2b2b', place(0, 1.76, 0).multiply(at(0, 0, 0, 0, 1, 1, 1, Math.PI / 2)));
      builder.add(new CylinderGeometry(.17, .17, .1, 12), '#2b2b2b', place(0, 1.76, .55).multiply(at(0, 0, 0, 0, 1, 1, 1, Math.PI / 2)));
      builder.add(new CylinderGeometry(.11, .11, .12, 12), '#f3efe6', place(0, 1.76, .57).multiply(at(0, 0, 0, 0, 1, 1, 1, Math.PI / 2)));
      break;
    }
    case 'tree-bed': addFlowerBed(builder, matrix, palette, 1.35, 1, 5); break;
    case 'flower-bed': addFlowerBed(builder, matrix, palette, 1.25, 1.35, 11); break;
    case 'crop-plot': addCropPlot(builder, matrix, palette); break;
  }
}

const townGeometries = new WeakMap<TownLayout, BufferGeometry>();
function townGeometry(layout: TownLayout, townColor: string): BufferGeometry {
  let geometry = townGeometries.get(layout);
  if (!geometry) {
    const builder = new MergedBuilder(), palette = { ...THEME_COLORS[layout.theme], town: townColor };
    for (const prop of layout.props) addTownProp(builder, prop, layout.theme, palette);
    geometry = builder.build();
    townGeometries.set(layout, geometry);
  }
  return geometry;
}

/** All lamps, benches, planters, curbs and plaza features of one town in a single draw call. */
export function TownProps({ layout, color }: { layout: TownLayout; color: string }) {
  const geometry = useMemo(() => townGeometry(layout, color), [layout, color]);
  // Release GPU buffers when the town streams out; the CPU copy stays cached for re-entry.
  useEffect(() => () => geometry.dispose(), [geometry]);
  // The shared detail material outlives the mesh, so the mesh frees its own render objects.
  return <mesh ref={releaseOnDetach} name={`town-detail:${layout.id}`} geometry={geometry} material={detailMaterial()} receiveShadow dispose={null} />;
}

let pavingGeometry: BufferGeometry | undefined;
/** Running-bond pavers with grout gaps for one paving cell; instance colours keep each town's identity. */
export function townPavingGeometry(): BufferGeometry {
  if (pavingGeometry) return pavingGeometry;
  const half = PAVING_CELL / 2, rows = 4, depth = PAVING_CELL / rows, grout = .07, y = .008;
  const positions: number[] = [], normals: number[] = [], colors: number[] = [];
  for (let row = 0; row < rows; row++) {
    const z0 = -half + row * depth + grout / 2, z1 = -half + (row + 1) * depth - grout / 2;
    const joints = row % 2 ? [-half, -half / 2, half / 2, half] : [-half, 0, half];
    for (let piece = 0; piece < joints.length - 1; piece++) {
      const x0 = joints[piece] + grout / 2, x1 = joints[piece + 1] - grout / 2;
      const tone = .88 + ((Math.sin((row * 7 + piece * 13) * 12.9898) * 43758.5453) % 1 + 1) % 1 * .14;
      for (const [x, z] of [[x0, z0], [x0, z1], [x1, z0], [x1, z0], [x0, z1], [x1, z1]]) {
        positions.push(x, y, z); normals.push(0, 1, 0); colors.push(tone, tone, tone * .98);
      }
    }
  }
  pavingGeometry = new BufferGeometry();
  pavingGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  pavingGeometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  pavingGeometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  pavingGeometry.computeBoundingSphere();
  return pavingGeometry;
}

const pending = new WeakMap<WorldAtlas, Promise<WorldDetails>>();
/** Details are built after the first world frame so region entry is not delayed by dressing. */
export function useWorldDetails(sampleWorld: (x: number, z: number) => WorldSample, atlas: WorldAtlas, skipTown: (id: string) => boolean): WorldDetails | null {
  const [details, setDetails] = useState<{ atlas: WorldAtlas; value: WorldDetails } | null>(null);
  useEffect(() => {
    let active = true;
    let promise = sampleWorld === atlas.sample ? pending.get(atlas) : undefined;
    if (!promise) {
      promise = new Promise<WorldDetails>(resolve => setTimeout(() => {
        const base = cachedSceneryPlacements(sampleWorld, atlas);
        const trees = [...base['tree-round'], ...base['tree-oak'], ...base['tree-pine'], ...base['tree-fat'], ...base['tree-thin']];
        resolve(createWorldDetails(sampleWorld, atlas, trees, skipTown));
      }, 120));
      if (sampleWorld === atlas.sample) pending.set(atlas, promise);
    }
    void promise.then(value => { if (active) setDetails({ atlas, value }); });
    return () => { active = false; };
  }, [sampleWorld, atlas, skipTown]);
  return details?.atlas === atlas ? details.value : null;
}

const landmarkGeometries = new Map<string, BufferGeometry>();
/** Regional special-location silhouettes merged into one vertex-coloured draw call. */
export function regionalLandmarkGeometry(region: string): BufferGeometry {
  let geometry = landmarkGeometries.get(region);
  if (geometry) return geometry;
  const builder = new MergedBuilder();
  if (['hoenn', 'sinnoh', 'hisui'].includes(region)) {
    const rock = region === 'hoenn' ? '#73584e' : '#7d8b87', cap = region === 'hoenn' ? '#e59045' : '#ebf0e8';
    builder.add(new ConeGeometry(7, 8, 7), rock, at(0, 3.5, 0), { top: shade(rock, 1.18), height: 8 });
    builder.add(new ConeGeometry(3.8, 5.2, 6), shade(rock, .92), at(-5, 2.3, 2.6, .4), { top: rock, height: 5.2 });
    builder.add(new ConeGeometry(3, 4, 6), shade(rock, 1.05), at(4.6, 1.8, -3, 1.1), { top: rock, height: 4 });
    builder.add(new ConeGeometry(2, 2.4, 7), cap, at(0, 6.5, 0));
    builder.add(new ConeGeometry(1.05, 1.3, 6), cap, at(-5, 4.4, 2.6, .4));
    if (region === 'hoenn') builder.add(new ConeGeometry(.9, 1.2, 6), '#ffcf6b', at(0, 7.9, 0));
    for (let index = 0; index < 5; index++) {
      const angle = index * 1.37 + .4;
      builder.add(new IcosahedronGeometry(1 + (index % 3) * .3, 0), shade(rock, .85 + (index % 2) * .1), at(Math.cos(angle) * 7.4, .45, Math.sin(angle) * 7.4, angle, 1, .7, 1));
    }
  } else if (region === 'johto') {
    const wall = '#c49765', roof = '#755b43';
    builder.add(new BoxGeometry(4.8, .5, 4.8), '#9c968a', at(0, .25, 0));
    builder.add(new BoxGeometry(1.6, .3, 1.2), '#8e887c', at(0, .15, 2.9));
    builder.add(new BoxGeometry(3, 5.2, 3), wall, at(0, 3.1, 0));
    for (let tier = 0; tier < 4; tier++) {
      builder.add(new ConeGeometry(4.1 - tier * .6, 1.3, 4), roof, at(0, 1.9 + tier * 1.35, 0, Math.PI / 4), { top: shade(roof, .85), height: 1.3 });
      builder.add(new BoxGeometry(2.9 - tier * .35, .5, 2.9 - tier * .35), shade(wall, 1.05), at(0, 2.45 + tier * 1.35, 0));
    }
    builder.add(new CylinderGeometry(.1, .14, 1.8, 6), '#c9a24b', at(0, 7.9, 0));
    builder.add(new SphereGeometry(.22, 8, 6), '#e0bf5a', at(0, 8.9, 0));
  } else if (region === 'alola') {
    builder.add(new CylinderGeometry(4.2, 4.5, .35, 16), '#d9c79a', at(0, .17, 0));
    for (const offset of [-2, 2]) {
      for (let piece = 0; piece < 3; piece++) {
        builder.add(new CylinderGeometry(.22, .3, 1.75, 6), shade('#a9834a', 1 - piece * .06), at(offset + piece * .18 * Math.sign(offset), .9 + piece * 1.62, 0, 0, 1, 1, 1, 0, -Math.sign(offset) * .1));
      }
      for (let frond = 0; frond < 7; frond++) {
        const angle = frond / 7 * Math.PI * 2 + offset;
        builder.add(new ConeGeometry(.42, 2.6, 4), '#4f8f55', at(offset * 1.27 + Math.cos(angle) * 1.1, 5, Math.sin(angle) * 1.1, -angle + Math.PI / 2, 1, 1, .35, 0, -1.2), { top: '#78b567', height: 2.6 });
      }
      builder.add(new IcosahedronGeometry(.45, 0), '#6b4e2e', at(offset * 1.27, 4.85, 0));
    }
  } else {
    const body = region === 'galar' ? '#a35d5d' : '#bdb69c', crown = region === 'paldea' ? '#8e78bd' : '#d3b66c';
    builder.add(new BoxGeometry(5.2, .5, 5.2), shade(body, .82), at(0, .25, 0));
    builder.add(new BoxGeometry(4, .4, 4), shade(body, .9), at(0, .7, 0));
    builder.add(new CylinderGeometry(1.1, 2.2, 6, region === 'kalos' ? 4 : 8), body, at(0, 3.9, 0, region === 'kalos' ? Math.PI / 4 : 0), { top: shade(body, 1.12), height: 6 });
    builder.add(new TorusGeometry(1.75, .14, 6, 20), crown, at(0, 3.2, 0, 0, 1, 1, 1, Math.PI / 2));
    builder.add(new OctahedronGeometry(1.6), crown, at(0, 7.1, 0));
    for (const [x, z] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]]) {
      builder.add(new BoxGeometry(.4, 1.5, .4), shade(body, .95), at(x, 1.65, z));
      builder.add(new IcosahedronGeometry(.28, 0), crown, at(x, 2.55, z));
    }
  }
  geometry = builder.build();
  landmarkGeometries.set(region, geometry);
  return geometry;
}
