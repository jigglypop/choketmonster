import { useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, DoubleSide, Euler, Float32BufferAttribute, IcosahedronGeometry, InstancedMesh, Matrix4, MeshStandardMaterial,
  PlaneGeometry, Quaternion, Vector3, type Material,
} from 'three';
import { CAVE_SCENES, type CavePortal, type CaveScene, type CaveStairs } from './caves';
import type { DungeonPropKind, DungeonProp } from './dungeon-rooms';
import type { DungeonStyle } from './dungeons';
import type { WorldPoint, WorldSample } from './types';
import { terrainSurfaceHeight } from './grounding';
import { interiorSurface, type InteriorPattern, type SurfaceSet } from './interior-textures';
import { LairChamber } from './lair-chamber';
import { RoomDressing } from './temple-dressing';
import { DETAILED_PROPS, ROOM_WALL_HEIGHT } from './temple-geometry';

/**
 * Sky colour, hemisphere fill and the lamp carried with the partner for each dungeon look. The fill and lamp
 * stay low (the lamp decays with the square of distance) so the angled key light's shadows read indoors.
 */
export const DUNGEON_LOOKS: Record<DungeonStyle, { sky: string; light: string; ground: string; intensity: number; lamp: string; lampIntensity: number }> = {
  rock: { sky: '#182326', light: '#b9cbd1', ground: '#434f3f', intensity: .44, lamp: '#ffdda6', lampIntensity: 15 },
  ghost: { sky: '#17111f', light: '#b4a2d6', ground: '#2c2238', intensity: .4, lamp: '#c7a6ff', lampIntensity: 13 },
  pagoda: { sky: '#281d14', light: '#f1d7b0', ground: '#4a3b2b', intensity: .52, lamp: '#ffd08a', lampIntensity: 12 },
  bell: { sky: '#2a1a10', light: '#ffe0a8', ground: '#5a4128', intensity: .55, lamp: '#ffc870', lampIntensity: 12 },
  charred: { sky: '#180f0c', light: '#dcae8e', ground: '#2e2019', intensity: .4, lamp: '#ff9a5a', lampIntensity: 14 },
  lighthouse: { sky: '#26313a', light: '#eef3f5', ground: '#6d7479', intensity: .62, lamp: '#fff3d6', lampIntensity: 10 },
  mansion: { sky: '#1d1a18', light: '#d8ccb6', ground: '#3f3830', intensity: .45, lamp: '#ffd9a0', lampIntensity: 13 },
  industrial: { sky: '#141a1e', light: '#c6e0ea', ground: '#39444a', intensity: .5, lamp: '#bfe8ff', lampIntensity: 13 },
  ruins: { sky: '#201c16', light: '#e2d3b4', ground: '#4a4234', intensity: .48, lamp: '#ffe0a0', lampIntensity: 12 },
  stone: { sky: '#1c1f23', light: '#d4d8dc', ground: '#45484c', intensity: .5, lamp: '#e8eeff', lampIntensity: 12 },
  sand: { sky: '#2a2014', light: '#f3dcae', ground: '#5c4a2e', intensity: .52, lamp: '#ffd48a', lampIntensity: 12 },
  warehouse: { sky: '#182025', light: '#d0e4ee', ground: '#3e4a50', intensity: .52, lamp: '#dff4ff', lampIntensity: 12 },
};

type Pattern = 'planks' | 'tiles' | 'stone' | 'metal' | 'checker';
type RoomLook = { floor: string; floorPattern: Pattern; wall: string; wallPattern: Pattern; trim: string; props: Partial<Record<DungeonPropKind, string>> };
const ROOM_LOOKS: Record<DungeonStyle, RoomLook> = {
  rock: { floor: '#8a857a', floorPattern: 'stone', wall: '#6d6a62', wallPattern: 'stone', trim: '#4d4a44', props: {} },
  ghost: { floor: '#6a6178', floorPattern: 'tiles', wall: '#5a4e6e', wallPattern: 'stone', trim: '#352b44', props: { grave: '#9d97a6', rug: '#5b2f6b', candle: '#f6e6b8' } },
  pagoda: { floor: '#9a7650', floorPattern: 'planks', wall: '#7b5a3a', wallPattern: 'planks', trim: '#4b3726', props: { pillar: '#6a4a2e', post: '#5c3f27', screen: '#e8dcc0', lantern: '#ffb45e' } },
  bell: { floor: '#8e5a3c', floorPattern: 'planks', wall: '#8f3f2d', wallPattern: 'planks', trim: '#c9a24b', props: { pillar: '#b8923e', post: '#7a3526', screen: '#f0e2c2', lantern: '#ffc76a' } },
  charred: { floor: '#433430', floorPattern: 'planks', wall: '#2e2420', wallPattern: 'planks', trim: '#1b1512', props: { post: '#241b17', beam: '#1f1814', rubble: '#4f4640', hole: '#050303' } },
  lighthouse: { floor: '#d8d5cd', floorPattern: 'tiles', wall: '#e9e6de', wallPattern: 'stone', trim: '#9b4a3c', props: { column: '#f1eee6', crate: '#9c7a52', lantern: '#fff0b8' } },
  mansion: { floor: '#a59780', floorPattern: 'checker', wall: '#8e8068', wallPattern: 'stone', trim: '#4e4438', props: { partition: '#7d705c', statue: '#c9c3b4', shelf: '#4f3a28', table: '#6a4c31', rug: '#7a2f2c', hole: '#0b0908' } },
  industrial: { floor: '#7c8588', floorPattern: 'metal', wall: '#687176', wallPattern: 'metal', trim: '#d8b43a', props: { machine: '#8a969b', generator: '#c9a93a', pipe: '#4d5559' } },
  ruins: { floor: '#9c8f76', floorPattern: 'stone', wall: '#877a61', wallPattern: 'stone', trim: '#5f5443', props: { tablet: '#b3a47f', block: '#8f8268' } },
  stone: { floor: '#8e8c87', floorPattern: 'stone', wall: '#77756f', wallPattern: 'stone', trim: '#55534e', props: { column: '#a3a09a', rubble: '#6f6c66' } },
  sand: { floor: '#c3a36a', floorPattern: 'stone', wall: '#a88a58', wallPattern: 'stone', trim: '#7c6440', props: { sand: '#d9bd84', column: '#b99a66' } },
  warehouse: { floor: '#99a0a2', floorPattern: 'metal', wall: '#7b8a94', wallPattern: 'metal', trim: '#3f4a52', props: { crate: '#a8845a', machine: '#6f8aa0' } },
};
const PROP_DEFAULTS: Record<DungeonPropKind, string> = {
  pillar: '#6a4a2e', post: '#5c3f27', grave: '#9a96a0', candle: '#f6e6b8', machine: '#8a969b', generator: '#c9a93a', pipe: '#4d5559', statue: '#c9c3b4',
  partition: '#7d705c', screen: '#e8dcc0', shelf: '#4f3a28', table: '#6a4c31', beam: '#1f1814', hole: '#050303', rubble: '#6f6c66', crate: '#9c7a52',
  lantern: '#ffc76a', tablet: '#b3a47f', block: '#8f8268', column: '#a3a09a', rug: '#6b3a3a', sand: '#d9bd84',
};
const GLOWING = new Set<DungeonPropKind>(['candle', 'lantern']);
/** Floors lay flagstones where the old look said stone; walls lay coursed ashlar. */
const FLOOR_SURFACE: Record<Pattern, InteriorPattern> = { planks: 'planks', tiles: 'tiles', stone: 'flagstone', metal: 'metal', checker: 'checker' };
const WALL_SURFACE: Record<Pattern, InteriorPattern> = { planks: 'planks', tiles: 'tiles', stone: 'ashlar', metal: 'metal', checker: 'ashlar' };
const surfaceMaps = (set: SurfaceSet) => ({ map: set.map, normalMap: set.normalMap, roughnessMap: set.ormMap, aoMap: set.ormMap });

function PropBatch({ kind, props, color }: { kind: DungeonPropKind; props: readonly DungeonProp[]; color: string }) {
  const ref = useRef<InstancedMesh>(null);
  const geometry = useMemo<BufferGeometry>(() => kind === 'rubble' || kind === 'sand' ? new IcosahedronGeometry(.5, 1)
    : props[0]?.round ? new CylinderGeometry(kind === 'statue' ? .38 : .5, .5, 1, kind === 'hole' ? 20 : 12) : new BoxGeometry(1, 1, 1), [kind, props]);
  const material = useMemo(() => new MeshStandardMaterial({ name: `dungeon-prop:${kind}`, color, roughness: kind === 'machine' || kind === 'pipe' ? .5 : .85,
    metalness: kind === 'machine' || kind === 'generator' || kind === 'pipe' ? .35 : 0, emissive: GLOWING.has(kind) ? color : '#000000', emissiveIntensity: GLOWING.has(kind) ? .9 : 0 }), [kind, color]);
  useLayoutEffect(() => {
    const mesh = ref.current!, matrix = new Matrix4(), rotation = new Quaternion(), scale = new Vector3(), position = new Vector3();
    props.forEach((prop, index) => {
      const height = Math.max(prop.height, .02), lift = kind === 'rubble' || kind === 'sand' ? height * .35 : height / 2;
      rotation.setFromEuler(new Euler(0, kind === 'rubble' || kind === 'sand' ? prop.x * 1.7 : 0, 0));
      matrix.compose(position.set(prop.x, lift + (kind === 'hole' || kind === 'rug' ? .015 : 0), prop.z), rotation, scale.set(prop.width, height, prop.depth));
      mesh.setMatrixAt(index, matrix);
    });
    mesh.count = props.length; mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
  }, [props, kind]);
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  return <instancedMesh ref={ref} name={`dungeon-props:${kind}`} args={[geometry, material, Math.max(1, props.length)]} castShadow={!GLOWING.has(kind) && kind !== 'rug' && kind !== 'hole'} receiveShadow dispose={null} />;
}

/** Stairs up rise against the wall between stone cheeks; stairs down open into a dark well with a kerb. Caves use ladders. */
export function DungeonStairs({ scene }: { scene: CaveScene }) {
  const look = ROOM_LOOKS[scene.style], cave = scene.kind === 'cave';
  const materials = useMemo(() => ({
    step: new MeshStandardMaterial({ name: 'dungeon-stairs', color: cave ? '#7c6a52' : look.trim, roughness: .8 }),
    tread: new MeshStandardMaterial({ name: 'dungeon-stairs-tread', color: cave ? '#9b8666' : look.floor, roughness: .85 }),
    dark: new MeshStandardMaterial({ name: 'dungeon-stairs-well', color: '#050607', roughness: 1 }),
  }), [cave, look]);
  useEffect(() => () => Object.values(materials).forEach(material => material.dispose()), [materials]);
  return <group name="dungeon-stairs">{scene.stairs.map((stairs: CaveStairs) => {
    const length = Math.hypot(stairs.interior.x, stairs.interior.z) || 1, outX = stairs.interior.x / length, outZ = stairs.interior.z / length;
    const y = scene.sample(stairs.interior.x, stairs.interior.z).height, rotationY = Math.atan2(outX, outZ);
    return <group key={stairs.id} name={`stairs:${stairs.direction}:${stairs.targetSceneId}`} position={[stairs.interior.x, y, stairs.interior.z]} rotation={[0, rotationY, 0]}>
      {stairs.direction === 'up'
        ? cave
          ? <>{[-.55, .55].map(side => <mesh key={side} position={[side, 1.5, .55]} rotation={[-.28, 0, 0]} material={materials.step} castShadow receiveShadow><boxGeometry args={[.14, 3.2, .14]} /></mesh>)}
            {[.4, 1, 1.6, 2.2, 2.8].map(height => <mesh key={height} position={[0, height, .55 + (height - 1.5) * .29]} material={materials.tread} castShadow receiveShadow><boxGeometry args={[1.1, .09, .09]} /></mesh>)}</>
          : <>{[0, 1, 2, 3, 4].map(step => <mesh key={step} position={[0, (step + 1) * .22 / 2, .2 + step * .45]} material={step % 2 ? materials.tread : materials.step} castShadow receiveShadow>
            <boxGeometry args={[2.3, (step + 1) * .22, .45]} /></mesh>)}
            {[-1.3, 1.3].map(side => <mesh key={side} position={[side, .62, 1.1]} material={materials.step} castShadow receiveShadow><boxGeometry args={[.3, 1.24, 2.3]} /></mesh>)}</>
        : <>
          <mesh position={[0, .03, .35]} rotation={[-Math.PI / 2, 0, 0]} material={materials.dark} receiveShadow><planeGeometry args={[cave ? 1.6 : 2.2, cave ? 1.6 : 2.1]} /></mesh>
          {(cave ? [-.62, .62] : [-1.18, 1.18]).map(side => <mesh key={side} position={[side, .12, .35]} material={materials.step} castShadow receiveShadow><boxGeometry args={[.16, .24, cave ? 1.7 : 2.2]} /></mesh>)}
          <mesh position={[0, .12, cave ? 1.25 : 1.5]} material={materials.step} castShadow receiveShadow><boxGeometry args={[cave ? 1.4 : 2.5, .24, .16]} /></mesh>
          {cave && [-.3, .3].map(side => <mesh key={side} position={[side, .45, .6]} material={materials.tread} castShadow receiveShadow><boxGeometry args={[.1, .9, .1]} /></mesh>)}
        </>}
    </group>;
  })}</group>;
}

/** Floor with its texture laid at `tile` metres and a baked darkening where it meets the walls. */
function roomFloorGeometry(halfWidth: number, halfDepth: number, tile: number): BufferGeometry {
  const geometry = new PlaneGeometry(halfWidth * 2, halfDepth * 2, Math.ceil(halfWidth * 2), Math.ceil(halfDepth * 2)).rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv'), colors: number[] = [];
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index), z = position.getZ(index);
    uv.setXY(index, x / tile, -z / tile);
    const edge = Math.min(halfWidth - Math.abs(x), halfDepth - Math.abs(z)), corner = Math.max(0, 2.2 - Math.hypot(halfWidth - Math.abs(x), halfDepth - Math.abs(z))) / 2.2;
    const shade = 1 - .34 * Math.exp(-edge / 1.1) - .1 * corner;
    colors.push(shade, shade, shade);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geometry;
}

/** One inward-facing wall, textured at `tile` metres, darker along its foot and toward the corners. */
function roomWallGeometry(length: number, tile: number): BufferGeometry {
  const geometry = new PlaneGeometry(length, ROOM_WALL_HEIGHT, Math.max(1, Math.ceil(length / 2)), 4);
  const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv'), colors: number[] = [];
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index), y = position.getY(index) + ROOM_WALL_HEIGHT / 2;
    uv.setXY(index, x / tile, y / tile);
    const shade = (.66 + .34 * Math.min(1, y / 1.4)) * (1 - .12 * Math.max(0, 1 - (length / 2 - Math.abs(x)) / 1.6));
    colors.push(shade, shade, shade);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geometry;
}

/** Rectangular floor of a tower, building, plant or ruin: textured floor and walls, architecture, furniture, and at a lair the shrine. */
export function DungeonInterior({ scene, onNavigate }: { scene: CaveScene; onNavigate(point: WorldPoint): void }) {
  const look = ROOM_LOOKS[scene.style], room = scene.room!;
  // Same phone threshold as the view: phones keep fewer point lights.
  const mobile = useThree(state => state.size.width <= 720);
  const floorSet = interiorSurface(FLOOR_SURFACE[look.floorPattern]), wallSet = interiorSurface(WALL_SURFACE[look.wallPattern]);
  const materials = useMemo(() => {
    const metalFloor = look.floorPattern === 'metal', metalWall = look.wallPattern === 'metal';
    return {
      floor: new MeshStandardMaterial({ name: 'dungeon-floor', color: look.floor, vertexColors: true, ...surfaceMaps(floorSet), roughness: 1, metalness: metalFloor ? .3 : 0 }),
      wall: new MeshStandardMaterial({ name: 'dungeon-wall', color: look.wall, vertexColors: true, ...surfaceMaps(wallSet), roughness: 1, metalness: metalWall ? .2 : 0 }),
      dressing: new MeshStandardMaterial({ name: 'dungeon-wall-dressing', vertexColors: true, ...surfaceMaps(wallSet), roughness: 1, metalness: metalWall ? .2 : 0 }),
    };
  }, [look, floorSet, wallSet]);
  // The texture sets are shared by every room; only the materials belong to this floor.
  useEffect(() => () => { for (const material of Object.values(materials)) material.dispose(); }, [materials]);
  const floor = useMemo(() => roomFloorGeometry(room.halfWidth, room.halfDepth, floorSet.tile), [room, floorSet]);
  const walls = useMemo(() => [
    { x: 0, z: -room.halfDepth, length: room.halfWidth * 2, rotationY: 0 }, { x: room.halfWidth, z: 0, length: room.halfDepth * 2, rotationY: -Math.PI / 2 },
    { x: 0, z: room.halfDepth, length: room.halfWidth * 2, rotationY: Math.PI }, { x: -room.halfWidth, z: 0, length: room.halfDepth * 2, rotationY: Math.PI / 2 },
  ], [room]);
  const wallGeometries = useMemo(() => walls.map(wall => roomWallGeometry(wall.length, wallSet.tile)), [walls, wallSet]);
  useEffect(() => () => { floor.dispose(); wallGeometries.forEach(geometry => geometry.dispose()); }, [floor, wallGeometries]);
  const groups = useMemo(() => {
    const byKind = new Map<string, DungeonProp[]>();
    for (const prop of room.props) {
      if (DETAILED_PROPS.has(prop.kind)) continue;
      const key = `${prop.kind}:${prop.round ? 'round' : 'box'}`; byKind.set(key, [...byKind.get(key) ?? [], prop]);
    }
    return [...byKind.entries()].map(([key, props]) => ({ key, kind: props[0].kind, props }));
  }, [room]);
  const stone = useMemo(() => `#${new Color(look.wall).lerp(new Color(look.floor), .35).getHexString()}`, [look]);
  // No dispose={null}: R3F then disposes the stairs' inline geometries on unmount. Props stay with their owners.
  return <group name={`dungeon-interior:${scene.id}`}>
    <mesh name="dungeon-floor" geometry={floor} material={materials.floor} receiveShadow
      onClick={event => { event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate({ x: event.point.x, z: event.point.z }); }} />
    {walls.map((wall, index) => <group key={index} position={[wall.x, 0, wall.z]} rotation={[0, wall.rotationY, 0]}>
      {/* Single-sided walls face into the room, so the orbit camera sees through them from outside. They still shade the floor. */}
      <mesh position={[0, ROOM_WALL_HEIGHT / 2, 0]} geometry={wallGeometries[index]} material={materials.wall} castShadow receiveShadow />
    </group>)}
    <RoomDressing scene={scene} palette={look} dressingMaterial={materials.dressing} wallTile={wallSet.tile} mobile={mobile} lit={!scene.legendary} />
    {groups.map(group => <PropBatch key={group.key} kind={group.kind} props={group.props} color={look.props[group.kind] ?? PROP_DEFAULTS[group.kind]} />)}
    {scene.legendary && <LairChamber scene={scene} stone={stone} trim={look.trim} mobile={mobile} />}
    <DungeonStairs scene={scene} />
  </group>;
}

type PartProps = { shape: 'box' | 'cylinder' | 'cone' | 'sphere'; size: readonly number[]; at: readonly [number, number, number]; color: string; rotation?: readonly [number, number, number]; glow?: boolean };
const partKey = (part: Pick<PartProps, 'color' | 'glow'>) => `${part.color}:${part.glow ?? false}`;
/** One material per colour of a landmark, owned by it: a module-wide cache kept the render objects of every landmark ever shown. */
function partMaterials(parts: readonly PartProps[]): Map<string, Material> {
  const materials = new Map<string, Material>();
  for (const { color, glow = false } of parts) {
    const key = partKey({ color, glow });
    if (!materials.has(key)) materials.set(key, new MeshStandardMaterial({ name: 'dungeon-landmark', color, roughness: .82, emissive: glow ? color : '#000000', emissiveIntensity: glow ? .8 : 0, side: DoubleSide }));
  }
  return materials;
}
function Part({ shape, size, at, rotation, material }: PartProps & { material: Material }) {
  return <mesh position={at as [number, number, number]} rotation={rotation as [number, number, number] | undefined} material={material} castShadow receiveShadow>
    {shape === 'box' ? <boxGeometry args={size as [number, number, number]} />
      : shape === 'cylinder' ? <cylinderGeometry args={[size[0], size[1], size[2], 16]} />
      : shape === 'cone' ? <coneGeometry args={[size[0], size[1], size[2] ?? 4]} />
      : <sphereGeometry args={[size[0], 12, 8]} />}
  </mesh>;
}

/** A tiered pagoda roof stack from ground level. */
function pagodaTiers(tiers: number, wall: string, roof: string, base = 3.4): PartProps[] {
  const parts: PartProps[] = [];
  let y = .4;
  for (let tier = 0; tier < tiers; tier++) {
    const size = base - tier * (base * .5 / Math.max(1, tiers)), height = tier ? 1.4 : 2;
    parts.push({ shape: 'box', size: [size, height, size], at: [0, y + height / 2, 0], color: wall });
    y += height;
    parts.push({ shape: 'cone', size: [size * .95, 1, 4], at: [0, y + .35, 0], color: roof, rotation: [0, Math.PI / 4, 0] });
    y += .55;
  }
  parts.push({ shape: 'cylinder', size: [.08, .12, 1.6], at: [0, y + .8, 0], color: '#c9a24b' });
  return parts;
}

function landmarkParts(style: DungeonStyle): PartProps[] {
  const door: PartProps = { shape: 'box', size: [1.4, 2, .12], at: [0, 1, 2.62], color: '#0d0b0c' };
  if (style === 'ghost') return [
    ...[0, 1, 2, 3].flatMap((tier): PartProps[] => {
      const size = 5.2 - tier * .55, height = tier ? 2.3 : 3.1, y = tier ? 3.1 + (tier - 1) * 2.55 : 0;
      return [{ shape: 'box', size: [size, height, size], at: [0, y + height / 2, 0], color: '#9b8cb8' },
        { shape: 'box', size: [size + .5, .28, size + .5], at: [0, y + height + .12, 0], color: '#4b3d63' },
        { shape: 'box', size: [.7, .9, .08], at: [0, y + height * .6, size / 2 + .02], color: '#281c38', glow: tier === 3 }];
    }),
    { shape: 'cone', size: [.9, 2.2, 4], at: [0, 12.9, 0], color: '#4b3d63', rotation: [0, Math.PI / 4, 0] }, door,
  ];
  if (style === 'mansion') return [
    { shape: 'box', size: [6.2, 4.6, 5], at: [0, 2.3, 0], color: '#b9ab8e' },
    { shape: 'cone', size: [4.6, 2, 4], at: [0, 5.6, 0], color: '#4a4540', rotation: [0, Math.PI / 4, 0] },
    { shape: 'box', size: [1.6, 1.4, 1.4], at: [2.4, 4.3, -1.6], color: '#2a2622' },
    ...[-2, 0, 2].flatMap((x): PartProps[] => [1.4, 3.4].map(y => ({ shape: 'box', size: [.8, .9, .08], at: [x, y, 2.52], color: '#1e1c1a' }))),
    { ...door, at: [0, 1, 2.52], size: [1.3, 2, .12] },
  ];
  if (style === 'pagoda') return [{ shape: 'box', size: [4.8, .4, 4.8], at: [0, .2, 0], color: '#8e887c' }, ...pagodaTiers(3, '#8b6440', '#4b3a2c'), { ...door, at: [0, 1.4, 1.72], size: [1, 1.8, .1] }];
  if (style === 'bell') return [{ shape: 'box', size: [5, .5, 5], at: [0, .25, 0], color: '#9c968a' }, ...pagodaTiers(6, '#9b4a33', '#c9a24b', 3.8),
    { shape: 'sphere', size: [.32], at: [0, 13.4, 0], color: '#e0bf5a', glow: true }, { ...door, at: [0, 1.4, 1.92], size: [1.1, 1.8, .1] }];
  if (style === 'charred') return [
    { shape: 'box', size: [5, .4, 5], at: [0, .2, 0], color: '#3a3430' },
    { shape: 'box', size: [4.2, 2.6, 4.2], at: [0, 1.7, 0], color: '#3a2c26' },
    { shape: 'box', size: [4.8, .3, 3.2], at: [.3, 3.2, -.4], color: '#231a16', rotation: [.22, 0, -.12] },
    { shape: 'box', size: [3.2, 1.8, 3.2], at: [-.3, 3.9, .2], color: '#2e231e' },
    { shape: 'box', size: [3.8, .25, 2.4], at: [-.3, 5, .4], color: '#1b1411', rotation: [-.3, .2, .18] },
    ...[[-1.9, -1.9], [1.9, -1.9], [-1.9, 1.9], [1.9, 1.9]].map(([x, z], index): PartProps => ({ shape: 'cylinder', size: [.16, .2, 3 + index % 2], at: [x, 1.9, z], color: '#1f1612' })),
    { shape: 'sphere', size: [.18], at: [1.4, 3.5, 1.6], color: '#ff8a3c', glow: true }, { ...door, at: [0, 1.2, 2.12], size: [1.3, 1.8, .1] },
  ];
  if (style === 'lighthouse') return [
    { shape: 'cylinder', size: [1.6, 2.4, 11], at: [0, 5.5, 0], color: '#eceae4' },
    ...[2.5, 6.5].map((y): PartProps => ({ shape: 'cylinder', size: [2.2 - y * .07, 2.3 - y * .07, 1.1], at: [0, y, 0], color: '#b44a3b' })),
    { shape: 'cylinder', size: [2.3, 2.3, .2], at: [0, 11.1, 0], color: '#4a4f52' },
    { shape: 'cylinder', size: [1.1, 1.1, 1.5], at: [0, 11.95, 0], color: '#ffe7a0', glow: true },
    { shape: 'cone', size: [1.4, 1.2, 12], at: [0, 13.3, 0], color: '#b44a3b' },
    { shape: 'box', size: [3.4, 2.4, 2], at: [0, 1.2, 1.9], color: '#e2ddd2' }, { ...door, at: [0, 1, 2.92], size: [1.1, 1.8, .1] },
  ];
  if (style === 'industrial') return [
    { shape: 'box', size: [6.4, 3.4, 5.4], at: [0, 1.7, 0], color: '#8a9296' },
    { shape: 'box', size: [6.8, .3, 5.8], at: [0, 3.55, 0], color: '#5b6367' },
    { shape: 'box', size: [6.42, .4, 5.42], at: [0, .9, 0], color: '#d8b43a' },
    ...[-1.8, 1.6].map((x): PartProps => ({ shape: 'cylinder', size: [.42, .55, 5.4], at: [x, 5.9, -1.5], color: '#6c7478' })),
    { shape: 'box', size: [.5, .5, 4.2], at: [3.2, 2.6, -.2], color: '#4d5559' }, { ...door, at: [0, 1.1, 2.72], size: [1.8, 2.2, .1] },
  ];
  if (style === 'ruins') return [
    { shape: 'box', size: [6, .8, 5], at: [0, .4, 0], color: '#a8997a' },
    ...[[-2.3, 1.8], [2.3, 1.8], [-2.3, -1.8], [2.3, -1.8]].map(([x, z]): PartProps => ({ shape: 'cylinder', size: [.38, .45, 2.8], at: [x, 2.2, z], color: '#b3a47f' })),
    { shape: 'box', size: [5.6, .5, 4.4], at: [0, 3.85, 0], color: '#97896a' },
    { shape: 'box', size: [2.8, 2.2, 2.4], at: [0, 1.9, -.4], color: '#8f8268' }, { ...door, at: [0, 1.7, .82], size: [1.2, 1.7, .1] },
  ];
  if (style === 'stone') return [
    { shape: 'cylinder', size: [2, 2.7, 10], at: [0, 5, 0], color: '#8d8a84' },
    ...[2, 4.5, 7].map((y): PartProps => ({ shape: 'cylinder', size: [2.75 - y * .07, 2.8 - y * .07, .3], at: [0, y, 0], color: '#6f6c66' })),
    { shape: 'cone', size: [2.1, 2.4, 10], at: [0, 11.2, 0], color: '#5c5a55' }, { ...door, at: [0, 1, 2.6], size: [1.2, 2, .1] },
  ];
  if (style === 'sand') return [
    { shape: 'box', size: [6, 2.4, 5.2], at: [0, 1.2, 0], color: '#c8a974' },
    { shape: 'cone', size: [4, 2.6, 4], at: [0, 3.7, 0], color: '#b39460', rotation: [0, Math.PI / 4, 0] },
    { shape: 'sphere', size: [1.2], at: [2.2, .3, 2], color: '#d9bd84' }, { ...door, at: [0, 1, 2.62], size: [1.3, 1.9, .1] },
  ];
  if (style === 'warehouse') return [
    { shape: 'box', size: [6.4, 3, 5], at: [0, 1.5, 0], color: '#6f8aa0' },
    { shape: 'box', size: [6.6, .25, 5.2], at: [0, 3.1, 0], color: '#3f4a52' },
    ...[.6, 1.1, 1.6].map((y): PartProps => ({ shape: 'box', size: [2.2, .06, .06], at: [0, y, 2.53], color: '#a9b6be' })), { ...door, at: [0, 1, 2.52], size: [2.2, 2, .1] },
  ];
  return [{ shape: 'box', size: [5, 3, 5], at: [0, 1.5, 0], color: '#77736b' }, door];
}

function DungeonLandmark({ scene, portal, y, onEnter }: { scene: CaveScene; portal: CavePortal; y: number; onEnter?: () => void }) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => () => { if (hovered) document.body.style.cursor = ''; }, [hovered]);
  const parts = useMemo(() => landmarkParts(scene.style), [scene.style]);
  const materials = useMemo(() => partMaterials(parts), [parts]);
  useEffect(() => () => materials.forEach(material => material.dispose()), [materials]);
  const landmark = portal.landmark!;
  const pointer = onEnter ? {
    onPointerOver: (event: { stopPropagation(): void }) => { event.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; },
    onPointerOut: () => { setHovered(false); document.body.style.cursor = ''; },
    onClick: (event: { stopPropagation(): void; delta: number }) => { event.stopPropagation(); if (event.delta <= 5) onEnter(); },
  } : {};
  return <group name={`dungeon-entrance:${scene.dungeonId}`} position={[landmark.x, y, landmark.z]} rotation={[0, landmark.rotationY, 0]}>
    <group {...pointer}>{parts.map((part, index) => <Part key={index} {...part} material={materials.get(partKey(part))!} />)}</group>
    {hovered && <mesh position={[0, .08, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[3.7, 4.1, 48]} /><meshBasicMaterial color="#ffe27a" transparent opacity={.85} depthWrite={false} /></mesh>}
  </group>;
}

/** Towers, buildings and plants on the surface. Clicking one walks to its door and goes in. */
export function DungeonEntrances({ regionId, player, sample, onEnter }: { regionId: string; player: WorldPoint; sample(x: number, z: number): WorldSample; onEnter?: (portalId: string) => void }) {
  const cellX = Math.round(player.x / 8), cellZ = Math.round(player.z / 8);
  const entries = useMemo(() => CAVE_SCENES.filter(scene => scene.regionId === regionId).flatMap(scene => scene.portals.filter(portal => portal.landmark
    && Math.hypot(portal.landmark.x - cellX * 8, portal.landmark.z - cellZ * 8) < 100).map(portal => ({ scene, portal }))), [regionId, cellX, cellZ]);
  return <group name="dungeon-entrances">{entries.map(({ scene, portal }) => <DungeonLandmark key={portal.id} scene={scene} portal={portal}
    y={terrainSurfaceHeight(sample, portal.surface.x, portal.surface.z)} onEnter={onEnter && (() => onEnter(portal.id))} />)}</group>;
}
