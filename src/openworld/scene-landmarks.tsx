import { Html } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { useEffect, useMemo, useState } from 'react';
import { BufferGeometry, Color, Float32BufferAttribute, MeshStandardMaterial, Vector3, type Camera, type Object3D } from 'three';
import { CAVE_SCENES, caveContains, getCaveScene, type CaveScene } from './caves';
import { interiorSurface } from './interior-textures';
import type { WorldPoint, WorldSample } from './types';
import { caveFloorShade, caveVertexHeight } from './cave-relief';
import { CaveDetails } from './cave-details';
import { DungeonStairs } from './dungeon-interior';
import { portalBadges } from './dungeon-gates';
import { LairChamber } from './lair-chamber';
import type { KantoGate, KantoGym, KantoLocation } from './kanto';
import { LeagueStadium } from './league-stadium';

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

/** Red and white bands along a toll barrier arm, from its pivot outward. */
function BarrierArm({ length }: { length: number }) {
  const bands = Math.max(3, Math.round(length / .6)), band = length / bands;
  return <>{Array.from({ length: bands }, (_, index) => <mesh key={index} position={[-(index + .5) * band, 0, 0]} castShadow>
    <boxGeometry args={[band, .16, .12]} /><meshStandardMaterial color={index % 2 ? '#f6f3ec' : '#d8402f'} roughness={.6} />
  </mesh>)}</>;
}

/**
 * A toll-gate checkpoint: a booth beside the road and a striped barrier arm across it. Locked, the arm is down and the
 * booth light red; open, the arm stands up and the light turns green. Badge slots sit on the booth's road-side sign.
 */
export function ProgressGate({ gate, from, to, y, halfWidth, badges, showLabel }: {
  gate: KantoGate; from: KantoLocation; to: KantoLocation; y: number; halfWidth: number; badges: number; showLabel: boolean;
}) {
  const x = gate.position?.x ?? (from.x + to.x) / 2, z = gate.position?.z ?? (from.z + to.z) / 2;
  const rotationY = Math.atan2(to.x - from.x, to.z - from.z);
  const state = gateVisualState(gate.requiredBadges, badges);
  const width = Math.max(2.4, halfWidth * 2), edge = width / 2;
  const booth = { x: edge + 1.35, width: 1.7, depth: 2, height: 2.3 }, pivot = { x: edge + .35, y: 1.05 };
  const sign = { width: Math.max(1.2, state.required * .34 + .3), y: booth.height + .55 };
  return <group name={`progress-gate:${gate.id}:${state.locked ? 'locked' : 'open'}`} position={[x, y, z]} rotation={[0, rotationY, 0]}>
    <group name="toll-booth" position={[booth.x, 0, 0]}>
      <mesh position={[0, .08, 0]} receiveShadow><boxGeometry args={[booth.width + .7, .16, booth.depth + .9]} /><meshStandardMaterial color="#c9c3b5" roughness={.95} /></mesh>
      <mesh position={[0, booth.height / 2 + .16, 0]} castShadow receiveShadow><boxGeometry args={[booth.width, booth.height, booth.depth]} /><meshStandardMaterial color="#f3efe5" roughness={.8} /></mesh>
      {/* A glass band on every side, darker than the walls. */}
      <mesh position={[0, booth.height * .62 + .16, 0]}><boxGeometry args={[booth.width + .02, .75, booth.depth + .02]} /><meshStandardMaterial color="#35505c" roughness={.2} metalness={.1} /></mesh>
      <mesh position={[0, booth.height + .28, 0]} castShadow><boxGeometry args={[booth.width + .5, .24, booth.depth + .5]} /><meshStandardMaterial color="#2f8f86" roughness={.7} /></mesh>
      <mesh position={[-booth.width / 2 - .02, booth.height * .95, booth.depth / 2 - .3]}><sphereGeometry args={[.13, 12, 8]} />
        <meshStandardMaterial color={state.locked ? '#ff4a3a' : '#46e07a'} emissive={state.locked ? '#c01d10' : '#1c9c4a'} emissiveIntensity={1.4} /></mesh>
      {state.required > 0 && <group position={[-booth.width / 2 - .06, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <mesh position={[0, sign.y, 0]} castShadow><boxGeometry args={[sign.width, .5, .08]} /><meshStandardMaterial color="#1f5f8f" roughness={.7} /></mesh>
        <mesh position={[0, sign.y - .45, 0]}><boxGeometry args={[.08, .4, .08]} /><meshStandardMaterial color="#8b9196" /></mesh>
        {Array.from({ length: state.required }, (_, index) => {
          const offset = state.required <= 1 ? 0 : (index / (state.required - 1) - .5) * (sign.width - .34);
          return [-1, 1].map(face => <mesh key={`${index}:${face}`} position={[offset, sign.y, face * .05]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[.13, .13, .04, 12]} />
            <meshStandardMaterial color={index < state.earned ? '#f4d65c' : '#4a4036'} emissive={index < state.earned ? '#5b4608' : '#000000'} emissiveIntensity={.35} />
          </mesh>);
        })}
      </group>}
    </group>
    <group name="toll-barrier" position={[pivot.x, 0, 0]}>
      <mesh position={[0, pivot.y / 2, 0]} castShadow><boxGeometry args={[.36, pivot.y, .36]} /><meshStandardMaterial color="#f1c33c" roughness={.6} /></mesh>
      <group position={[0, pivot.y, 0]} rotation={[0, 0, state.locked ? 0 : -1.35]}>
        <mesh position={[.3, 0, 0]} castShadow><boxGeometry args={[.4, .26, .2]} /><meshStandardMaterial color="#5c6268" roughness={.6} /></mesh>
        <BarrierArm length={width + .2} />
      </group>
    </group>
    {state.locked && !gate.terrainBoundary && <RigidBody type="fixed" colliders={false} position={[0, .82, 0]}><CuboidCollider args={[edge, .7, .2]} /></RigidBody>}
    {showLabel && <Html center calculatePosition={gateScreenPosition} position={[0, 3.3, 0]} zIndexRange={[10, 9]} style={{ pointerEvents: 'none' }}>
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

/** `tile`: metres one texture repeat covers. */
function createCaveFloor(cave: CaveScene, tile: number): BufferGeometry {
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
    uvs.push(x / tile, z / tile);
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

/** Smooth value noise along the wall that wraps exactly once around the chamber. */
function perimeterNoise(distance: number, perimeter: number, wavelength: number, seed: number): number {
  const period = Math.max(3, Math.round(perimeter / wavelength)), t = distance / perimeter * period, cell = Math.floor(t), f = t - cell;
  const at = (index: number) => { const n = Math.sin(((index % period) + period) % period * 127.1 + seed * 311.7) * 43758.5453; return n - Math.floor(n); };
  const eased = f * f * (3 - 2 * f);
  return at(cell) * (1 - eased) + at(cell + 1) * eased;
}

// Wall rows: height above the floor and how far the rock leans in there.
const WALL_ROWS = [
  { y: -.6, lean: 0 }, { y: .3, lean: .16 }, { y: 1.1, lean: .38 }, { y: 1.9, lean: .6 }, { y: 2.7, lean: .76 },
  { y: 3.5, lean: .9 }, { y: 4.3, lean: 1.02 }, { y: 4.95, lean: 1.12 },
] as const;

/**
 * One continuous rock skin around the chamber outline: bulging overhangs, horizontal strata ridges, a ragged
 * crest, and baked banding and occlusion in the vertex colours. It faces only inward, so the orbit camera still
 * sees in from outside, and it stays inside the outline's closed rim, so walkable ground is untouched.
 */
function createCaveWalls(cave: CaveScene, tile: number): BufferGeometry {
  const outline = cave.outline, seed = cave.relief.seed;
  const columns: Array<{ x: number; z: number; distance: number }> = [];
  let perimeter = 0;
  outline.forEach((point, index) => {
    const next = outline[(index + 1) % outline.length], length = Math.hypot(next.x - point.x, next.z - point.z), steps = Math.max(1, Math.round(length / 1.1));
    for (let step = 0; step < steps; step++) columns.push({ x: point.x + (next.x - point.x) * step / steps, z: point.z + (next.z - point.z) * step / steps, distance: perimeter + length * step / steps });
    perimeter += length;
  });
  const count = columns.length, positions: number[] = [], colors: number[] = [], uvs: number[] = [], indices: number[] = [];
  // One extra column closes the loop with continuous texture coordinates.
  for (let column = 0; column <= count; column++) {
    const here = columns[column % count], previous = columns[(column - 1 + count) % count], next = columns[(column + 1) % count];
    const distance = column === count ? perimeter : here.distance;
    let nx = -(next.z - previous.z), nz = next.x - previous.x;
    const length = Math.hypot(nx, nz) || 1; nx /= length; nz /= length;
    if (nx * -here.x + nz * -here.z < 0) { nx = -nx; nz = -nz; }
    const buttress = perimeterNoise(distance, perimeter, 7, seed) - .5, grain = perimeterNoise(distance, perimeter, 2.2, seed + 3) - .5;
    const crest = perimeterNoise(distance, perimeter, 4.5, seed + 7) - .5;
    WALL_ROWS.forEach((row, level) => {
      const top = level === WALL_ROWS.length - 1;
      const y = row.y + (top ? crest * 1.4 : 0);
      const mid = Math.sin(Math.PI * Math.max(0, Math.min(1, row.y / 4.6)));
      const strata = level > 0 && !top ? Math.sin(row.y * 3.3 + buttress * 4) * .1 : 0;
      const inset = row.lean + (level > 0 ? buttress * .7 * mid + grain * .3 * mid + strata : 0);
      positions.push(here.x + nx * inset, y, here.z + nz * inset);
      uvs.push(distance / tile, (y + inset * .6) / tile);
      const band = .86 + .1 * Math.sin(y * 2.6 + buttress * 5 + grain * 3), foot = .6 + .4 * Math.min(1, Math.max(0, (y + .4) / 1.8));
      const shade = band * foot * (1 - Math.max(0, -buttress) * .25) * (top ? .88 : 1);
      colors.push(shade * .97, shade * .98, shade);
    });
  }
  const rows = WALL_ROWS.length;
  for (let column = 0; column < count; column++) for (let level = 0; level < rows - 1; level++) {
    const a = column * rows + level, b = a + 1, c = a + rows, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

const CAVE_TINTS: Record<CaveScene['relief']['theme'], string> = { limestone: '#a39d8e', water: '#7a8d87', ice: '#b2cdd2', volcanic: '#807470', interior: '#7d8586' };

export function CaveInterior({ cave, player, mobile, onNavigate }: { cave: CaveScene; player: WorldPoint; mobile: boolean; onNavigate(point: WorldPoint): void }) {
  // Clean baked surfaces: banded rock on the walls, packed earth underfoot. The vertex colours add the depth.
  const [floorMaterial, wallMaterial, formationMaterial] = useMemo(() => {
    const tint = CAVE_TINTS[cave.relief.theme], roughness = cave.relief.theme === 'water' ? .78 : .92, metalness = cave.relief.theme === 'interior' ? .08 : 0;
    const surface = (name: string, pattern: 'strata' | 'earth') => {
      const set = interiorSurface(pattern);
      const result = new MeshStandardMaterial({ name, color: tint, roughness, metalness, vertexColors: true, map: set.map, normalMap: set.normalMap, roughnessMap: set.ormMap, aoMap: set.ormMap, aoMapIntensity: .6 });
      result.userData.openWorldSurface = 'cave-rock-uv';
      return result;
    };
    // Ledges, spikes and boulders are faceted solids in the same rock colour; no texture is stretched over them.
    const formations = new MeshStandardMaterial({ name: 'cave-formations', color: new Color(tint).multiplyScalar(.9), roughness, metalness, flatShading: true });
    return [surface('cave-floor-pbr', 'earth'), surface('cave-wall-pbr', 'strata'), formations];
  }, [cave.relief.theme]);
  const floor = useMemo(() => createCaveFloor(cave, interiorSurface('earth').tile), [cave]);
  const walls = useMemo(() => createCaveWalls(cave, interiorSurface('strata').tile), [cave]);
  useEffect(() => () => { floorMaterial.dispose(); wallMaterial.dispose(); formationMaterial.dispose(); }, [floorMaterial, formationMaterial, wallMaterial]);
  useEffect(() => () => { floor.dispose(); walls.dispose(); }, [floor, walls]);
  return <group name={`cave-interior:${cave.id}`} dispose={null}>
    <mesh name="cave-floor" geometry={floor} material={floorMaterial} receiveShadow onClick={event => { event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate({ x: event.point.x, z: event.point.z }); }}>
    </mesh>
    <mesh name="cave-wall:outline" geometry={walls} material={wallMaterial} receiveShadow castShadow />
    <CaveDetails cave={cave} material={formationMaterial} player={player} mobile={mobile} onNavigate={onNavigate} />
    {cave.legendary && <LairChamber scene={cave} stone="#a8a294" trim="#6f6a60" mobile={mobile} />}
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
