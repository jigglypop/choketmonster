import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group } from 'three';
import { terrainSurfaceHeight } from './grounding';
import { FIELD_PICKUP_COLLECT_DISTANCE } from './item-sources';
import type { WorldFieldItemPickup, WorldPoint, WorldSample } from './types';

function Pickup({ item, player, sample, onNavigate, onCollect }: { item: WorldFieldItemPickup; player: WorldPoint; sample(x: number, z: number): WorldSample; onNavigate(point: WorldPoint): void; onCollect(id: string): void }) {
  const visual = useRef<Group>(null), stone = item.kind === 'mega-stone';
  const distance = Math.hypot(item.x - player.x, item.z - player.z), close = distance <= FIELD_PICKUP_COLLECT_DISTANCE;
  const color = stone ? '#ae83ff' : '#edbb55';
  const markDrawn = () => { if (visual.current) visual.current.userData.drawn = (visual.current.userData.drawn ?? 0) + 1; };
  useFrame(({ clock }) => { if (visual.current) { visual.current.rotation.y = clock.elapsedTime * .45; visual.current.position.y = .52 + Math.sin(clock.elapsedTime * 2.2) * .045; } });
  const interact = () => close ? onCollect(item.id) : onNavigate(item);
  return <group name={`field-pickup:${item.id}`} position={[item.x, terrainSurfaceHeight(sample, item.x, item.z) + .06, item.z]} userData={{ itemId: item.itemId }}>
    <mesh rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[.38, .46, 24]} /><meshBasicMaterial color={color} transparent opacity={.65} depthWrite={false} /></mesh>
    <group ref={visual} name="field-item-model" position={[0, .52, 0]} onClick={event => { event.stopPropagation(); if (event.delta < 6) interact(); }}>
      {stone ? <>
        <mesh onBeforeRender={markDrawn}><octahedronGeometry args={[.33]} /><meshStandardMaterial color={color} emissive="#6f3dab" emissiveIntensity={.25} metalness={.25} roughness={.23} /></mesh>
        <mesh rotation={[0, 0, .55]}><torusGeometry args={[.21, .035, 6, 18]} /><meshStandardMaterial color="#ffdb72" metalness={.4} roughness={.35} /></mesh>
      </> : <>
        <mesh onBeforeRender={markDrawn}><boxGeometry args={[.5, .38, .35]} /><meshStandardMaterial color="#b38644" roughness={.9} /></mesh>
        <mesh position={[0, .21, 0]}><boxGeometry args={[.55, .1, .4]} /><meshStandardMaterial color={color} roughness={.85} /></mesh>
        <mesh position={[0, .05, -.181]}><boxGeometry args={[.12, .2, .04]} /><meshStandardMaterial color="#f3d47c" metalness={.25} /></mesh>
      </>}
    </group>
    {distance < 12 && <Html center position={[0, 1.35, 0]} zIndexRange={[8, 7]}><button className={`world-pickup-label ${stone ? 'mega' : ''}`} data-field-pickup={item.id} data-item-id={item.itemId} onClick={interact}>{item.name}<small>{close ? '줍기' : `${Math.round(distance)}m`}</small></button></Html>}
  </group>;
}

export function FieldItemPickups({ items, ...props }: { items: readonly WorldFieldItemPickup[]; player: WorldPoint; sample(x: number, z: number): WorldSample; onNavigate(point: WorldPoint): void; onCollect(id: string): void }) {
  return <group name="field-item-pickups">{items.filter(item => Math.hypot(item.x - props.player.x, item.z - props.player.z) < 65).map(item => <Pickup key={`${item.id}:${item.itemId}`} item={item} {...props} />)}</group>;
}
