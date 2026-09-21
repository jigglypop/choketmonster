import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { ExtrudeGeometry, Group, Mesh, Shape, Vector3, type Object3D } from 'three';
import type { PokemonType } from '../game/contracts';

type Point = [number, number];
const SYMBOLS: Record<PokemonType, Point[]> = {
  normal: [[0, .58], [.12, .19], [.53, .18], [.21, -.07], [.34, -.48], [0, -.23], [-.34, -.48], [-.21, -.07], [-.53, .18], [-.12, .19]],
  fire: [[0, .62], [.12, .22], [.32, .4], [.4, -.12], [.22, -.4], [-.22, -.4], [-.42, -.12], [-.28, .3], [-.15, .06]],
  water: [[0, .62], [.36, .02], [.38, -.2], [.23, -.4], [-.23, -.4], [-.38, -.2], [-.36, .02]],
  electric: [[.12, .62], [-.4, -.05], [-.06, -.05], [-.18, -.58], [.42, .13], [.08, .13]],
  grass: [[.4, .58], [.38, -.1], [.1, -.38], [-.25, -.35], [-.4, -.12], [-.3, .18]],
  ice: [[0, .58], [.1, .18], [.5, .3], [.22, 0], [.5, -.3], [.1, -.18], [0, -.58], [-.1, -.18], [-.5, -.3], [-.22, 0], [-.5, .3], [-.1, .18]],
  fighting: [[-.4, -.38], [-.48, .03], [-.2, .12], [-.2, .4], [.33, .4], [.43, .25], [.4, -.38]],
  poison: [[0, .43], [.32, .3], [.4, .05], [.24, -.15], [.24, -.4], [-.24, -.4], [-.24, -.15], [-.4, .05], [-.32, .3]],
  ground: [[-.52, -.35], [-.22, .2], [-.1, .02], [.18, .52], [.52, -.35]],
  flying: [[-.45, -.35], [-.32, .3], [.54, .52], [.3, .15], [.05, .08], [.3, -.02], [.03, -.2]],
  psychic: [[0, .5], [.48, 0], [0, -.5], [-.48, 0]],
  bug: [[-.27, -.4], [-.45, .05], [-.2, .35], [-.3, .58], [0, .4], [.3, .58], [.2, .35], [.45, .05], [.27, -.4]],
  rock: [[-.48, -.35], [-.43, .18], [-.15, .45], [.3, .4], [.5, -.05], [.3, -.38]],
  ghost: [[-.4, -.42], [-.4, .12], [-.22, .4], [.15, .45], [.4, .18], [.4, -.42], [.13, -.22], [0, -.4], [-.15, -.22]],
  dragon: [[-.38, -.4], [-.25, .1], [-.05, .22], [-.18, .58], [.2, .4], [.48, .06], [.23, -.05], [.1, -.4]],
  dark: [[.3, .5], [-.17, .4], [-.42, .08], [-.36, -.23], [-.02, -.46], [.4, -.35], [.05, -.2], [-.08, .1]],
  steel: [[-.45, -.25], [-.45, .25], [0, .5], [.45, .25], [.45, -.25], [0, -.5]],
  fairy: [[0, .58], [.15, .15], [.53, 0], [.15, -.15], [0, -.58], [-.15, -.15], [-.53, 0], [-.15, .15]],
};

export function TeraCrown({ type, color, height, anchor }: { type: PokemonType; color: string; height: number; anchor?: Object3D }) {
  const root = useRef<Group>(null), point = useMemo(() => new Vector3(), []);
  const geometry = useMemo(() => {
    const points = SYMBOLS[type], shape = new Shape();
    shape.moveTo(...points[0]); points.slice(1).forEach(point => shape.lineTo(...point)); shape.closePath();
    const result = new ExtrudeGeometry(shape, { depth: .15, bevelEnabled: true, bevelThickness: .055, bevelSize: .04, bevelSegments: 1, steps: 1 });
    result.translate(0, 0, -.075);
    return result;
  }, [type]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const scale = Math.max(.48, Math.min(.8, height * .4));
  useFrame(() => {
    if (!anchor || !root.current?.parent) return;
    anchor.getWorldPosition(point);
    root.current.parent.worldToLocal(point);
    root.current.position.copy(point);
    root.current.position.y += scale * .22;
  });
  useEffect(() => {
    const group = root.current;
    return () => group?.traverse(node => {
      if (!(node instanceof Mesh)) return;
      node.geometry.dispose();
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
    });
  }, []);
  return <group ref={root} name={`tera-crown:${type}`} position={[0, height + scale * .2, 0]} scale={scale}>
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <torusGeometry args={[.38, .055, 4, 12]} />
      <meshPhysicalMaterial color="#dff9ff" metalness={.25} roughness={.08} clearcoat={1} />
    </mesh>
    <mesh geometry={geometry} position={[0, .62, 0]}>
      <meshPhysicalMaterial color={color} metalness={.18} roughness={.07} clearcoat={1} iridescence={.6} emissive={color} emissiveIntensity={.2} flatShading />
    </mesh>
    {[-1, 1].map(side => <mesh key={side} position={[side * .32, .17, 0]} rotation={[0, 0, -side * .35]}>
      <octahedronGeometry args={[.19, 0]} />
      <meshPhysicalMaterial color="#dff9ff" metalness={.15} roughness={.07} clearcoat={1} iridescence={.8} flatShading />
    </mesh>)}
  </group>;
}
