import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Group } from 'three';
import { terrainSurfaceHeight } from './grounding';
import type { DestinationGuide } from './next-destination';
import type { WorldSample } from './types';

/** A visible game-designed wayfinder. It neither steers nor trains the circuit. */
export function FlyGuide({ guide, sample }: { guide: DestinationGuide; sample(x: number, z: number): WorldSample }) {
  const fly = useRef<Group>(null), wings = useRef<Group>(null);
  const points = guide.points.slice(0, 19).filter((_, index) => index % 4 === 0);
  const anchor = points[Math.min(points.length - 1, 2)];
  useFrame(({ clock }) => {
    if (fly.current) fly.current.position.y = .9 + Math.sin(clock.elapsedTime * 3) * .12;
    if (wings.current) wings.current.scale.x = .8 + Math.abs(Math.sin(clock.elapsedTime * 24)) * .35;
  });
  if (!anchor || guide.status !== 'route') return null;
  const end = guide.points[Math.min(guide.points.length - 1, 14)] ?? anchor;
  return <group name="campaign-fly-guide">
    {points.map((point, index) => <mesh key={index} position={[point.x, terrainSurfaceHeight(sample, point.x, point.z) + .08, point.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={3}>
      <ringGeometry args={[.14, .24, 12]} /><meshBasicMaterial color="#fff5b7" depthWrite={false} />
    </mesh>)}
    <group position={[anchor.x, terrainSurfaceHeight(sample, anchor.x, anchor.z), anchor.z]} rotation={[0, Math.atan2(end.x - anchor.x, end.z - anchor.z), 0]}>
      <group ref={fly} position={[0, .9, 0]}>
        <mesh scale={[.14, .15, .27]}><sphereGeometry args={[1, 10, 8]} /><meshBasicMaterial color="#493525" /></mesh>
        <mesh position={[0, .07, .23]}><sphereGeometry args={[.14, 10, 8]} /><meshBasicMaterial color="#de7357" /></mesh>
        <group ref={wings}>
          {[-1, 1].map(side => <mesh key={side} position={[side * .24, .12, -.02]} rotation={[0, side * .4, side * .15]} scale={[.3, .025, .17]}><sphereGeometry args={[1, 10, 6]} /><meshBasicMaterial color="#f4ffff" transparent opacity={.88} /></mesh>)}
        </group>
        <mesh position={[0, -.36, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[.3, .36, 20]} /><meshBasicMaterial color="#ffe79a" /></mesh>
      </group>
    </group>
  </group>;
}
