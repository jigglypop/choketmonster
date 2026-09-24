import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { MeshBasicMaterial, MeshStandardMaterial, type Group, type Material, type PointLight } from 'three';
import type { CaveScene } from './caves';
import { contactShadowTexture, stainGeometry } from './interior-kit';
import { interiorSurface } from './interior-textures';
import { carvedMaterial, glowMaterial } from './lair-chamber';
import { floorDressing, roomProps, roomWalls, wallDressing, type Glow, type RoomPalette, type Stain } from './temple-geometry';

const flat = () => 0;

/** Contact shadows (unlit, dark) or moss (lit, tinted) laid on the floor as one transparent mesh. */
export function FloorStains({ stains, kind, height = flat }: { stains: readonly Stain[]; kind: 'shadow' | 'moss'; height?: (x: number, z: number) => number }) {
  const geometry = useMemo(() => stains.length ? stainGeometry(stains, height, kind === 'shadow' ? .018 : .012) : undefined, [stains, height, kind]);
  const material = useMemo<Material>(() => {
    const options = { map: contactShadowTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
    const result = kind === 'shadow'
      ? new MeshBasicMaterial({ name: 'floor-contact-shadows', color: '#050607', opacity: .42, ...options })
      : new MeshStandardMaterial({ name: 'floor-moss', vertexColors: true, roughness: .95, opacity: .8, ...options });
    result.forceSinglePass = true;
    return result;
  }, [kind]);
  useEffect(() => () => { geometry?.dispose(); material.dispose(); }, [geometry, material]);
  if (!geometry) return null;
  return <mesh name={`floor-${kind}`} geometry={geometry} material={material} receiveShadow={kind === 'moss'} renderOrder={1} dispose={null} />;
}

/** Up to `limit` flickering fire lights. The count is fixed for the floor, so materials never recompile. */
export function FireLights({ fires, limit }: { fires: readonly Glow[]; limit: number }) {
  const lights = useRef<Array<PointLight | null>>([]), chosen = fires.slice(0, limit);
  useFrame(({ clock }) => {
    const time = clock.elapsedTime;
    lights.current.forEach((light, index) => { if (light) light.intensity = 5 * (1 + Math.sin(time * 8.3 + index * 1.7) * .08 + Math.sin(time * 21.1 + index) * .05); });
  });
  return <>{chosen.map((fire, index) => <pointLight key={index} ref={light => { lights.current[index] = light; }} name="dungeon-fire-light"
    position={[fire.x, fire.y + .25, fire.z]} color={fire.color} intensity={5} distance={9} decay={2} />)}</>;
}

/**
 * Architecture and furniture for a tower, temple, ruin or building floor. Wall dressing hides while the camera
 * is outside that wall, like the single-sided wall itself, so the orbit camera always sees in; it only receives
 * shadows so hiding it never makes one blink. Freestanding pieces cast shadows and get contact shadows.
 */
export function RoomDressing({ scene, palette, dressingMaterial, wallTile, mobile, lit }: {
  scene: CaveScene; palette: RoomPalette; dressingMaterial: Material; wallTile: number; mobile: boolean; lit: boolean;
}) {
  const room = scene.room!, walls = useMemo(() => roomWalls(room.halfWidth, room.halfDepth), [room]);
  const dressing = useMemo(() => walls.map((wall, index) => wallDressing(scene.style, palette, wall.length, index, scene.relief.seed, wallTile)), [walls, scene, palette, wallTile]);
  const grainTile = interiorSurface('grain').tile;
  const props = useMemo(() => roomProps(scene, palette, grainTile), [scene, palette, grainTile]);
  const floor = useMemo(() => floorDressing(scene, palette, grainTile), [scene, palette, grainTile]);
  const shadows = useMemo<Stain[]>(() => [
    ...floor.shadows,
    ...room.props.filter(prop => prop.kind !== 'rug' && prop.kind !== 'hole' && prop.height > .3).map(prop => ({
      x: prop.x, z: prop.z, radiusX: (prop.round ? Math.max(prop.width, prop.depth) : prop.width) / 2 + .5, radiusZ: (prop.round ? Math.max(prop.width, prop.depth) : prop.depth) / 2 + .5, color: '#000000',
    })),
  ], [floor, room]);
  const materials = useMemo(() => ({ carved: carvedMaterial('dungeon-carved'), glow: glowMaterial('dungeon-glow') }), []);
  useEffect(() => () => { Object.values(materials).forEach(material => material.dispose()); }, [materials]);
  useEffect(() => () => {
    for (const built of [...dressing, props, floor]) { built.solid?.dispose(); built.glow?.dispose(); }
  }, [dressing, props, floor]);
  const groups = useRef<Array<Group | null>>([]);
  useFrame(({ camera }) => {
    walls.forEach((wall, index) => {
      const group = groups.current[index]; if (!group) return;
      group.visible = (camera.position.x - wall.x) * wall.inward.x + (camera.position.z - wall.z) * wall.inward.z > -.2;
    });
  });
  const fires = useMemo(() => [...floor.fires, ...props.lanterns], [floor, props]);
  return <group name="room-dressing">
    {walls.map((wall, index) => <group key={index} ref={group => { groups.current[index] = group; }} name={`wall-dressing:${index}`} position={[wall.x, 0, wall.z]} rotation={[0, wall.rotationY, 0]}>
      {dressing[index].solid && <mesh geometry={dressing[index].solid} material={dressingMaterial} receiveShadow dispose={null} />}
      {dressing[index].glow && <mesh geometry={dressing[index].glow} material={materials.glow} dispose={null} />}
    </group>)}
    {props.solid && <mesh name="room-props" geometry={props.solid} material={materials.carved} castShadow receiveShadow dispose={null} />}
    {props.glow && <mesh name="room-props-glow" geometry={props.glow} material={materials.glow} dispose={null} />}
    {floor.solid && <mesh name="room-floor-dressing" geometry={floor.solid} material={materials.carved} castShadow receiveShadow dispose={null} />}
    {floor.glow && <mesh name="room-floor-dressing-glow" geometry={floor.glow} material={materials.glow} dispose={null} />}
    <FloorStains stains={shadows} kind="shadow" />
    <FloorStains stains={floor.moss} kind="moss" />
    {lit && <FireLights fires={fires} limit={mobile ? 1 : 2} />}
  </group>;
}
