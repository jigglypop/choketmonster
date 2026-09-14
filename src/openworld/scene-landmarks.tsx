import { Html } from '@react-three/drei';
import { useLayoutEffect, useRef } from 'react';
import { InstancedMesh, Matrix4 } from 'three';
import { CAVE_SCENES, getCaveScene, type CaveScene } from './caves';
import type { WorldPoint, WorldSample } from './types';

export function CaveInterior({ cave, onNavigate }: { cave: CaveScene; onNavigate(point: WorldPoint): void }) {
  const walls = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!walls.current) return;
    const matrix = new Matrix4();
    cave.wallSegments.forEach((wall, index) => {
      // Low cutaway walls leave corridors readable from the orbit camera.
      matrix.makeScale(wall.width, 1.8, wall.depth); matrix.setPosition(wall.x, .9, wall.z);
      walls.current!.setMatrixAt(index, matrix);
    });
    walls.current.instanceMatrix.needsUpdate = true; walls.current.computeBoundingSphere();
  }, [cave]);
  return <group name={`cave-interior:${cave.id}`}>
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow onClick={event => { event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate({ x: event.point.x, z: event.point.z }); }}>
      <planeGeometry args={[cave.width, cave.depth]} /><meshStandardMaterial color={cave.id === 'ice-path' ? '#aacbcf' : '#777b73'} roughness={.95} />
    </mesh>
    <instancedMesh name="cave-walls" ref={walls} args={[undefined, undefined, cave.wallSegments.length]}>
      <boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={cave.id === 'ice-path' ? '#51778a' : '#414b48'} roughness={.9} />
    </instancedMesh>
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
