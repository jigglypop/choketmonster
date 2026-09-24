import { Html } from '@react-three/drei';
import { RigidBody } from '@react-three/rapier';
import { useEffect, useMemo, useState } from 'react';
import { BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, Vector3, type Camera, type Object3D } from 'three';
import { CAVE_SCENES, caveContains, getCaveScene, type CaveScene } from './caves';
import { useSurfaceTextures } from './materials';
import type { WorldPoint, WorldSample } from './types';
import { caveFloorShade, caveVertexHeight } from './cave-relief';
import { CaveDetails } from './cave-details';
import { DungeonStairs } from './dungeon-interior';
import { portalBadges } from './dungeon-gates';
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
  const x = gate.position?.x ?? (from.x + to.x) / 2, z = gate.position?.z ?? (from.z + to.z) / 2;
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
      {gate.terrainBoundary
        ? <mesh position={[0, .82, 0]} castShadow><boxGeometry args={[width, 1.35, .32]} /><meshStandardMaterial color="#c54628" roughness={.88} /></mesh>
        : <RigidBody type="fixed" colliders="cuboid" position={[0, .82, 0]}>
          <mesh castShadow><boxGeometry args={[width, 1.35, .32]} /><meshStandardMaterial color="#c54628" roughness={.88} /></mesh>
        </RigidBody>}
      {[-.33, 0, .33].map((ratio, index) => <mesh key={index} position={[ratio * width, .82, -.2]} rotation={[0, 0, index % 2 ? -.22 : .22]} castShadow>
        <boxGeometry args={[.3, 1.7, .46]} /><meshStandardMaterial color="#ffe375" emissive="#806015" emissiveIntensity={.25} roughness={.62} />
      </mesh>)}
    </>}
    {showLabel && <Html center calculatePosition={gateScreenPosition} position={[0, 3.65, 0]} zIndexRange={[10, 9]} style={{ pointerEvents: 'none' }}>
      <div className={`world-portal-label world-gate-label ${state.locked ? 'locked' : 'open'}`} data-gate-id={gate.id} data-gate-state={state.locked ? 'locked' : 'open'}>
        <strong>{state.locked ? `🔒 통행 잠김 · ${gate.badgeLabel ?? '배지'} ${state.earned}/${state.required}` : '✓ 관문 개방'}</strong>
        {state.locked && <span>{gate.reason}</span>}
      </div>
    </Html>}
  </group>;
}

export { LEAGUE_LOCATION_IDS, isRegionalLeagueLocation } from './gym-scenes';

/** The league stadium. With onEnter it is clickable: the player walks to its entrance and goes in. */
export function RegionalLeagueLandmark({ region, x, y, z, onEnter }: WorldPoint & { region: string; y: number; onEnter?: () => void }) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => { if (!onEnter) setHovered(false); }, [onEnter]);
  useEffect(() => () => { if (hovered) document.body.style.cursor = ''; }, [hovered]);
  const pointer = onEnter ? {
    onPointerOver: (event: { stopPropagation(): void }) => { event.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; },
    onPointerOut: () => { setHovered(false); document.body.style.cursor = ''; },
    onClick: (event: { stopPropagation(): void; delta: number }) => { event.stopPropagation(); if (event.delta <= 5) onEnter(); },
  } : {};
  return <group name={`landmark:league:${region}`} position={[x, y, z]}>
    <group {...pointer}><LeagueStadium region={region} /></group>
    {hovered && <mesh name="league-hover-ring" position={[0, .24, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[1.34, 1, 1]}><ringGeometry args={[8.4, 8.9, 64]} /><meshBasicMaterial color="#ffe27a" transparent opacity={.85} depthWrite={false} /></mesh>}
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

function gateScreenPosition(object: Object3D, camera: Camera, size: { width: number; height: number }): [number, number] {
  const [x, y] = portalScreenPosition(object, camera, size);
  // Nearby locks still need a readable condition when their world anchor falls
  // beyond the edge of a narrow mobile camera. Leave room for the bottom HUD.
  const marginX = Math.min(140, size.width / 2), top = Math.min(180, size.height * .3);
  return [Math.max(marginX, Math.min(size.width - marginX, x)), Math.max(top, Math.min(size.height - 220, y))];
}

function createCaveFloor(cave: CaveScene): BufferGeometry {
  const positions: number[] = [], colors: number[] = [], uvs: number[] = [], indices: number[] = [];
  const vertices = new Map<string, number>();
  const vertex = (x: number, z: number) => {
    const key = `${x}:${z}`, existing = vertices.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    positions.push(x, caveVertexHeight(cave.relief, x, z), z);
    const edge = caveContains(cave.outline, x, z, 4.6) ? 1 : .76;
    const shade = caveFloorShade(cave.relief, x, z) * edge;
    colors.push(shade * .94, shade * .98, shade);
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
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

function createCaveWalls(cave: CaveScene): BufferGeometry {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  let distance = 0;
  cave.wallSegments.forEach((wall, wallIndex) => {
    const tangent = { x: Math.cos(wall.rotationY), z: -Math.sin(wall.rotationY) };
    const normalA = { x: -tangent.z, z: tangent.x }, normalB = { x: tangent.z, z: -tangent.x };
    const inward = normalA.x * -wall.x + normalA.z * -wall.z > normalB.x * -wall.x + normalB.z * -wall.z ? normalA : normalB;
    const ends = [-1, 1], levels = [-.55, 1.05, 2.7, 4.45];
    const base = positions.length / 3;
    for (let level = 0; level < levels.length; level++) for (const end of ends) {
      const vertexIndex = (wallIndex + (end > 0 ? 1 : 0)) % cave.wallSegments.length;
      const wave = Math.sin(vertexIndex * 1.73 + level * 2.11 + cave.relief.seed * .17) * .18;
      const inset = [0, .18, .52, .88][level] + wave;
      const topJitter = level === levels.length - 1 ? .32 * Math.sin(vertexIndex * .91 + cave.relief.seed) : 0;
      positions.push(wall.x + tangent.x * wall.width / 2 * end + inward.x * inset,
        levels[level] + topJitter, wall.z + tangent.z * wall.width / 2 * end + inward.z * inset);
      uvs.push((distance + (end + 1) * wall.width / 2) / CAVE_TEXTURE_TILE, levels[level] / CAVE_TEXTURE_TILE);
    }
    for (let level = 0; level < levels.length - 1; level++) {
      const a = base + level * 2, b = a + 1, d = a + 2, c = a + 3;
      indices.push(a, b, d, b, c, d);
    }
    distance += wall.width;
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

export function CaveInterior({ cave, player, mobile, onNavigate }: { cave: CaveScene; player: WorldPoint; mobile: boolean; onNavigate(point: WorldPoint): void }) {
  const textures = useSurfaceTextures('rock');
  const material = useMemo(() => {
    const tint = { limestone: '#9a9485', water: '#697e78', ice: '#a8c5ca', volcanic: '#756861', interior: '#737b7c' }[cave.relief.theme];
    const result = new MeshStandardMaterial({
      name: 'cave-rock-pbr', color: tint, roughness: cave.relief.theme === 'water' ? .78 : .94, metalness: cave.relief.theme === 'interior' ? .08 : 0,
      map: textures.diffuse, normalMap: textures.normal, roughnessMap: textures.arm, aoMap: textures.arm,
    });
    result.userData.openWorldSurface = 'cave-rock-uv';
    return result;
  }, [cave.relief.theme, textures]);
  const floorMaterial = useMemo(() => {
    const result = material.clone(); result.name = 'cave-floor-pbr'; result.vertexColors = true; return result;
  }, [material]);
  const floor = useMemo(() => createCaveFloor(cave), [cave]);
  const walls = useMemo(() => createCaveWalls(cave), [cave]);
  useEffect(() => () => { floorMaterial.dispose(); material.dispose(); floor.dispose(); walls.dispose(); }, [floor, floorMaterial, material, walls]);
  return <group name={`cave-interior:${cave.id}`} dispose={null}>
    <mesh name="cave-floor" geometry={floor} material={floorMaterial} receiveShadow onClick={event => { event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate({ x: event.point.x, z: event.point.z }); }}>
    </mesh>
    <mesh name="cave-wall:outline" geometry={walls} material={material} receiveShadow castShadow />
    <CaveDetails cave={cave} material={material} player={player} mobile={mobile} onNavigate={onNavigate} />
    <DungeonStairs scene={cave} />
  </group>;
}

export function ScenePortals({ sceneId, regionId, player, badges = 8, sample, onNavigate, onPortal }: {
  sceneId: string; regionId: string; player: WorldPoint; badges?: number; sample(x: number, z: number): WorldSample;
  onNavigate(point: WorldPoint): void; onPortal(): void;
}) {
  const cave = getCaveScene(sceneId);
  // Inside: exits and the stairs to neighbouring floors. Outside: every dungeon entrance of the region.
  const entries = (cave
    ? [...cave.portals.filter(portal => portalBadges(cave, portal) <= badges).map(portal => ({ id: portal.id, point: portal.interior, name: cave.dungeonName, action: '밖으로 나가기', color: '#ffd98e' })),
      ...cave.stairs.map(stairs => ({ id: stairs.id, point: stairs.interior, name: `${stairs.direction === 'up' ? '▲' : '▼'} ${stairs.targetLabel}`, action: '', color: '#c9e7ff' }))]
    : CAVE_SCENES.filter(item => item.regionId === regionId).flatMap(item => item.portals.filter(portal => portalBadges(item, portal) <= badges).map(portal => ({
      id: portal.id, point: portal.surface, name: item.dungeonName, action: item.kind === 'cave' ? '동굴 들어가기' : '들어가기', color: '#94e2e0',
    })))).filter(entry => Math.hypot(entry.point.x - player.x, entry.point.z - player.z) < 36);
  return <group name="scene-portals">{entries.map(entry => {
    const distance = Math.hypot(entry.point.x - player.x, entry.point.z - player.z);
    const interact = () => { if (distance <= (cave ? 1.35 : 3.6)) onPortal(); else onNavigate(entry.point); };
    return <group key={entry.id} position={[entry.point.x, sample(entry.point.x, entry.point.z).height, entry.point.z]}>
      <mesh position={[0, .05, 0]} rotation={[-Math.PI / 2, 0, 0]} onClick={event => { event.stopPropagation(); interact(); }}>
        <ringGeometry args={[.6, .85, 24]} /><meshBasicMaterial color={entry.color} transparent opacity={.95} />
      </mesh>
      {distance <= 14 && <Html center calculatePosition={portalScreenPosition} position={[0, 2.8, 0]} zIndexRange={[12, 11]} style={{ pointerEvents: 'auto' }}>
        <button className="world-portal-label" data-portal={entry.id} onClick={interact}><strong>{entry.name}</strong><span>{entry.action}{distance > 4 ? `${entry.action ? ' · ' : ''}${Math.round(distance)}m` : ''}</span></button>
      </Html>}
    </group>;
  })}</group>;
}
