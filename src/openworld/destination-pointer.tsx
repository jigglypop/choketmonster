import { useThree } from '@react-three/fiber';
import { DoubleSide, Shape } from 'three';
import { terrainSurfaceHeight } from './grounding';
import type { DestinationGuide } from './next-destination';
import type { WorldSample } from './types';

const arrow = new Shape();
arrow.moveTo(0, 1);
arrow.lineTo(.7, .1);
arrow.lineTo(.28, .1);
arrow.lineTo(.28, -.7);
arrow.lineTo(-.28, -.7);
arrow.lineTo(-.28, .1);
arrow.lineTo(-.7, .1);
arrow.closePath();

/** Ground pointer along the authored route, independent of the neural policy. */
export function DestinationPointer({ guide, sample }: { guide: DestinationGuide; sample(x: number, z: number): WorldSample }) {
  const compact = useThree(state => state.size.width < 600);
  const anchorIndex = Math.min(guide.points.length - 1, compact ? 1 : 3);
  const anchor = guide.points[anchorIndex];
  if (!anchor || guide.status !== 'route') return null;
  const end = guide.points[Math.min(guide.points.length - 1, anchorIndex + 6)];
  const start = end === anchor ? guide.points[Math.max(0, anchorIndex - 1)] : anchor;
  const heading = Math.atan2(end.x - start.x, end.z - start.z);
  return <group name="campaign-destination-pointer"
    position={[anchor.x, terrainSurfaceHeight(sample, anchor.x, anchor.z) + .25, anchor.z]}
    rotation={[0, heading, 0]}>
    <mesh rotation={[Math.PI / 2, 0, 0]} scale={1.2} renderOrder={3}>
      <shapeGeometry args={[arrow]} /><meshBasicMaterial color="#28343d" side={DoubleSide} depthWrite={false} />
    </mesh>
    <mesh position={[0, .015, 0]} rotation={[Math.PI / 2, 0, 0]} renderOrder={4}>
      <shapeGeometry args={[arrow]} /><meshBasicMaterial color="#ffed75" side={DoubleSide} depthWrite={false} />
    </mesh>
  </group>;
}
