import { useFrame, useThree } from '@react-three/fiber';
import { GrassDriver, useGrassManager } from 'gaesup-world/building';
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box3, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, Sphere, Vector3, type Camera } from 'three';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import {
  abs, attribute, cameraPosition, cameraViewMatrix, clamp, cos, cross, dot, faceDirection, float, floor, fract, length, max, mix, normalize, positionGeometry, pow,
  select, sign, sin, smoothstep, uniform, uv, varying, vec2, vec3, vec4,
} from 'three/tsl';
import type { WorldAtlas } from './atlas';
import type { WorldSample } from './types';
import {
  GRASS_BUDGETS, GRASS_CELL, GRASS_DENSITY, GRASS_FOREST_STEPS, TALL_GRASS_BUDGETS, TALL_GRASS_DENSITY, buildGrassCell, grassBudgetScale, grassCellsNear, grassField,
  grassLodWeight, type GrassBudget, type GrassCell, type GrassLayer,
} from './grass-field';
import { fieldGrassColors } from './materials';

type GrassManager = ReturnType<typeof useGrassManager>;
type BudgetState = { requested: Map<number, number>; scale: number };
export type GrassProfile = 'lawn' | 'tall';

/** Wind travels along this ground direction; gusts roll across the field at a few metres per second. */
const WIND = { x: .848, z: .53 };
/** Blades past their distance share shrink away over this fraction of the draw order instead of popping. */
const FADE_BAND = .18;
const TAU = Math.PI * 2;
type Rgb = readonly [number, number, number];
type Look = { width: readonly [number, number]; calm: number; gust: number; flutter: number; thicken: number; round: number; upward: number; trample: number; base: Rgb; body: Rgb; tip: Rgb; fresh: Rgb };
/**
 * Lawn: short, soft pastel blades that take the terrain tint and brighten to warm tips.
 * Tall: the roadside encounter grass, broad, stiff and a deeper green with a light crown.
 */
const LOOKS: Record<GrassProfile, Look> = {
  lawn: { width: [.085, .14], calm: .1, gust: .5, flutter: .06, thicken: .7, round: .7, upward: .42, trample: .9,
    base: [.72, .74, .7], body: [1, 1.01, .98], tip: [1.2, 1.16, .88], fresh: [1.04, 1.15, 1.06] },
  tall: { width: [.13, .2], calm: .06, gust: .3, flutter: .08, thicken: .55, round: .8, upward: .28, trample: 1.25,
    base: [.22, .38, .28], body: [.46, .72, .48], tip: [.9, 1.08, .66], fresh: [.72, 1.02, .78] },
};

/** 2D simplex noise (Ashima/Gustavson), the same field gaesup's NodeGrassMaterial samples for wind. */
function simplex(v: Node<'vec2'>): Node<'float'> {
  const i0 = floor(v.add(v.x.add(v.y).mul(.366025403784439)));
  const x0 = v.sub(i0).add(i0.x.add(i0.y).mul(.211324865405187));
  const i1 = select(x0.x.greaterThan(x0.y), vec2(1, 0), vec2(0, 1));
  const x1 = x0.add(.211324865405187).sub(i1), x2 = x0.sub(.577350269189626);
  const i = i0.sub(floor(i0.mul(1 / 289)).mul(289));
  const permute = (x: Node<'vec3'>) => { const t = x.mul(34).add(1).mul(x); return t.sub(floor(t.mul(1 / 289)).mul(289)); };
  const p = permute(permute(vec3(0, i1.y, 1).add(i.y)).add(vec3(0, i1.x, 1)).add(i.x));
  const falloff = max(vec3(.5).sub(vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2))), 0);
  const x = fract(p.mul(.024390243902439)).mul(2).sub(1), h = abs(x).sub(.5), a0 = x.sub(floor(x.add(.5)));
  const m = falloff.mul(falloff).mul(falloff).mul(falloff).mul(float(1.79284291400159).sub(a0.mul(a0).add(h.mul(h)).mul(.85373472095314)));
  return dot(m, vec3(a0.x.mul(x0.x).add(h.x.mul(x0.y)), a0.y.mul(x1.x).add(h.y.mul(x1.y)), a0.z.mul(x2.x).add(h.z.mul(x2.y)))).mul(130);
}

/**
 * Stylized blades in the spirit of gaesup-world's NodeGrassMaterial and Ghost of Tsushima-style grass:
 * clumped profiles from the CPU, a constant-length arc bend driven by rolling simplex gust fronts plus
 * per-blade flutter, player trample, edge-on blades thickened in screen space, rounded normals biased
 * toward the sky, and a root-to-tip gradient with base occlusion. Each blade also fades along its draw
 * rank with camera distance, matching the CPU draw count, so density thins smoothly instead of per tile.
 */
export function createFieldGrassMaterial(colors: { lawn: Color; forest: Color }, profile: GrassProfile = 'lawn') {
  const look = LOOKS[profile];
  const material = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: .9, metalness: 0, envMapIntensity: .35 });
  const uniforms = {
    time: uniform(0), wind: uniform(.85), keep: uniform(1), near: uniform(22), far: uniform(60), strength: uniform(1.35),
    /** Player position on the ground (x, z) and trample strength. */
    trample: uniform(new Vector3(0, -9999, 0)),
  };
  const { time, wind, keep, near, far, strength, trample } = uniforms;
  const offset = attribute<'vec4'>('offset', 'vec4'), shape = attribute<'vec4'>('shape', 'vec4');
  const root = offset.xyz, rank = fract(offset.w), woodland = floor(offset.w).div(GRASS_FOREST_STEPS);
  const toneStep = floor(shape.w.div(8)), yaw = shape.w.sub(toneStep.mul(8)), tone = toneStep.div(15);
  const seed = fract(yaw.mul(1.7).add(root.x.mul(.61)).add(root.z.mul(.37)));
  const along = positionGeometry.y;

  const toCamera = cameraPosition.sub(root);
  const lod = pow(clamp(float(1).sub(length(toCamera).sub(near).div(far.sub(near))), 0, 1), strength);
  const kept = keep.mul(lod), grow = float(1).sub(smoothstep(kept, kept.mul(1 + FADE_BAND).add(.002), rank));

  const away = root.xz.sub(trample.xy), awayLength = max(length(away), .001);
  const press = clamp(float(1).sub(awayLength.div(look.trample)), 0, 1), pressed = press.mul(press).mul(trample.z);

  const clock = time.mul(4), downwind = root.x.mul(WIND.x).add(root.z.mul(WIND.z)), crosswind = root.z.mul(WIND.x).sub(root.x.mul(WIND.z));
  // Broad gust fronts roll downwind; a quicker ripple and per-blade flutter keep the field alive between them.
  const front = simplex(vec2(downwind.sub(clock.mul(3.2)).div(10), crosswind.div(17))).mul(.5).add(.5);
  const ripple = sin(downwind.mul(.8).sub(clock.mul(4.1)).add(sin(crosswind.mul(.35)).mul(1.7))).mul(.5).add(.5);
  const gust = smoothstep(.2, .95, front.mul(.8).add(ripple.mul(.2)));
  const flutter = sin(clock.mul(mix(float(2.2), float(3.4), seed)).add(seed.mul(TAU)).add(downwind.mul(.9))).mul(look.flutter).mul(gust.add(.35));
  const sway = wind.mul(gust.mul(look.gust).add(look.calm).add(flutter));
  const bend = shape.xy.add(vec2(WIND.x, WIND.z).mul(sway)).add(away.div(awayLength).mul(pressed.mul(1.15)));
  const bendLength = max(length(bend), .001), theta = clamp(bendLength, .001, 1.4), heading = bend.div(bendLength), arc = theta.mul(along);
  const height = shape.z.mul(grow).mul(float(1).sub(pressed.mul(.3)));
  // Constant-length circular bend: the tip travels along an arc instead of stretching sideways.
  const reach = height.mul(float(1).sub(cos(arc))).div(theta), rise = height.mul(sin(arc)).div(theta);
  const side = vec3(sin(yaw).negate(), 0, cos(yaw));
  const spine = vec3(root.x.add(heading.x.mul(reach)), root.y.add(rise), root.z.add(heading.y.mul(reach)));
  const tangent = vec3(heading.x.mul(sin(arc)), cos(arc), heading.y.mul(sin(arc)));
  const facing = cross(side, tangent);
  // Edge-on blades widen across the screen, so the field keeps its body from any camera angle.
  const view = normalize(cameraPosition.sub(spine)), screen = cross(tangent, view), screenSide = screen.div(max(length(screen), 1e-4));
  const width = mix(float(look.width[0]), float(look.width[1]), fract(seed.mul(13.7))).mul(float(1).add(float(1).sub(lod).mul(.8)));
  const across = positionGeometry.x.mul(width);
  const widen = screenSide.mul(sign(dot(screenSide, side))).mul(across).mul(float(1).sub(abs(dot(facing, view))).mul(look.thicken));
  material.positionNode = spine.add(side.mul(across)).add(widen);

  // Rounded cross-section: the visible face's normal tilts outward toward each edge, then leans to the sky.
  const faceNormal = varying(facing), edgeNormal = varying(side.mul(uv().x.mul(2).sub(1).mul(look.round)));
  // Tips lean their shading further toward the sky, so tufts read with soft, sunlit tops.
  const lit = mix(normalize(faceNormal.mul(faceDirection).add(edgeNormal)), vec3(0, 1, 0), mix(float(look.upward), float(.72), smoothstep(.45, 1, along)));
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(normalize(lit), 0)).xyz);

  const lawn = uniform(colors.lawn), forest = uniform(colors.forest);
  // Same broad tint wave the terrain bakes into its vertices, so roots vanish into the ground they grow from.
  const terrain = sin(root.x.mul(.19).add(sin(root.z.mul(.11)))).mul(cos(root.z.mul(.17))).mul(.065).add(1);
  const ground = varying(mix(lawn, forest, woodland).mul(terrain)), shade = varying(tone), breeze = varying(gust);
  const lower = mix(ground.mul(vec3(...look.base)), ground.mul(vec3(...look.body)), smoothstep(0, .42, along));
  const blade = mix(lower, ground.mul(mix(vec3(...look.tip), vec3(...look.fresh), shade)), smoothstep(.38, 1, along));
  const rib = float(1).sub(smoothstep(0, .5, abs(uv().x.sub(.5))));
  material.colorNode = blade.mul(mix(float(.92), float(1.08), shade)).mul(mix(float(.95), float(1.04), rib)).mul(breeze.mul(along).mul(.1).add(1));
  material.userData.openWorldNodeEffect = `field-grass:${profile}`;
  return { material, uniforms };
}

const bladeGeometries = new Map<string, BufferGeometry>();
/** A tapered blade, y in [0, 1]: two vertices per joint closing to a single tip vertex. Tall blades swell like a leaf. */
function createBladeGeometry(segments: number, profile: GrassProfile): BufferGeometry {
  const key = `${profile}:${segments}`, cached = bladeGeometries.get(key);
  if (cached) return cached;
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let row = 0; row < segments; row++) {
    const t = row / segments, half = profile === 'tall' ? .5 * (1 - t) ** .6 * (1 + .3 * Math.sin(Math.PI * t)) : .5 * (1 - t) ** .72;
    for (const side of [-1, 1]) { positions.push(side * half, t, 0); normals.push(0, 0, 1); uvs.push(.5 + side * .5, t); }
    if (row) { const a = (row - 1) * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  positions.push(0, 1, 0); normals.push(0, 0, 1); uvs.push(.5, 1);
  const top = (segments - 1) * 2; indices.push(top, top + 1, top + 2);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  bladeGeometries.set(key, geometry);
  return geometry;
}

/** Each layer owns copies of the tiny blade buffers, so disposing one cell never drops another's GPU data. */
function layerGeometry(cell: GrassCell, layer: GrassLayer, profile: GrassProfile, top: number, segments: number): InstancedBufferGeometry {
  const blade = createBladeGeometry(segments, profile), geometry = new InstancedBufferGeometry();
  geometry.setIndex(blade.index!.clone());
  for (const name of ['position', 'normal', 'uv']) geometry.setAttribute(name, blade.getAttribute(name).clone());
  geometry.setAttribute('offset', new InstancedBufferAttribute(layer.offsets, 4));
  geometry.setAttribute('shape', new InstancedBufferAttribute(layer.shapes, 4));
  geometry.instanceCount = 0;
  geometry.boundingBox = new Box3(new Vector3(cell.x - GRASS_CELL / 2 - 1, layer.minY - .1, cell.z - GRASS_CELL / 2 - 1), new Vector3(cell.x + GRASS_CELL / 2 + 1, top, cell.z + GRASS_CELL / 2 + 1));
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
  return geometry;
}

type LayerProps = { cell: GrassCell; layer: GrassLayer; profile: GrassProfile; grass: ReturnType<typeof createFieldGrassMaterial>; manager: GrassManager; budget: GrassBudget; density: number; state: BudgetState; camera: Camera; segments: number };
const GrassLayerMesh = memo(function GrassLayerMesh({ cell, layer, profile, grass, manager, budget, density, state, camera, segments }: LayerProps) {
  const mesh = useRef<Mesh>(null);
  const top = layer.maxY + (profile === 'tall' ? 1.3 : .7);
  const geometry = useMemo(() => layerGeometry(cell, layer, profile, top, segments), [cell, layer, profile, top, segments]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useLayoutEffect(() => {
    const { uniforms } = grass, ratio = budget.density / density, half = GRASS_CELL / 2;
    if (mesh.current) mesh.current.visible = false;
    // gaesup's manager owns frustum culling, gust time and weather wind for every tile. The draw count
    // uses the tile's nearest point, so the per-blade distance fade in the shader always has its blades.
    const tile = manager.register({
      width: GRASS_CELL, height: top - layer.minY + .2, center: new Vector3(cell.x, (layer.minY + top) / 2, cell.z), maxInstances: layer.count,
      lod: { near: budget.far, far: budget.far + GRASS_CELL, strength: 1 },
      apply: next => {
        const target = mesh.current; if (!target) return;
        const eye = camera.position, dx = Math.max(0, Math.abs(eye.x - cell.x) - half), dz = Math.max(0, Math.abs(eye.z - cell.z) - half);
        const dy = eye.y > top ? eye.y - top : eye.y < layer.minY ? layer.minY - eye.y : 0;
        const share = next.visible ? Math.min(1, ratio * grassLodWeight(Math.hypot(dx, dy, dz), budget)) : 0;
        state.requested.set(cell.key, Math.ceil(layer.count * share));
        const count = Math.min(layer.count, Math.ceil(layer.count * share * state.scale * (1 + FADE_BAND)));
        target.visible = count > 0;
        geometry.instanceCount = count;
        uniforms.time.value = next.time; uniforms.wind.value = next.windScale;
      },
    });
    return () => { manager.unregister(tile.id); state.requested.delete(cell.key); };
  }, [budget, camera, cell, density, geometry, grass, layer, manager, state, top]);
  return <mesh ref={mesh} name={`${profile === 'tall' ? 'tall-grass' : 'field-grass'}:${cell.ix}:${cell.iz}`} geometry={geometry} material={grass.material} receiveShadow dispose={null} />;
});

const total = (state: BudgetState) => { let sum = 0; for (const count of state.requested.values()) sum += count; return sum; };

/** Terrain-aware wind grass streamed around the player in 16 m cells, with tall grass on the route shoulders. */
export function FieldGrass({ atlas, sampleWorld, player, mobile, skipTown }: { atlas: WorldAtlas; sampleWorld: (x: number, z: number) => WorldSample; player: { x: number; z: number }; mobile: boolean; skipTown: (id: string) => boolean }) {
  const manager = useGrassManager();
  const camera = useThree(state => state.camera), controls = useThree(state => state.controls) as unknown as { target?: Vector3 } | null;
  const mode = mobile ? 'mobile' : 'desktop', budget = GRASS_BUDGETS[mode], tallBudget = TALL_GRASS_BUDGETS[mode], segments = mobile ? 3 : 5;
  const field = useMemo(() => grassField(sampleWorld, atlas, skipTown), [sampleWorld, atlas, skipTown]);
  const lawn = useMemo(() => createFieldGrassMaterial(fieldGrassColors(atlas), 'lawn'), [atlas]);
  const tall = useMemo(() => createFieldGrassMaterial(fieldGrassColors(atlas), 'tall'), [atlas]);
  useEffect(() => () => lawn.material.dispose(), [lawn]);
  useEffect(() => () => tall.material.dispose(), [tall]);
  useLayoutEffect(() => {
    for (const [grass, target] of [[lawn, budget], [tall, tallBudget]] as const) {
      grass.uniforms.near.value = target.near; grass.uniforms.far.value = target.far; grass.uniforms.strength.value = Math.max(1, target.strength);
    }
  }, [budget, lawn, tall, tallBudget]);
  const anchorX = Math.round(player.x / 8) * 8, anchorZ = Math.round(player.z / 8) * 8;
  const wanted = useMemo(() => grassCellsNear({ x: anchorX, z: anchorZ }, budget.radius), [anchorX, anchorZ, budget.radius]);
  const [cells, setCells] = useState<GrassCell[]>([]);
  const lawnState = useMemo<BudgetState>(() => ({ requested: new Map(), scale: 1 }), []);
  const tallState = useMemo<BudgetState>(() => ({ requested: new Map(), scale: 1 }), []);
  const group = useRef<Group>(null), touched = useRef<typeof wanted | null>(null);
  useFrame(() => {
    // Keep wanted cells fresh in the field's LRU so walking never evicts the ground underfoot.
    if (touched.current !== wanted) { touched.current = wanted; for (const slot of wanted) if (field.cells.has(slot.key)) buildGrassCell(field, slot.ix, slot.iz); }
    // Build missing cells nearest-first within a small per-frame budget, then publish the ready set.
    const started = performance.now();
    let pending = false;
    for (const slot of wanted) {
      if (field.cells.has(slot.key)) continue;
      if (performance.now() - started > 3.5) { pending = true; break; }
      buildGrassCell(field, slot.ix, slot.iz);
    }
    const ready: GrassCell[] = [];
    for (const slot of wanted) { const cell = field.cells.get(slot.key); if (cell) ready.push(cell); }
    if (ready.length !== cells.length || ready.some((cell, index) => cell !== cells[index])) setCells(ready);
    const requested = total(lawnState), tallRequested = total(tallState);
    lawnState.scale = grassBudgetScale(requested, budget); tallState.scale = grassBudgetScale(tallRequested, tallBudget);
    lawn.uniforms.keep.value = lawnState.scale * budget.density / GRASS_DENSITY;
    tall.uniforms.keep.value = tallState.scale * tallBudget.density / TALL_GRASS_DENSITY;
    // The orbit target follows the rendered player, so blades part around where the player actually stands.
    const focus = controls?.target ?? player;
    lawn.uniforms.trample.value.set(focus.x, focus.z, 1); tall.uniforms.trample.value.set(focus.x, focus.z, 1);
    if (group.current) group.current.userData.fieldGrass = { cells: ready.length, pending, requested, scale: lawnState.scale, tall: { requested: tallRequested, scale: tallState.scale } };
  });
  return <group ref={group} name="field-grass" userData={{ gaesupWorldObject: 'field-grass' }}>
    <GrassDriver />
    {cells.map(cell => <Fragment key={cell.key}>
      {cell.count > 0 && <GrassLayerMesh cell={cell} layer={cell} profile="lawn" grass={lawn} manager={manager} budget={budget} density={GRASS_DENSITY} state={lawnState} camera={camera} segments={segments} />}
      {cell.tall && <GrassLayerMesh cell={cell} layer={cell.tall} profile="tall" grass={tall} manager={manager} budget={tallBudget} density={TALL_GRASS_DENSITY} state={tallState} camera={camera} segments={segments} />}
    </Fragment>)}
  </group>;
}
