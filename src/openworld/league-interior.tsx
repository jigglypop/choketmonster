import { Html } from '@react-three/drei';
import { useEffect, useMemo, useState } from 'react';
import { AnimationMixer, Box3, Color, Group, Mesh, MeshStandardMaterial, type Object3D, Vector3 } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { getSpecies } from '../data/pokemon';
import { hasPokemonModel } from '../data/pokemon-models';
import { selectPokemonMotionClip } from '../data/model-motion';
import { acquireModel } from '../three/model-cache';
import type { GymScene } from './gym-scenes';
import type { WorldPoint } from './types';

/** Legendary Pokémon of each region, cast as gold statues along the league gallery. */
const LEAGUE_STATUES: Readonly<Record<string, readonly number[]>> = {
  kanto: [144, 145, 146, 150], johto: [243, 244, 245, 249], hoenn: [380, 381, 382, 383], sinnoh: [480, 481, 483, 484],
  unova: [638, 639, 643, 644], kalos: [716, 717, 718, 719], alola: [785, 786, 791, 792], galar: [888, 889, 890, 894],
  hisui: [483, 484, 487, 493], paldea: [1007, 1008, 1001, 1002],
};
const REGION_BANNERS: Readonly<Record<string, string>> = {
  kanto: '#a8322d', johto: '#2f4f9a', hoenn: '#2a7f73', sinnoh: '#4d5fa8', unova: '#3a3a4a',
  kalos: '#274b86', alola: '#c8573b', galar: '#6b2a7a', hisui: '#3a5a4a', paldea: '#b0412f',
};

const WALL_HEIGHT = 9, FRONT_HEIGHT = 1.1, WALL_THICKNESS = .8, DOOR_WIDTH = 5.2;

function useLeagueMaterials(banner: string) {
  const materials = useMemo(() => ({
    marble: new MeshStandardMaterial({ name: 'league-marble', color: '#f2ece0', roughness: .28, metalness: 0 }),
    darkMarble: new MeshStandardMaterial({ name: 'league-dark-marble', color: '#3b3346', roughness: .3, metalness: 0 }),
    gold: new MeshStandardMaterial({ name: 'league-gold', color: '#e0b247', roughness: .3, metalness: .6, envMapIntensity: 1.3 }),
    paleGold: new MeshStandardMaterial({ name: 'league-pale-gold', color: '#f1d98d', roughness: .38, metalness: .45, envMapIntensity: 1.1 }),
    carpet: new MeshStandardMaterial({ name: 'league-carpet', color: '#8e1f2c', roughness: .92 }),
    wall: new MeshStandardMaterial({ name: 'league-wall', color: '#efe4cc', roughness: .7 }),
    banner: new MeshStandardMaterial({ name: 'league-banner', color: new Color(banner), roughness: .8 }),
    court: new MeshStandardMaterial({ name: 'league-court', color: '#d9cfb6', roughness: .35 }),
    flame: new MeshStandardMaterial({ name: 'league-flame', color: '#ffcf6b', emissive: '#ff9a2e', emissiveIntensity: .9, roughness: 1 }),
    statue: new MeshStandardMaterial({ name: 'league-statue-gold', color: '#d9a93c', roughness: .26, metalness: .7, envMapIntensity: 1.5 }),
  }), [banner]);
  useEffect(() => () => Object.values(materials).forEach(material => material.dispose()), [materials]);
  return materials;
}

/** A Pokémon model cast in gold, posed at its idle frame and sized to `height`. */
function PokemonStatue({ speciesId, url, height, material }: { speciesId: number; url: string; height: number; material: MeshStandardMaterial }) {
  const [statue, setStatue] = useState<Object3D | null>(null);
  useEffect(() => {
    let active = true;
    const lease = acquireModel(url);
    lease.promise.then(gltf => {
      if (!active) return;
      const model = cloneSkinned(gltf.scene);
      const idle = selectPokemonMotionClip(gltf.animations, 'idle').clip;
      if (idle) { const mixer = new AnimationMixer(model); mixer.clipAction(idle).play(); mixer.update(0); mixer.stopAllAction(); }
      model.traverse(object => { if (object instanceof Mesh) { object.material = material; object.castShadow = true; object.receiveShadow = true; object.frustumCulled = false; } });
      model.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(model, true), size = bounds.getSize(new Vector3()), center = bounds.getCenter(new Vector3());
      const scale = height / Math.max(size.y, size.x * .8, size.z * .8, .001);
      const holder = new Group(); holder.name = `league-statue:${speciesId}`;
      model.position.set(-center.x, -bounds.min.y, -center.z);
      holder.add(model); holder.scale.setScalar(scale);
      setStatue(holder);
    }, () => undefined);
    return () => { active = false; lease.release(); };
  }, [height, material, speciesId, url]);
  return statue ? <primitive object={statue} dispose={null} /> : null;
}

function Pedestal({ material, trim }: { material: MeshStandardMaterial; trim: MeshStandardMaterial }) {
  return <group>
    <mesh position={[0, .15, 0]} material={trim} castShadow receiveShadow><boxGeometry args={[3.1, .3, 3.1]} /></mesh>
    <mesh position={[0, .95, 0]} material={material} castShadow receiveShadow><boxGeometry args={[2.6, 1.3, 2.6]} /></mesh>
    <mesh position={[0, 1.66, 0]} material={trim} castShadow receiveShadow><boxGeometry args={[2.9, .14, 2.9]} /></mesh>
  </group>;
}

function Column({ materials }: { materials: ReturnType<typeof useLeagueMaterials> }) {
  return <group>
    <mesh position={[0, .25, 0]} material={materials.gold} castShadow receiveShadow><cylinderGeometry args={[.78, .86, .5, 20]} /></mesh>
    <mesh position={[0, 3.9, 0]} material={materials.marble} castShadow receiveShadow><cylinderGeometry args={[.52, .58, 6.8, 16]} /></mesh>
    {Array.from({ length: 8 }, (_, index) => <mesh key={index} position={[Math.cos(index / 8 * Math.PI * 2) * .56, 3.9, Math.sin(index / 8 * Math.PI * 2) * .56]} material={materials.paleGold} receiveShadow>
      <boxGeometry args={[.07, 6.6, .07]} />
    </mesh>)}
    <mesh position={[0, 7.5, 0]} material={materials.gold} castShadow receiveShadow><cylinderGeometry args={[.9, .6, .6, 20]} /></mesh>
    <mesh position={[0, 7.95, 0]} material={materials.gold} castShadow receiveShadow><boxGeometry args={[1.9, .3, 1.9]} /></mesh>
  </group>;
}

function Brazier({ materials }: { materials: ReturnType<typeof useLeagueMaterials> }) {
  return <group>
    <mesh position={[0, .8, 0]} material={materials.gold} castShadow receiveShadow><cylinderGeometry args={[.14, .3, 1.6, 12]} /></mesh>
    <mesh position={[0, 1.7, 0]} material={materials.gold} castShadow receiveShadow><cylinderGeometry args={[.62, .3, .45, 18]} /></mesh>
    <mesh position={[0, 2.12, 0]} material={materials.flame}><coneGeometry args={[.4, .9, 12]} /></mesh>
    <pointLight position={[0, 2.6, 0]} color="#ffc27a" intensity={7} distance={9} decay={2} />
  </group>;
}

/** The league's hall: a gold-trimmed marble gallery of statues leading to a ringed arena and the champion's dais. */
export function LeagueInterior({ hall, trainer, busy, player, spriteUrl, modelUrl, onNavigate, onExit, onChallenge }: {
  hall: GymScene; trainer?: { name: string; team: ReadonlyArray<readonly [number, number]> }; busy: boolean; player: WorldPoint;
  spriteUrl?: (speciesId: number) => string; modelUrl?: (speciesId: number) => string; onNavigate(point: WorldPoint): void; onExit(): void; onChallenge(): void;
}) {
  const materials = useLeagueMaterials(REGION_BANNERS[hall.regionId] ?? REGION_BANNERS.kanto);
  const width = hall.maxX - hall.minX, depth = hall.maxZ - hall.minZ;
  const cx = (hall.minX + hall.maxX) / 2, cz = (hall.minZ + hall.maxZ) / 2, y = hall.floorY;
  const courtZ = (hall.court.minZ + hall.court.maxZ) / 2, courtDepth = hall.court.maxZ - hall.court.minZ, courtWidth = hall.court.maxX - hall.court.minX;
  const courtRadius = Math.min(courtWidth, courtDepth) / 2;
  const sideWall = (width - DOOR_WIDTH) / 2;
  const exitDistance = Math.hypot(player.x - hall.exit.x, player.z - hall.exit.z);
  const statues = (LEAGUE_STATUES[hall.regionId] ?? LEAGUE_STATUES.kanto).filter(id => hasPokemonModel(id)).slice(0, 4);
  const galleryStart = hall.minZ + 7, galleryEnd = hall.challenger.z - 2.5;
  const statueSpots = statues.map((speciesId, index) => ({ speciesId, x: cx + (index % 2 ? 1 : -1) * (width / 2 - 4.2), z: galleryStart + Math.floor(index / 2) * Math.max(6, (galleryEnd - galleryStart) / 2) }));
  const columns = [-1, 1].flatMap(side => [.12, .36, .6, .84].map(t => ({ x: cx + side * (width / 2 - 1.5), z: hall.minZ + depth * t })));
  const braziers = [-1, 1].flatMap(side => [hall.court.minZ, hall.court.maxZ].map(z => ({ x: cx + side * (courtRadius + 2.2), z })));
  const navigate = (event: { stopPropagation(): void; button: number; delta: number; point: { x: number; z: number } }) => {
    event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate({ x: event.point.x, z: event.point.z });
  };

  return <group name={`league-interior:${hall.locationId}`} dispose={null}>
    {/* Warm accents over the arena and gallery; the angled indoor key light casts the shadows, so these stay soft. */}
    <pointLight position={[cx, y + 7, courtZ]} color="#fff0cf" intensity={30} distance={30} decay={2} />
    <pointLight position={[cx, y + 6, galleryStart + 4]} color="#ffe6b8" intensity={20} distance={24} decay={2} />

    {/* Marble floor with gold inlay and a carpet running from the door to the arena. */}
    <mesh name="league-floor" position={[cx, y - .05, cz]} material={materials.marble} receiveShadow onClick={navigate}><boxGeometry args={[width, .1, depth]} /></mesh>
    {[-1, 1].map(side => <mesh key={`inlay:${side}`} position={[cx + side * 3.4, y + .004, cz]} rotation={[-Math.PI / 2, 0, 0]} material={materials.gold} receiveShadow><planeGeometry args={[.18, depth - 2]} /></mesh>)}
    <mesh name="league-carpet" position={[cx, y + .01, (hall.minZ + hall.court.minZ) / 2]} rotation={[-Math.PI / 2, 0, 0]} material={materials.carpet} receiveShadow onClick={navigate}>
      <planeGeometry args={[4.2, hall.court.minZ - hall.minZ]} />
    </mesh>
    {[-1, 1].map(side => <mesh key={`carpet-trim:${side}`} position={[cx + side * 2.2, y + .014, (hall.minZ + hall.court.minZ) / 2]} rotation={[-Math.PI / 2, 0, 0]} material={materials.gold} receiveShadow>
      <planeGeometry args={[.22, hall.court.minZ - hall.minZ]} />
    </mesh>)}

    {/* Ringed arena with a gold Poké Ball emblem. */}
    <mesh name="league-court" position={[cx, y + .012, courtZ]} rotation={[-Math.PI / 2, 0, 0]} material={materials.court} receiveShadow onClick={navigate}><circleGeometry args={[courtRadius, 64]} /></mesh>
    <mesh position={[cx, y + .018, courtZ]} rotation={[-Math.PI / 2, 0, 0]} material={materials.gold} receiveShadow><ringGeometry args={[courtRadius - .35, courtRadius, 64]} /></mesh>
    <mesh position={[cx, y + .018, courtZ]} rotation={[-Math.PI / 2, 0, 0]} material={materials.gold} receiveShadow><ringGeometry args={[courtRadius * .55 - .12, courtRadius * .55, 48]} /></mesh>
    <mesh position={[cx, y + .02, courtZ]} rotation={[-Math.PI / 2, 0, 0]} material={materials.darkMarble} receiveShadow><ringGeometry args={[.9, 1.6, 40]} /></mesh>
    <mesh position={[cx, y + .02, courtZ]} rotation={[-Math.PI / 2, 0, 0]} material={materials.gold} receiveShadow><circleGeometry args={[.9, 32]} /></mesh>
    <mesh position={[cx, y + .022, courtZ]} rotation={[-Math.PI / 2, 0, 0]} material={materials.darkMarble} receiveShadow><planeGeometry args={[courtRadius * 2 - .7, .22]} /></mesh>

    {/* Walls: tall gold-banded sides and back; the front stays low so the camera sees in. */}
    <mesh position={[cx, y + WALL_HEIGHT / 2, hall.maxZ]} material={materials.wall} receiveShadow><boxGeometry args={[width + WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS]} /></mesh>
    {[-1, 1].map(side => <mesh key={`side:${side}`} position={[cx + side * width / 2, y + WALL_HEIGHT / 2, cz]} material={materials.wall} receiveShadow><boxGeometry args={[WALL_THICKNESS, WALL_HEIGHT, depth]} /></mesh>)}
    {[-1, 1].map(side => <group key={`band:${side}`}>
      <mesh position={[cx + side * (width / 2 - WALL_THICKNESS / 2 - .03), y + 1.2, cz]} material={materials.gold} receiveShadow><boxGeometry args={[.08, .35, depth - 1]} /></mesh>
      <mesh position={[cx + side * (width / 2 - WALL_THICKNESS / 2 - .03), y + WALL_HEIGHT - .6, cz]} material={materials.gold} receiveShadow><boxGeometry args={[.12, .5, depth - 1]} /></mesh>
    </group>)}
    <mesh position={[cx, y + WALL_HEIGHT - .6, hall.maxZ - WALL_THICKNESS / 2 - .03]} material={materials.gold} receiveShadow><boxGeometry args={[width - 1, .5, .12]} /></mesh>
    {[-1, 1].map(side => <group key={`front:${side}`} position={[cx + side * (DOOR_WIDTH / 2 + sideWall / 2), y, hall.minZ]}>
      <mesh position={[0, FRONT_HEIGHT / 2, 0]} material={materials.wall} castShadow receiveShadow><boxGeometry args={[sideWall, FRONT_HEIGHT, WALL_THICKNESS]} /></mesh>
      <mesh position={[0, FRONT_HEIGHT + .08, 0]} material={materials.gold} castShadow receiveShadow><boxGeometry args={[sideWall, .16, WALL_THICKNESS + .08]} /></mesh>
    </group>)}
    {[-1, 1].map(side => <group key={`door:${side}`} position={[cx + side * (DOOR_WIDTH / 2 + .35), y, hall.minZ]}>
      <mesh position={[0, 2.2, 0]} material={materials.marble} castShadow receiveShadow><boxGeometry args={[.7, 4.4, WALL_THICKNESS + .2]} /></mesh>
      <mesh position={[0, 4.55, 0]} material={materials.gold} castShadow receiveShadow><boxGeometry args={[.9, .3, WALL_THICKNESS + .3]} /></mesh>
    </group>)}

    {columns.map((column, index) => <group key={index} position={[column.x, y, column.z]}><Column materials={materials} /></group>)}

    {/* Gallery of gold statues. */}
    {statueSpots.map(spot => <group key={spot.speciesId} position={[spot.x, y, spot.z]} rotation={[0, spot.x < cx ? Math.PI / 2 : -Math.PI / 2, 0]}>
      <Pedestal material={materials.darkMarble} trim={materials.gold} />
      {modelUrl && <group position={[0, 1.73, 0]}><PokemonStatue speciesId={spot.speciesId} url={modelUrl(spot.speciesId)} height={3.4} material={materials.statue} /></group>}
    </group>)}

    {braziers.map((brazier, index) => <group key={index} position={[brazier.x, y, brazier.z]}><Brazier materials={materials} /></group>)}

    {/* Stepped dais under a gold arch, with regional banners. */}
    <group position={[cx, y, hall.leader.z]}>
      <mesh position={[0, .18, .6]} material={materials.darkMarble} receiveShadow castShadow><boxGeometry args={[10, .36, 5.4]} /></mesh>
      <mesh position={[0, .46, 1.2]} material={materials.marble} receiveShadow castShadow><boxGeometry args={[7.4, .22, 3.6]} /></mesh>
      <mesh position={[0, .38, -2.15]} material={materials.gold} receiveShadow><boxGeometry args={[10.2, .06, .12]} /></mesh>
      <mesh position={[0, .6, 1.2]} rotation={[0, 0, 0]} material={materials.gold} castShadow receiveShadow><torusGeometry args={[4.2, .22, 10, 40, Math.PI]} /></mesh>
      {[-1, 1].map(side => <mesh key={side} position={[side * 4.2, .6, 1.2]} material={materials.gold} castShadow><cylinderGeometry args={[.28, .32, 1.2, 12]} /></mesh>)}
      {trainer && !busy && <Html center position={[0, 5.4, -1]} zIndexRange={[12, 11]} style={{ pointerEvents: 'auto' }}>
        <button className="world-portal-label gym-leader-label league-leader-label" data-league-trainer={hall.locationId} data-gym-state="available" onClick={onChallenge}>
          <strong>{trainer.name}</strong>
          <ol className="gym-leader-party" aria-label={`${trainer.name} 포켓몬`}>
            {trainer.team.map(([speciesId, level], index) => <li key={index}>
              {spriteUrl && <img src={spriteUrl(speciesId)} alt="" />}
              <small>{getSpecies(speciesId).name}</small><b>Lv.{level}</b>
            </li>)}
          </ol>
        </button>
      </Html>}
    </group>
    {[-1, 0, 1].map(offset => <mesh key={offset} position={[cx + offset * 5.2, y + 4.6, hall.maxZ - WALL_THICKNESS / 2 - .05]} material={offset ? materials.banner : materials.gold} receiveShadow>
      <planeGeometry args={[offset ? 2 : 2.8, offset ? 5.4 : 6.2]} />
    </mesh>)}

    {/* Exit mat just inside the door. */}
    <group position={[hall.exit.x, y, hall.exit.z]}>
      <mesh position={[0, .03, 0]} rotation={[-Math.PI / 2, 0, 0]} material={materials.carpet} receiveShadow onClick={event => { event.stopPropagation(); if (exitDistance <= 2.4) onExit(); else onNavigate(hall.exit); }}>
        <planeGeometry args={[DOOR_WIDTH - .6, 1.6]} />
      </mesh>
    </group>
  </group>;
}
