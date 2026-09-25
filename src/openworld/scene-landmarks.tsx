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

const GATE_WOOD = '#9a6a3c', GATE_WOOD_DARK = '#6f4527', GATE_STONE = '#ddd6c6', GATE_ROOF = '#2f7f78';

/** One leaf of the gate's wooden double door, hinged at its pillar: a framed board with two rails. */
function GateDoor({ width, height, open, side }: { width: number; height: number; open: boolean; side: -1 | 1 }) {
  // The hinge sits at the pillar and the leaf reaches toward the road's centre; both leaves swing toward the far side.
  return <group rotation={[0, open ? side * 1.35 : 0, 0]}>
    <group position={[-side * width / 2, height / 2 + .06, 0]}>
      <mesh castShadow receiveShadow><boxGeometry args={[width - .04, height, .12]} /><meshStandardMaterial color={GATE_WOOD} roughness={.85} /></mesh>
      {[-.3, .3].map(rail => <mesh key={rail} position={[0, rail * height, 0]} castShadow><boxGeometry args={[width - .04, .12, .18]} /><meshStandardMaterial color={GATE_WOOD_DARK} roughness={.85} /></mesh>)}
      <mesh position={[0, 0, 0]}><boxGeometry args={[width + .02, height + .02, .08]} /><meshStandardMaterial color={GATE_WOOD_DARK} roughness={.9} /></mesh>
    </group>
  </group>;
}

/**
 * A route gatehouse: two stone pillars under a timber beam and tiled roof, with a wooden double door across the road.
 * Locked, the doors are shut and the pillar lanterns glow red; open, the doors stand wide and the lanterns turn green.
 * The badge plaque hangs under the beam on both faces.
 */
export function ProgressGate({ gate, from, to, y, halfWidth, badges, showLabel }: {
  gate: KantoGate; from: KantoLocation; to: KantoLocation; y: number; halfWidth: number; badges: number; showLabel: boolean;
}) {
  const x = gate.position?.x ?? (from.x + to.x) / 2, z = gate.position?.z ?? (from.z + to.z) / 2;
  const rotationY = Math.atan2(to.x - from.x, to.z - from.z);
  const state = gateVisualState(gate.requiredBadges, badges);
  const width = Math.max(2.4, halfWidth * 2), edge = width / 2, pillarX = edge + .36, beamY = 2.62, doorHeight = 1.85;
  const plaque = { width: Math.max(1.2, state.required * .34 + .3), y: 2.18 };
  const lantern = state.locked ? ['#ff5a45', '#c01d10'] : ['#62e38a', '#1c9c4a'];
  return <group name={`progress-gate:${gate.id}:${state.locked ? 'locked' : 'open'}`} position={[x, y, z]} rotation={[0, rotationY, 0]}>
    <mesh position={[0, .03, 0]} receiveShadow><boxGeometry args={[width + 1.6, .06, 1]} /><meshStandardMaterial color="#c9c3b5" roughness={.95} /></mesh>
    {[-1, 1].map(side => <group key={side} name="gate-pillar" position={[side * pillarX, 0, 0]}>
      <mesh position={[0, .16, 0]} castShadow receiveShadow><boxGeometry args={[.84, .32, .84]} /><meshStandardMaterial color="#a39c8f" roughness={.95} /></mesh>
      <mesh position={[0, 1.44, 0]} castShadow receiveShadow><boxGeometry args={[.58, 2.3, .58]} /><meshStandardMaterial color={GATE_STONE} roughness={.9} /></mesh>
      <mesh position={[0, 2.66, 0]} castShadow><boxGeometry args={[.74, .16, .74]} /><meshStandardMaterial color="#b9b1a0" roughness={.9} /></mesh>
      <mesh position={[0, 3.02, 0]}><boxGeometry args={[.26, .34, .26]} /><meshStandardMaterial color={GATE_WOOD_DARK} roughness={.8} /></mesh>
      <mesh position={[0, 3.02, 0]}><sphereGeometry args={[.11, 12, 8]} /><meshStandardMaterial color={lantern[0]} emissive={lantern[1]} emissiveIntensity={1.4} /></mesh>
    </group>)}
    <mesh position={[0, beamY, 0]} castShadow><boxGeometry args={[width + 1.7, .28, .44]} /><meshStandardMaterial color={GATE_WOOD_DARK} roughness={.85} /></mesh>
    <mesh position={[0, beamY - .36, 0]} castShadow><boxGeometry args={[width, .14, .3]} /><meshStandardMaterial color={GATE_WOOD} roughness={.85} /></mesh>
    {[-1, 1].map(face => <mesh key={face} position={[0, beamY + .36, face * .28]} rotation={[face * -.5, 0, 0]} castShadow>
      <boxGeometry args={[width + 2.1, .09, .78]} /><meshStandardMaterial color={GATE_ROOF} roughness={.7} />
    </mesh>)}
    <mesh position={[0, beamY + .55, 0]} castShadow><boxGeometry args={[width + 2.2, .1, .14]} /><meshStandardMaterial color="#245f59" roughness={.7} /></mesh>
    {state.required > 0 && [-1, 1].map(face => <group key={face} position={[0, 0, face * .17]}>
      <mesh position={[0, plaque.y, 0]} castShadow><boxGeometry args={[plaque.width, .44, .06]} /><meshStandardMaterial color="#1f5f8f" roughness={.7} /></mesh>
      {Array.from({ length: state.required }, (_, index) => {
        const offset = state.required <= 1 ? 0 : (index / (state.required - 1) - .5) * (plaque.width - .34);
        return <mesh key={index} position={[offset, plaque.y, face * .04]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[.12, .12, .04, 12]} />
          <meshStandardMaterial color={index < state.earned ? '#f4d65c' : '#4a4036'} emissive={index < state.earned ? '#5b4608' : '#000000'} emissiveIntensity={.35} />
        </mesh>;
      })}
    </group>)}
    <group name="gate-doors">
      <group position={[-edge, 0, 0]}><GateDoor width={edge} height={doorHeight} open={!state.locked} side={-1} /></group>
      <group position={[edge, 0, 0]}><GateDoor width={edge} height={doorHeight} open={!state.locked} side={1} /></group>
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
  // No dispose={null}: R3F then disposes the inline geometries on unmount. Props and primitives stay with their owners.
  return <group name={`cave-interior:${cave.id}`}>
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
