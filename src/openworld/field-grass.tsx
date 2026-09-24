import { useFrame } from '@react-three/fiber';
import { GrassDriver, useGrassManager } from 'gaesup-world/building';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box3, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, Sphere, Vector3 } from 'three';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import {
  abs, attribute, cameraViewMatrix, cos, dot, float, floor, fract, length, max, mix, positionGeometry, select, sin, smoothstep, uniform, uv, varying, vec2, vec3, vec4,
} from 'three/tsl';
import type { WorldAtlas } from './atlas';
import type { WorldSample } from './types';
import {
  GRASS_BUDGETS, GRASS_CELL, GRASS_FOREST_STEPS, buildGrassCell, grassBudgetScale, grassCellCapacity, grassCellsNear, grassField, type GrassBudget, type GrassCell,
} from './grass-field';
import { fieldGrassColors } from './materials';

type GrassManager = ReturnType<typeof useGrassManager>;
type GrassUniforms = { time: { value: number }; wind: { value: number } };
type BudgetState = { requested: Map<number, number>; scale: number };

/** Wind travels along this ground direction; gusts roll across the field at a few metres per second. */
const WIND = { x: .848, z: .53 };
const BLADE_SEGMENTS = 3;

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
 * Blades ported from gaesup-world's NodeGrassMaterial: per-instance offsets, simplex gusts driven by
 * the gaesup grass manager's time and weather wind, and a tip-weighted bend. Offsets are world space
 * on the rendered terrain, and normals face up so blades take the same light and shadow as the lawn.
 */
export function createFieldGrassMaterial(colors: { lawn: Color; forest: Color }): { material: MeshStandardNodeMaterial; uniforms: GrassUniforms } {
  const material = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 1, metalness: 0, envMapIntensity: .35 });
  const time = uniform(0), wind = uniform(.85);
  const offset = attribute<'vec4'>('offset', 'vec4');
  const seed = fract(offset.w), woodland = floor(offset.w).div(GRASS_FOREST_STEPS);
  const tall = fract(seed.mul(7.31)), broad = fract(seed.mul(13.17)), leaning = fract(seed.mul(29.83));
  const patch = simplex(vec2(offset.x, offset.z).mul(.07)).mul(.5).add(.5);
  const height = mix(float(.18), float(.31), tall).mul(mix(float(.85), float(1.2), patch));
  const width = mix(float(.1), float(.15), broad);
  const along = positionGeometry.y, yaw = seed.mul(6.2831853);
  const sideX = cos(yaw), sideZ = sin(yaw), lean = mix(float(.1), float(.46), leaning);
  // gaesup samples noise at (time - x/50, time - z/50); here gusts are smaller and travel with the wind.
  const clock = time.mul(4);
  const gust = simplex(vec2(offset.x.div(17).sub(clock.mul(WIND.x * .24)), offset.z.div(17).sub(clock.mul(WIND.z * .24)))).mul(.5).add(.5);
  const flutter = sin(clock.mul(3.3).add(seed.mul(40)).add(offset.x.mul(.9))).mul(.06);
  const sway = gust.mul(.62).add(.08).add(flutter).mul(wind);
  const bendX = sideZ.negate().mul(lean).add(sway.mul(WIND.x)), bendZ = sideX.mul(lean).add(sway.mul(WIND.z));
  const theta = max(length(vec2(bendX, bendZ)), .001), arc = theta.mul(along);
  // Constant-length circular bend: the tip travels along an arc instead of stretching sideways.
  const reach = height.mul(float(1).sub(cos(arc))).div(theta), rise = height.mul(sin(arc)).div(theta);
  const across = positionGeometry.x.mul(width);
  material.positionNode = vec3(
    offset.x.add(sideX.mul(across)).add(bendX.div(theta).mul(reach)),
    offset.y.add(rise),
    offset.z.add(sideZ.mul(across)).add(bendZ.div(theta).mul(reach)),
  );
  const lawn = uniform(colors.lawn), forest = uniform(colors.forest);
  const tone = varying(simplex(vec2(offset.x, offset.z).mul(.11).add(vec2(3.7, -8.2))).mul(.5).add(.5));
  const root = varying(mix(lawn, forest, woodland));
  const shade = varying(mix(float(.93), float(1.07), fract(seed.mul(53.7))));
  // Sunlit tips are a brighter, slightly warmer version of the ground they grow from, lawn or woodland.
  const tip = root.mul(vec3(1.3, 1.24, 1)).mul(mix(float(.94), float(1.1), tone));
  const blade = mix(root.mul(.8), tip, smoothstep(0, 1, along));
  const ridge = float(1).sub(smoothstep(0, .5, abs(uv().x.sub(.5))));
  material.colorNode = blade.mul(shade).mul(mix(float(.95), float(1.05), tone)).mul(mix(float(.95), float(1.05), ridge));
  // Upward normals regardless of face, so both sides light like the ground they grow from.
  material.normalNode = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  material.userData.openWorldNodeEffect = 'field-grass:wind';
  return { material, uniforms: { time, wind } };
}

let bladeGeometry: BufferGeometry | undefined;
/** A tapered blade, y in [0, 1]: two vertices per joint closing to a single tip vertex. */
function createBladeGeometry(): BufferGeometry {
  if (bladeGeometry) return bladeGeometry;
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let row = 0; row < BLADE_SEGMENTS; row++) {
    const t = row / BLADE_SEGMENTS, half = .5 * (1 - t ** 1.6);
    for (const side of [-1, 1]) { positions.push(side * half, t, 0); normals.push(0, 1, 0); uvs.push(.5 + side * .5, t); }
    if (row) { const a = (row - 1) * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  positions.push(0, 1, 0); normals.push(0, 1, 0); uvs.push(.5, 1);
  const top = (BLADE_SEGMENTS - 1) * 2; indices.push(top, top + 1, top + 2);
  bladeGeometry = new BufferGeometry();
  bladeGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  bladeGeometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  bladeGeometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  bladeGeometry.setIndex(indices);
  return bladeGeometry;
}

/** Each cell owns copies of the tiny blade buffers, so disposing one cell never drops another's GPU data. */
function cellGeometry(cell: GrassCell): InstancedBufferGeometry {
  const blade = createBladeGeometry(), geometry = new InstancedBufferGeometry();
  geometry.setIndex(blade.index!.clone());
  for (const name of ['position', 'normal', 'uv']) geometry.setAttribute(name, blade.getAttribute(name).clone());
  geometry.setAttribute('offset', new InstancedBufferAttribute(cell.offsets, 4));
  geometry.instanceCount = 0;
  const top = cell.maxY + .5;
  geometry.boundingBox = new Box3(new Vector3(cell.x - GRASS_CELL / 2 - .6, cell.minY - .1, cell.z - GRASS_CELL / 2 - .6), new Vector3(cell.x + GRASS_CELL / 2 + .6, top, cell.z + GRASS_CELL / 2 + .6));
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
  return geometry;
}

const GrassCellMesh = memo(function GrassCellMesh({ cell, grass, manager, budget, state }: { cell: GrassCell; grass: ReturnType<typeof createFieldGrassMaterial>; manager: GrassManager; budget: GrassBudget; state: BudgetState }) {
  const mesh = useRef<Mesh>(null);
  const geometry = useMemo(() => cellGeometry(cell), [cell]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useLayoutEffect(() => {
    const capacity = grassCellCapacity(cell, budget), { uniforms } = grass;
    if (mesh.current) mesh.current.visible = false;
    // gaesup's manager owns frustum culling, SFE distance LOD, gust time and weather wind for every tile.
    const tile = manager.register({
      width: GRASS_CELL, height: cell.maxY - cell.minY + 1.2, center: new Vector3(cell.x, (cell.minY + cell.maxY) / 2 + .3, cell.z), maxInstances: capacity,
      lod: { near: budget.near, far: budget.far, strength: budget.strength },
      apply: next => {
        const target = mesh.current; if (!target) return;
        state.requested.set(cell.key, next.instanceCount);
        const count = Math.min(capacity, Math.floor(next.instanceCount * state.scale));
        target.visible = next.visible && count > 0;
        geometry.instanceCount = count;
        uniforms.time.value = next.time; uniforms.wind.value = next.windScale;
      },
    });
    return () => { manager.unregister(tile.id); state.requested.delete(cell.key); };
  }, [budget, cell, geometry, manager, grass, state]);
  return <mesh ref={mesh} name={`field-grass:${cell.ix}:${cell.iz}`} geometry={geometry} material={grass.material} receiveShadow dispose={null} />;
});

/** Terrain-aware wind grass streamed around the player in 16 m cells. */
export function FieldGrass({ atlas, sampleWorld, player, mobile, skipTown }: { atlas: WorldAtlas; sampleWorld: (x: number, z: number) => WorldSample; player: { x: number; z: number }; mobile: boolean; skipTown: (id: string) => boolean }) {
  const manager = useGrassManager();
  const budget = GRASS_BUDGETS[mobile ? 'mobile' : 'desktop'];
  const field = useMemo(() => grassField(sampleWorld, atlas, skipTown), [sampleWorld, atlas, skipTown]);
  const grass = useMemo(() => createFieldGrassMaterial(fieldGrassColors(atlas)), [atlas]);
  useEffect(() => () => grass.material.dispose(), [grass]);
  const anchorX = Math.round(player.x / 8) * 8, anchorZ = Math.round(player.z / 8) * 8;
  const wanted = useMemo(() => grassCellsNear({ x: anchorX, z: anchorZ }, budget.radius), [anchorX, anchorZ, budget.radius]);
  const [cells, setCells] = useState<GrassCell[]>([]);
  const state = useMemo<BudgetState>(() => ({ requested: new Map(), scale: 1 }), []);
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
    let requested = 0;
    for (const count of state.requested.values()) requested += count;
    state.scale = grassBudgetScale(requested, budget);
    if (group.current) group.current.userData.fieldGrass = { cells: ready.length, pending, requested, scale: state.scale };
  });
  return <group ref={group} name="field-grass" userData={{ gaesupWorldObject: 'field-grass' }}>
    <GrassDriver />
    {cells.map(cell => <GrassCellMesh key={cell.key} cell={cell} grass={grass} manager={manager} budget={budget} state={state} />)}
  </group>;
}
