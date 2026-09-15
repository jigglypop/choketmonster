import { Html } from '@react-three/drei';
import { useEffect, useMemo } from 'react';
import { BoxGeometry, MeshStandardMaterial, PlaneGeometry } from 'three';
import { CAVE_SCENES, getCaveScene, type CaveScene } from './caves';
import { useSurfaceTextures } from './materials';
import type { WorldPoint, WorldSample } from './types';

const CAVE_TEXTURE_TILE = 2.5;

function tileUvs(geometry: PlaneGeometry | BoxGeometry) {
  const positions = geometry.attributes.position, normals = geometry.attributes.normal, uvs = geometry.attributes.uv;
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
    const nx = Math.abs(normals.getX(index)), ny = Math.abs(normals.getY(index));
    if (nx > ny && nx > Math.abs(normals.getZ(index))) uvs.setXY(index, z / CAVE_TEXTURE_TILE, y / CAVE_TEXTURE_TILE);
    else if (ny > Math.abs(normals.getZ(index))) uvs.setXY(index, x / CAVE_TEXTURE_TILE, z / CAVE_TEXTURE_TILE);
    else uvs.setXY(index, x / CAVE_TEXTURE_TILE, y / CAVE_TEXTURE_TILE);
  }
  uvs.needsUpdate = true;
  return geometry;
}

export function CaveInterior({ cave, onNavigate }: { cave: CaveScene; onNavigate(point: WorldPoint): void }) {
  const textures = useSurfaceTextures('rock');
  const material = useMemo(() => {
    const result = new MeshStandardMaterial({
      name: 'cave-rock-pbr', color: cave.id === 'ice-path' ? '#a8c5ca' : '#8a8d82', roughness: .95, metalness: 0,
      map: textures.diffuse, normalMap: textures.normal, roughnessMap: textures.arm, aoMap: textures.arm,
    });
    result.userData.openWorldSurface = 'cave-rock-uv';
    return result;
  }, [cave.id, textures]);
  const floor = useMemo(() => tileUvs(new PlaneGeometry(cave.width, cave.depth)), [cave]);
  const walls = useMemo(() => cave.wallSegments.map(wall => tileUvs(new BoxGeometry(wall.width, wall.height, wall.depth))), [cave]);
  useEffect(() => () => { material.dispose(); floor.dispose(); walls.forEach(wall => wall.dispose()); }, [floor, material, walls]);
  return <group name={`cave-interior:${cave.id}`} dispose={null}>
    <mesh name="cave-floor" geometry={floor} material={material} rotation={[-Math.PI / 2, 0, 0]} receiveShadow onClick={event => { event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate({ x: event.point.x, z: event.point.z }); }}>
    </mesh>
    <group name="cave-walls">{cave.wallSegments.map((wall, index) =>
      <mesh key={index} name={`cave-wall:${index}`} geometry={walls[index]} material={material} position={[wall.x, wall.height / 2, wall.z]} receiveShadow castShadow />)}</group>
  </group>;
}

export function ScenePortals({ sceneId, regionId, player, sample, onNavigate, onPortal }: {
  sceneId: string; regionId: string; player: WorldPoint; sample(x: number, z: number): WorldSample;
  onNavigate(point: WorldPoint): void; onPortal(): void;
}) {
  const cave = getCaveScene(sceneId);
  const entries = (cave ? [cave] : CAVE_SCENES.filter(item => item.regionId === regionId)).flatMap(item => item.portals.map(portal => ({
    id: portal.id, point: cave ? portal.interior : portal.surface,
    name: item.name, action: cave ? '밖으로 나가기' : '동굴 들어가기',
    destination: cave ? portal.surfaceLocationId : item.encounterLocationId,
  }))).filter(entry => Math.hypot(entry.point.x - player.x, entry.point.z - player.z) < 36);
  return <group name="scene-portals">{entries.map(entry => {
    const distance = Math.hypot(entry.point.x - player.x, entry.point.z - player.z);
    const interact = () => { if (distance <= (cave ? 1.35 : 3.6)) onPortal(); else onNavigate(entry.point); };
    return <group key={entry.id} position={[entry.point.x, sample(entry.point.x, entry.point.z).height, entry.point.z]}>
      <mesh position={[0, .05, 0]} rotation={[-Math.PI / 2, 0, 0]} onClick={event => { event.stopPropagation(); interact(); }}>
        <ringGeometry args={[.6, .85, 24]} /><meshBasicMaterial color={cave ? '#ffd98e' : '#94e2e0'} transparent opacity={.95} />
      </mesh>
      <Html center position={[0, 2.8, 0]} zIndexRange={[12, 11]} style={{ pointerEvents: 'auto' }}>
        <button className="world-portal-label" data-portal={entry.id} onClick={interact}><strong>{entry.name}</strong><span>{entry.action}{distance > 4 ? ` · ${Math.round(distance)}m` : ''}</span></button>
      </Html>
    </group>;
  })}</group>;
}
