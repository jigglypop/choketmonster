import { Html } from '@react-three/drei';
import { useEffect, useMemo } from 'react';
import { Color, MeshStandardMaterial } from 'three';
import { getSpecies } from '../data/pokemon';
import type { GymScene } from './gym-scenes';
import { gymVisualState } from './scene-landmarks';
import type { KantoGym } from './kanto';
import type { WorldPoint } from './types';
import { TYPE_COLORS } from './type-colors';

const DOOR_WIDTH = 4.2, WALL_HEIGHT = 6.4, FRONT_HEIGHT = 1.1, WALL_THICKNESS = .7;

/** Indoor hall for a gym: a marked court, the leader's dais and an exit mat by the door. */
export function GymInterior({ hall, gym, party, badges, busy, player, spriteUrl, onNavigate, onExit, onChallenge }: {
  hall: GymScene; gym?: KantoGym; party: ReadonlyArray<readonly [number, number]>; badges: number; busy: boolean; player: WorldPoint;
  spriteUrl?: (speciesId: number) => string; onNavigate(point: WorldPoint): void; onExit(): void; onChallenge(): void;
}) {
  const state = gym ? gymVisualState(gym, badges) : undefined;
  const theme = TYPE_COLORS[gym ? getSpecies(gym.speciesId).types[0] : 'normal'] ?? TYPE_COLORS.normal;
  const materials = useMemo(() => {
    const accent = new Color(theme);
    return {
      floor: new MeshStandardMaterial({ name: 'gym-floor', color: '#ebe6d9', roughness: .42, metalness: .04 }),
      court: new MeshStandardMaterial({ name: 'gym-court', color: accent.clone().lerp(new Color('#ffffff'), .55), roughness: .5 }),
      line: new MeshStandardMaterial({ name: 'gym-line', color: '#fdfbf4', roughness: .4, emissive: '#ffffff', emissiveIntensity: .12 }),
      wall: new MeshStandardMaterial({ name: 'gym-wall', color: '#f1ece0', roughness: .86 }),
      stripe: new MeshStandardMaterial({ name: 'gym-stripe', color: accent, roughness: .6 }),
      dais: new MeshStandardMaterial({ name: 'gym-dais', color: accent.clone().multiplyScalar(.72), roughness: .55 }),
      pillar: new MeshStandardMaterial({ name: 'gym-pillar', color: '#d9d2c1', roughness: .7 }),
      lamp: new MeshStandardMaterial({ name: 'gym-lamp', color: '#fff6d8', emissive: '#ffe7a3', emissiveIntensity: 1.4 }),
    };
  }, [theme]);
  useEffect(() => () => Object.values(materials).forEach(material => material.dispose()), [materials]);

  const width = hall.maxX - hall.minX, depth = hall.maxZ - hall.minZ;
  const cx = (hall.minX + hall.maxX) / 2, cz = (hall.minZ + hall.maxZ) / 2, y = hall.floorY;
  const courtZ = (hall.court.minZ + hall.court.maxZ) / 2, courtDepth = hall.court.maxZ - hall.court.minZ, courtWidth = hall.court.maxX - hall.court.minX;
  const sideWall = (width - DOOR_WIDTH) / 2;
  const exitDistance = Math.hypot(player.x - hall.exit.x, player.z - hall.exit.z);
  const pillars = [-1, 1].flatMap(side => [.24, .5, .76].map(t => ({ x: cx + side * (width / 2 - 1.3), z: hall.minZ + depth * t })));
  const navigate = (event: { stopPropagation(): void; button: number; delta: number; point: { x: number; z: number } }) => {
    event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate({ x: event.point.x, z: event.point.z });
  };

  return <group name={`gym-interior:${hall.locationId}`} dispose={null}>
    <pointLight position={[cx, y + 5.4, courtZ - courtDepth / 4]} color="#fff4dc" intensity={60} distance={30} decay={1.4} />
    <pointLight position={[cx, y + 5.4, courtZ + courtDepth / 3]} color="#fff4dc" intensity={60} distance={30} decay={1.4} />
    <mesh name="gym-floor" position={[cx, y - .05, cz]} material={materials.floor} receiveShadow onClick={navigate}>
      <boxGeometry args={[width, .1, depth]} />
    </mesh>
    <mesh name="gym-court" position={[cx, y + .006, courtZ]} rotation={[-Math.PI / 2, 0, 0]} material={materials.court} receiveShadow onClick={navigate}>
      <planeGeometry args={[courtWidth, courtDepth]} />
    </mesh>
    {[[0, -courtDepth / 2, courtWidth, .16], [0, courtDepth / 2, courtWidth, .16], [0, 0, courtWidth, .12], [-courtWidth / 2, 0, .16, courtDepth], [courtWidth / 2, 0, .16, courtDepth]].map(([x, z, w, d], index) =>
      <mesh key={index} position={[cx + x, y + .012, courtZ + z]} rotation={[-Math.PI / 2, 0, 0]} material={materials.line}><planeGeometry args={[w, d]} /></mesh>)}
    <mesh position={[cx, y + .014, courtZ]} rotation={[-Math.PI / 2, 0, 0]} material={materials.line}><ringGeometry args={[2.3, 2.46, 48]} /></mesh>
    <mesh position={[cx, y + .014, courtZ]} rotation={[-Math.PI / 2, 0, 0]} material={materials.line}><circleGeometry args={[.42, 24]} /></mesh>

    {/* Walls with an opening at the entrance. The front stays low so the camera behind the player sees in. */}
    <mesh position={[cx, y + WALL_HEIGHT / 2, hall.maxZ]} material={materials.wall} receiveShadow><boxGeometry args={[width + WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS]} /></mesh>
    {[-1, 1].map(side => <mesh key={`side:${side}`} position={[cx + side * width / 2, y + WALL_HEIGHT / 2, cz]} material={materials.wall} receiveShadow><boxGeometry args={[WALL_THICKNESS, WALL_HEIGHT, depth]} /></mesh>)}
    {[-1, 1].map(side => <group key={`front:${side}`} position={[cx + side * (DOOR_WIDTH / 2 + sideWall / 2), y, hall.minZ]}>
      <mesh position={[0, FRONT_HEIGHT / 2, 0]} material={materials.wall} receiveShadow><boxGeometry args={[sideWall, FRONT_HEIGHT, WALL_THICKNESS]} /></mesh>
      <mesh position={[0, FRONT_HEIGHT + .06, 0]} material={materials.stripe}><boxGeometry args={[sideWall, .12, WALL_THICKNESS + .06]} /></mesh>
    </group>)}
    {[-1, 1].map(side => <mesh key={`door:${side}`} position={[cx + side * (DOOR_WIDTH / 2 + .25), y + 1.6, hall.minZ]} material={materials.pillar} castShadow><boxGeometry args={[.5, 3.2, WALL_THICKNESS + .1]} /></mesh>)}
    {[-1, 1].map(side => <mesh key={`stripe:${side}`} position={[cx + side * (width / 2 - WALL_THICKNESS / 2 - .02), y + 1.1, cz]} material={materials.stripe}><boxGeometry args={[.06, .5, depth - 1]} /></mesh>)}
    <mesh position={[cx, y + 1.1, hall.maxZ - WALL_THICKNESS / 2 - .02]} material={materials.stripe}><boxGeometry args={[width - 1, .5, .06]} /></mesh>

    {pillars.map((pillar, index) => <group key={index} position={[pillar.x, y, pillar.z]}>
      <mesh position={[0, 2.2, 0]} material={materials.pillar} castShadow><cylinderGeometry args={[.42, .5, 4.4, 12]} /></mesh>
      <mesh position={[0, 4.65, 0]} material={materials.lamp}><sphereGeometry args={[.36, 16, 12]} /></mesh>
    </group>)}

    {/* Leader dais and banners on the back wall. */}
    <group position={[cx, y, hall.leader.z]}>
      <mesh position={[0, .2, .4]} material={materials.dais} receiveShadow castShadow><boxGeometry args={[7, .4, 4.6]} /></mesh>
      <mesh position={[0, .1, -2.25]} material={materials.dais} receiveShadow><boxGeometry args={[3.2, .2, .9]} /></mesh>
      {gym && state && !busy && <Html center position={[0, 4.2, -1]} zIndexRange={[12, 11]} style={{ pointerEvents: 'auto' }}>
        <button className="world-portal-label gym-leader-label" data-gym-leader={hall.locationId} data-gym-state={state.status} disabled={state.status !== 'available'} onClick={onChallenge}>
          <strong>{gym.name}</strong>
          <span>{state.status === 'available' ? `도전 · 권장 Lv.${state.recommendedLevel}` : state.status === 'cleared' ? '클리어' : `앞 체육관 ${state.requiredPreviousBadges}곳 필요`}</span>
          <ol className="gym-leader-party" aria-label={`${gym.name} 포켓몬`}>
            {party.map(([speciesId, level], index) => <li key={index}>
              {spriteUrl && <img src={spriteUrl(speciesId)} alt="" />}
              <small>{getSpecies(speciesId).name}</small><b>Lv.{level}</b>
            </li>)}
          </ol>
        </button>
      </Html>}
    </group>
    {[-1, 0, 1].map(offset => <mesh key={offset} position={[cx + offset * 4.2, y + 3.6, hall.maxZ - WALL_THICKNESS / 2 - .04]} material={offset ? materials.stripe : materials.dais}>
      <planeGeometry args={[offset ? 1.6 : 2.4, offset ? 3.6 : 4.4]} />
    </mesh>)}

    {/* Exit mat just inside the door. */}
    <group position={[hall.exit.x, y, hall.exit.z]}>
      <mesh position={[0, .03, 0]} rotation={[-Math.PI / 2, 0, 0]} onClick={event => { event.stopPropagation(); if (exitDistance <= 2.4) onExit(); else onNavigate(hall.exit); }}>
        <planeGeometry args={[DOOR_WIDTH - .6, 1.6]} /><meshStandardMaterial color="#6d8f7c" roughness={.9} />
      </mesh>
    </group>
  </group>;
}
