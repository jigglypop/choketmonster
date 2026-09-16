import { Html } from '@react-three/drei';
import { RigidBody } from '@react-three/rapier';
import { useEffect, useMemo } from 'react';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Matrix4, MeshStandardMaterial, Vector3, type Camera, type Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAVE_SCENES, caveContains, getCaveScene, type CaveScene } from './caves';
import { useSurfaceTextures } from './materials';
import type { WorldPoint, WorldSample } from './types';
import { caveVertexHeight } from './cave-relief';
import { CaveDetails } from './cave-details';
import type { KantoGate, KantoGym, KantoLocation } from './kanto';
import { LeagueStadium } from './league-stadium';

const CAVE_TEXTURE_TILE = 2.5;
const portalProjection = new Vector3();

export function gateVisualState(requiredBadges: number, badges: number) {
  const required = Math.max(0, Math.floor(requiredBadges));
  const earned = Math.max(0, Math.floor(badges));
  return { locked: earned < required, required, earned: Math.min(earned, required) };
}

export function gymVisualState(gym: KantoGym, badges: number) {
  const earned = Math.max(0, Math.floor(badges));
  return { status: earned >= gym.badge ? 'cleared' as const : gym.badge === earned + 1 ? 'available' as const : 'locked' as const,
    recommendedLevel: gym.level, requiredPreviousBadges: gym.badge - 1 };
}

export function GymEntranceStatus({ gym, badges, showLabel }: { gym: KantoGym; badges: number; showLabel: boolean }) {
  const state = gymVisualState(gym, badges), locked = state.status === 'locked';
  return <group name={`gym-entrance:${gym.locationId}:${state.status}`} position={[0, 0, -1.35]}>
    <mesh position={[0, 1.35, -.04]}><boxGeometry args={[2.35, .34, .14]} /><meshStandardMaterial color={state.status === 'cleared' ? '#4c9465' : locked ? '#984b43' : '#d2a643'} roughness={.82} /></mesh>
    {locked && [-.62, 0, .62].map((x, index) => <mesh key={index} position={[x, .68, -.12]} rotation={[0, 0, index === 1 ? 0 : x < 0 ? -.18 : .18]}>
      <boxGeometry args={[.12, 1.22, .12]} /><meshStandardMaterial color="#a5624e" roughness={.82} /></mesh>
    )}
    {showLabel && <Html center position={[0, 1.85, 0]} zIndexRange={[9, 8]} style={{ pointerEvents: 'none' }}>
      <div className="world-portal-label"><strong>{locked ? `앞 체육관 ${state.requiredPreviousBadges}곳 필요` : state.status === 'cleared' ? '클리어' : '도전 가능'} · 권장 Lv.{state.recommendedLevel}</strong></div>
    </Html>}
  </group>;
}

export function ProgressGate({ gate, from, to, y, halfWidth, badges, showLabel }: {
  gate: KantoGate; from: KantoLocation; to: KantoLocation; y: number; halfWidth: number; badges: number; showLabel: boolean;
}) {
  const x = (from.x + to.x) / 2, z = (from.z + to.z) / 2;
  const rotationY = Math.atan2(to.x - from.x, to.z - from.z);
  const state = gateVisualState(gate.requiredBadges, badges);
  const width = Math.max(2.4, halfWidth * 2);
  return <group name={`progress-gate:${gate.id}:${state.locked ? 'locked' : 'open'}`} position={[x, y, z]} rotation={[0, rotationY, 0]}>
    {[-halfWidth, halfWidth].map(side => <group key={side} position={[side, 0, 0]}>
      <mesh position={[0, 1.45, 0]} castShadow><cylinderGeometry args={[.38, .52, 2.9, 8]} /><meshStandardMaterial color="#665640" roughness={.92} /></mesh>
      <mesh position={[0, 3.05, 0]} castShadow><dodecahedronGeometry args={[.58, 0]} /><meshStandardMaterial color="#d8bd62" roughness={.7} /></mesh>
    </group>)}
    <mesh position={[0, 2.8, 0]} castShadow><boxGeometry args={[width + .55, .38, .42]} /><meshStandardMaterial color="#705b3d" roughness={.9} /></mesh>
    {Array.from({ length: state.required }, (_, index) => {
      const offset = state.required <= 1 ? 0 : (index / (state.required - 1) - .5) * Math.min(width - 1, 6.4);
      return <mesh key={index} position={[offset, 2.8, -.24]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[.16, .16, .08, 12]} />
        <meshStandardMaterial color={index < state.earned ? '#f4d65c' : '#4a4036'} emissive={index < state.earned ? '#5b4608' : '#000000'} emissiveIntensity={.35} />
      </mesh>;
    })}
    {state.locked && <>
      <RigidBody type="fixed" colliders="cuboid" position={[0, .82, 0]}>
        <mesh castShadow><boxGeometry args={[width, 1.35, .32]} /><meshStandardMaterial color="#944137" roughness={.88} /></mesh>
      </RigidBody>
      {[-.33, 0, .33].map((ratio, index) => <mesh key={index} position={[ratio * width, .82, -.2]} rotation={[0, 0, index % 2 ? -.22 : .22]} castShadow>
        <boxGeometry args={[.13, 1.7, .14]} /><meshStandardMaterial color="#d8b353" metalness={.2} roughness={.62} />
      </mesh>)}
    </>}
    {showLabel && <Html center position={[0, 3.65, 0]} zIndexRange={[10, 9]} style={{ pointerEvents: 'none' }}>
      <div className="world-portal-label"><strong>{state.locked ? `배지 ${state.required}개 필요` : '관문 통과 가능'}</strong></div>
    </Html>}
  </group>;
}

export const LEAGUE_LOCATION_IDS: Readonly<Partial<Record<string, string>>> = Object.freeze({
  johto: 'tohjo-falls', kanto: 'indigo-plateau', hoenn: 'ever-grande-city',
  sinnoh: 'sinnoh-pokemon-league', unova: 'unova-pokemon-league',
  kalos: 'kalos-pokemon-league', alola: 'alola-pokemon-league',
  galar: 'galar-pokemon-league', hisui: 'temple-of-sinnoh', paldea: 'paldea-pokemon-league',
});

export function isRegionalLeagueLocation(region: string, locationId: string): boolean {
  return LEAGUE_LOCATION_IDS[region] === locationId;
}

export function RegionalLeagueLandmark({ region, x, y, z }: WorldPoint & { region: string; y: number }) {
  return <group name={`landmark:league:${region}`} position={[x, y, z]}>
    <LeagueStadium region={region} />
  </group>;
}

export function IndigoLeagueLandmark(props: WorldPoint & { y: number }) {
  return <RegionalLeagueLandmark {...props} region="kanto" />;
}
function portalScreenPosition(object: Object3D, camera: Camera, size: { width: number; height: number }): [number, number] {
  portalProjection.setFromMatrixPosition(object.matrixWorld).project(camera);
  // An initial camera-plane projection can be NaN. Do not let Html cache it:
  // NaN deltas would otherwise prevent updates until the camera moves.
  if (!Number.isFinite(portalProjection.x) || !Number.isFinite(portalProjection.y)) return [-1000, -1000];
  return [(portalProjection.x + 1) * size.width / 2, (1 - portalProjection.y) * size.height / 2];
}

function tileUvs(geometry: BoxGeometry) {
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

function createCaveFloor(cave: CaveScene): BufferGeometry {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const vertices = new Map<string, number>();
  const vertex = (x: number, z: number) => {
    const key = `${x}:${z}`, existing = vertices.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    positions.push(x, caveVertexHeight(cave.relief, x, z), z);
    uvs.push(x / CAVE_TEXTURE_TILE, z / CAVE_TEXTURE_TILE);
    vertices.set(key, index);
    return index;
  };
  for (let z = Math.floor(-cave.depth / 2); z < Math.ceil(cave.depth / 2); z++) {
    for (let x = Math.floor(-cave.width / 2); x < Math.ceil(cave.width / 2); x++) {
      if (!caveContains(cave.outline, x + .5, z + .5)) continue;
      const a = vertex(x, z), b = vertex(x, z + 1), c = vertex(x + 1, z + 1), d = vertex(x + 1, z);
      indices.push(a, b, d, b, c, d);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

function createCaveWalls(cave: CaveScene): BufferGeometry {
  const parts = cave.wallSegments.map(wall => {
    const geometry = tileUvs(new BoxGeometry(wall.width, wall.height + 2, wall.depth, Math.max(1, Math.ceil(wall.width / 2)), 2, 1));
    const positions = geometry.attributes.position;
    for (let index = 0; index < positions.count; index++) {
      const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
      if (y > 0) positions.setY(index, y + .45 * Math.sin((x + wall.x) * .6 + (z + wall.z) * .4 + cave.relief.seed));
    }
    geometry.computeVertexNormals();
    const transform = new Matrix4().makeRotationY(wall.rotationY).setPosition(wall.x, wall.height / 2, wall.z);
    return geometry.applyMatrix4(transform);
  });
  const merged = mergeGeometries(parts, false);
  parts.forEach(part => part.dispose());
  if (!merged) throw new Error(`Could not merge cave walls: ${cave.id}`);
  return merged;
}

export function CaveInterior({ cave, player, mobile, onNavigate }: { cave: CaveScene; player: WorldPoint; mobile: boolean; onNavigate(point: WorldPoint): void }) {
  const textures = useSurfaceTextures('rock');
  const material = useMemo(() => {
    const result = new MeshStandardMaterial({
      name: 'cave-rock-pbr', color: cave.id === 'ice-path' ? '#a8c5ca' : '#8a8d82', roughness: .95, metalness: 0,
      map: textures.diffuse, normalMap: textures.normal, roughnessMap: textures.arm, aoMap: textures.arm,
    });
    result.userData.openWorldSurface = 'cave-rock-uv';
    return result;
  }, [cave.id, textures]);
  const floor = useMemo(() => createCaveFloor(cave), [cave]);
  const walls = useMemo(() => createCaveWalls(cave), [cave]);
  useEffect(() => () => { material.dispose(); floor.dispose(); walls.dispose(); }, [floor, material, walls]);
  return <group name={`cave-interior:${cave.id}`} dispose={null}>
    <mesh name="cave-floor" geometry={floor} material={material} receiveShadow onClick={event => { event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate({ x: event.point.x, z: event.point.z }); }}>
    </mesh>
    <mesh name="cave-wall:outline" geometry={walls} material={material} receiveShadow castShadow />
    <CaveDetails cave={cave} material={material} player={player} mobile={mobile} onNavigate={onNavigate} />
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
      {distance <= 14 && <Html center calculatePosition={portalScreenPosition} position={[0, 2.8, 0]} zIndexRange={[12, 11]} style={{ pointerEvents: 'auto' }}>
        <button className="world-portal-label" data-portal={entry.id} onClick={interact}><strong>{entry.name}</strong><span>{entry.action}{distance > 4 ? ` · ${Math.round(distance)}m` : ''}</span></button>
      </Html>}
    </group>;
  })}</group>;
}
