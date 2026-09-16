import { useLayoutEffect, useMemo, useRef } from 'react';
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';

type StadiumPalette = { shell: string; trim: string; seat: string; field: string; accent: string };

const PALETTES: Record<string, StadiumPalette> = {
  johto: { shell: '#d8cfb9', trim: '#46546b', seat: '#76516b', field: '#55835d', accent: '#d6b85c' },
  kanto: { shell: '#d8d5cb', trim: '#415d75', seat: '#6c4563', field: '#4f8059', accent: '#d8b951' },
  hoenn: { shell: '#e1ded1', trim: '#397995', seat: '#3c7790', field: '#4e8768', accent: '#d06b4d' },
  sinnoh: { shell: '#d6dce0', trim: '#54677a', seat: '#45546c', field: '#5c7d6c', accent: '#879bb0' },
  unova: { shell: '#c9c3b5', trim: '#3b3c4d', seat: '#292e43', field: '#526e5a', accent: '#9c665c' },
  kalos: { shell: '#ece4d8', trim: '#335a7f', seat: '#874d66', field: '#568165', accent: '#d5b452' },
  alola: { shell: '#eee5cf', trim: '#397d91', seat: '#d16b55', field: '#568a66', accent: '#f0c85b' },
};

type Instance = { position: [number, number, number]; scale: [number, number, number]; rotationY?: number };

function InstanceBatch({ name, items, color, emissive }: { name: string; items: readonly Instance[]; color: string; emissive?: string }) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current, matrix = new Matrix4(), rotation = new Quaternion(), position = new Vector3(), scale = new Vector3();
    if (!mesh) return;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      rotation.setFromAxisAngle(new Vector3(0, 1, 0), item.rotationY ?? 0);
      matrix.compose(position.set(...item.position), rotation, scale.set(...item.scale));
      mesh.setMatrixAt(index, matrix);
    }
    mesh.count = items.length; mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
  }, [items]);
  return <instancedMesh ref={ref} name={name} args={[undefined, undefined, Math.max(1, items.length)]} castShadow receiveShadow>
    <boxGeometry args={[1, 1, 1]} />
    <meshStandardMaterial color={color} emissive={emissive ?? '#000000'} emissiveIntensity={emissive ? .45 : 0} roughness={emissive ? .48 : .78} />
  </instancedMesh>;
}

/** Compact open-air league stadium. The south opening faces the playable approach. */
export function LeagueStadium({ region }: { region: string }) {
  const palette = PALETTES[region] ?? PALETTES.kanto;
  const entranceGap = .72, arcStart = -Math.PI / 2 + entranceGap / 2, arcLength = Math.PI * 2 - entranceGap;
  const seats = useMemo(() => Array.from({ length: 3 }, (_, tier) => Array.from({ length: 34 }, (_, index): Instance => {
    const angle = arcStart + (index + .5) / 34 * arcLength;
    const radius = 5.5 + tier * 1.05;
    return { position: [Math.cos(angle) * radius * 1.34, .72 + tier * .48, -Math.sin(angle) * radius],
      scale: [.52, .16, .38], rotationY: angle + Math.PI / 2 };
  })).flat(), [arcLength, arcStart]);
  const towers = useMemo<Instance[]>(() => [[-8.6, 2.9, -5.9], [8.6, 2.9, -5.9], [-8.6, 2.9, 5.1], [8.6, 2.9, 5.1]]
    .map(position => ({ position: position as [number, number, number], scale: [.22, 5.8, .22] })), []);
  const lamps = useMemo<Instance[]>(() => [[-8.6, 5.95, -5.9], [8.6, 5.95, -5.9], [-8.6, 5.95, 5.1], [8.6, 5.95, 5.1]]
    .map(position => ({ position: position as [number, number, number], scale: [1.15, .38, .22] })), []);
  const entrancePiers = useMemo<Instance[]>(() => [-2.5, 2.5].map(x => ({ position: [x, 1.25, 6.8] as [number, number, number], scale: [.55, 2.5, 1.2] as [number, number, number] })), []);

  return <group name={`league-stadium:${region}`}>
    <mesh name="league-battle-field" position={[0, .1, 0]} scale={[1.42, 1, 1]} receiveShadow>
      <cylinderGeometry args={[4.55, 4.55, .2, 64]} />
      <meshStandardMaterial color={palette.field} roughness={.9} />
    </mesh>
    <mesh name="league-field-boundary" position={[0, .215, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[1.42, 1, 1]}>
      <ringGeometry args={[4.15, 4.27, 64]} /><meshBasicMaterial color="#f3ead0" />
    </mesh>
    <mesh position={[0, .22, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[.82, .96, 40]} /><meshBasicMaterial color="#f3ead0" />
    </mesh>
    <mesh position={[0, .225, 0]}><boxGeometry args={[.12, .025, 8.2]} /><meshBasicMaterial color="#f3ead0" /></mesh>

    {[0, 1, 2].map(tier => <group key={tier} position={[0, .3 + tier * .48, 0]} scale={[1.34, 1, 1]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <ringGeometry args={[5.05 + tier * 1.02, 6 + tier * 1.02, 64, 1, arcStart, arcLength]} />
        <meshStandardMaterial color={tier % 2 ? palette.trim : palette.shell} roughness={.86} side={2} />
      </mesh>
    </group>)}
    <mesh name="league-stadium-facade" position={[0, 1.4, 0]} scale={[1.34, 1, 1]} castShadow receiveShadow>
      <cylinderGeometry args={[8.05, 8.05, 2.8, 64, 1, true, arcStart, arcLength]} />
      <meshStandardMaterial color={palette.shell} roughness={.82} side={2} />
    </mesh>
    <InstanceBatch name="league-stadium-seats" items={seats} color={palette.seat} />

    <mesh name="league-canopy" position={[0, 4.45, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[1.34, 1, 1]} castShadow>
      <ringGeometry args={[6.9, 8.5, 64, 1, arcStart, arcLength]} />
      <meshStandardMaterial color={palette.trim} metalness={.12} roughness={.64} side={2} />
    </mesh>
    <mesh name="league-entry-walk" position={[0, .11, 7.4]} receiveShadow>
      <boxGeometry args={[4.3, .2, 5]} /><meshStandardMaterial color="#c8c2b2" roughness={.92} />
    </mesh>
    <InstanceBatch name="league-entry-piers" items={entrancePiers} color={palette.shell} />
    <mesh position={[0, 2.75, 6.8]} castShadow>
      <boxGeometry args={[5.6, .45, 1.25]} /><meshStandardMaterial color={palette.trim} roughness={.72} />
    </mesh>

    <InstanceBatch name="league-light-towers" items={towers} color="#596268" />
    <InstanceBatch name="league-light-panels" items={lamps} color="#f2e8bd" emissive={palette.accent} />
    <mesh name="league-scoreboard" position={[0, 3.7, -7.2]} castShadow>
      <boxGeometry args={[4.8, 2, .35]} /><meshStandardMaterial color="#202d35" metalness={.18} roughness={.48} />
    </mesh>
    <mesh position={[0, 3.7, -7.39]}>
      <planeGeometry args={[4.15, 1.35]} /><meshBasicMaterial color={palette.accent} />
    </mesh>
  </group>;
}
