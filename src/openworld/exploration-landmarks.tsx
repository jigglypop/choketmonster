import { Html } from '@react-three/drei';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { CanvasTexture, DoubleSide, InstancedMesh, Matrix4, Quaternion, SRGBColorSpace, Vector3 } from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { WorldAtlas } from './atlas';
import type { VisibilityTest } from './lod';
import type { WorldPoint, WorldSample } from './types';
import { terrainSurfaceHeight } from './grounding';
import { THEME_COLORS, buildExplorationSites, buildRouteEdgeMarkers, nearbyExplorationSites, type ExplorationSite, type ExplorationTheme, type RouteEdgeMarker } from './exploration-sites';
import { bridgeGeometry, edgeMarkerGeometry, lookoutGeometry, restSpotGeometry, signpostGeometry } from './landmark-geometry';
import { detailMaterial } from './town-details';
import { releaseOnDetach, useReleasingRef } from '../three/render-objects';

export { THEME_COLORS };

export type ExplorationLandmarksProps = {
  atlas: WorldAtlas;
  sampleWorld: (x: number, z: number) => WorldSample;
  player: WorldPoint;
  visibility: VisibilityTest;
  onNavigate: (point: WorldPoint) => void;
  badges: number;
};

function clickTo(site: ExplorationSite, onNavigate: (point: WorldPoint) => void) {
  return (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (event.button === 0 && event.delta <= 5) onNavigate(site.destination);
  };
}

function NearbyLabel({ site }: { site: ExplorationSite }) {
  return <Html center position={[0, 3.1, 0]} zIndexRange={[3, 2]} style={{ pointerEvents: 'none' }}>
    <span className="ow-place-label" data-exploration-site={site.id}>{site.label}</span>
  </Html>;
}

function SignBoard({ name, color, onNavigate }: { name: string; color: string; onNavigate(): void }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
    const context = canvas.getContext('2d')!; context.fillStyle = '#f2e3b8'; context.fillRect(0, 0, 512, 128);
    context.strokeStyle = color; context.lineWidth = 12; context.strokeRect(6, 6, 500, 116);
    context.fillStyle = '#263f32'; context.font = `700 ${name.length > 8 ? 36 : 44}px system-ui`; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillText(name, 256, 64, 466);
    const result = new CanvasTexture(canvas); result.colorSpace = SRGBColorSpace; return result;
  }, [name, color]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <group onClick={event => { event.stopPropagation(); if (event.delta < 6) onNavigate(); }}>
    <mesh castShadow><boxGeometry args={[1.75, .4, .18]} /><meshStandardMaterial color={color} roughness={.78} /></mesh>
    {[-1, 1].map(side => <mesh key={side} position={[0, 0, side * .096]} rotation={[0, side < 0 ? Math.PI : 0, 0]}><planeGeometry args={[1.66, .34]} /><meshBasicMaterial map={texture} side={DoubleSide} /></mesh>)}
  </group>;
}

function Signpost({ site, directions, onNavigate, showLabel }: { site: ExplorationSite; directions: Array<WorldPoint & { name: string }>; onNavigate: (point: WorldPoint) => void; showLabel: boolean }) {
  const colors = THEME_COLORS[site.theme], arms = Math.min(3, directions.length);
  return <group name={site.id} rotation={[0, site.yaw, 0]} onClick={clickTo(site, onNavigate)}>
    <mesh ref={releaseOnDetach} geometry={signpostGeometry(site.theme)} material={detailMaterial()} castShadow dispose={null} />
    {directions.slice(0, arms).map((direction, index) => <group key={index} position={[(index % 2 ? -1 : 1) * .72, 2.2 - index * .43, 0]}>
      <SignBoard name={direction.name} color={index === 0 ? colors.accent : colors.wood} onNavigate={() => onNavigate(direction)} />
    </group>)}
    {showLabel && <NearbyLabel site={site} />}
  </group>;
}

/** Turns a roadside site so its local -z looks away from the road and +z faces it. */
function awayFromRoad(atlas: WorldAtlas, site: ExplorationSite): number {
  const x = Math.cos(site.yaw) * 2, z = -Math.sin(site.yaw) * 2;
  const side = atlas.distanceToPath(site.x + x, site.z + z) >= atlas.distanceToPath(site.x - x, site.z - z) ? 1 : -1;
  return site.yaw - side * Math.PI / 2;
}

function RestSpot({ site, rotation, onNavigate, showLabel }: { site: ExplorationSite; rotation: number; onNavigate: (point: WorldPoint) => void; showLabel: boolean }) {
  return <group name={site.id} rotation={[0, rotation, 0]} onClick={clickTo(site, onNavigate)}>
    <mesh ref={releaseOnDetach} geometry={restSpotGeometry(site.theme)} material={detailMaterial()} castShadow receiveShadow dispose={null} />
    {showLabel && <NearbyLabel site={site} />}
  </group>;
}

function Lookout({ site, rotation, onNavigate, showLabel }: { site: ExplorationSite; rotation: number; onNavigate: (point: WorldPoint) => void; showLabel: boolean }) {
  return <group name={site.id} rotation={[0, rotation, 0]} onClick={clickTo(site, onNavigate)}>
    <mesh ref={releaseOnDetach} geometry={lookoutGeometry(site.theme)} material={detailMaterial()} castShadow receiveShadow dispose={null} />
    {showLabel && <NearbyLabel site={site} />}
  </group>;
}

const bridgeGeometries = new Map<string, ReturnType<typeof bridgeGeometry>>();
function Bridge({ site, sampleWorld, onNavigate, showLabel }: { site: ExplorationSite; sampleWorld: (x: number, z: number) => WorldSample; onNavigate: (point: WorldPoint) => void; showLabel: boolean }) {
  const geometry = useMemo(() => {
    const key = `${site.id}:${site.x}:${site.z}:${site.span}`;
    let value = bridgeGeometries.get(key);
    if (!value) bridgeGeometries.set(key, value = bridgeGeometry(site, (x, z) => terrainSurfaceHeight(sampleWorld, x, z)));
    return value;
  }, [site, sampleWorld]);
  // GPU buffers go when the bridge streams out; the CPU copy stays cached for re-entry.
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <group name={site.id} rotation={[0, site.yaw, 0]} onClick={clickTo(site, onNavigate)}>
    <mesh ref={releaseOnDetach} geometry={geometry} material={detailMaterial()} castShadow receiveShadow dispose={null} />
    {showLabel && <NearbyLabel site={site} />}
  </group>;
}

const markerScratch = { matrix: new Matrix4(), rotation: new Quaternion(), position: new Vector3(), scale: new Vector3(), up: new Vector3(0, 1, 0) };

function EdgeMarkerInstances({ markers, sampleWorld, theme, water }: { markers: readonly RouteEdgeMarker[]; sampleWorld: (x: number, z: number) => WorldSample; theme: ExplorationTheme; water: boolean }) {
  const ref = useRef<InstancedMesh>(null);
  // A larger capacity rebuilds the mesh around the shared material; the old one frees its render objects.
  const attach = useReleasingRef(ref);
  const geometry = useMemo(() => edgeMarkerGeometry(theme, water), [theme, water]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  // The instance buffer is sized by the count at its first draw, so the count stays at a capacity that only grows
  // and unused slots are scaled to nothing at the first marker. A changing marker count reuses the mesh.
  const grown = useRef(8);
  const capacity = grown.current = Math.max(grown.current, 2 ** Math.ceil(Math.log2(Math.max(1, markers.length))));
  useLayoutEffect(() => {
    const mesh = ref.current; if (!mesh) return;
    const { matrix, rotation, position, scale, up } = markerScratch;
    markers.forEach((marker, index) => {
      rotation.setFromAxisAngle(up, marker.yaw);
      matrix.compose(position.set(marker.x, terrainSurfaceHeight(sampleWorld, marker.x, marker.z), marker.z), rotation, scale.set(1, marker.biome === 'rock' ? 1.15 : 1, 1));
      mesh.setMatrixAt(index, matrix);
    });
    const first = markers[0];
    matrix.makeScale(0, 0, 0);
    if (first) matrix.setPosition(first.x, terrainSurfaceHeight(sampleWorld, first.x, first.z), first.z);
    for (let index = markers.length; index < capacity; index++) mesh.setMatrixAt(index, matrix);
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
  }, [markers, sampleWorld, capacity]);
  return <instancedMesh ref={attach} args={[geometry, detailMaterial(), capacity]} castShadow={!water} frustumCulled dispose={null} />;
}

type MarkerGroup = { key: string; theme: ExplorationTheme; water: boolean; items: RouteEdgeMarker[] };

/** 3D roadside landmarks derived from the active atlas. TrailAndWater remains the sole road-surface owner. */
export function ExplorationLandmarks({ atlas, sampleWorld, player, visibility, onNavigate, badges }: ExplorationLandmarksProps) {
  const sites = useMemo(() => buildExplorationSites(atlas, sampleWorld, badges), [atlas, sampleWorld, badges]);
  const markers = useMemo(() => buildRouteEdgeMarkers(atlas, sampleWorld, badges), [atlas, sampleWorld, badges]);
  const nearbySites = nearbyExplorationSites(sites, player, 92).filter(site => visibility(site.x, sampleWorld(site.x, site.z).height + 2, site.z, Math.max(7, (site.span ?? 0) / 2 + 2)));
  // Grouped in one pass. A group whose markers are unchanged keeps its array, so its instances are not rebuilt.
  const previousGroups = useRef(new Map<string, MarkerGroup>());
  const markerGroups = useMemo(() => {
    const groups = new Map<string, MarkerGroup>();
    for (const marker of nearbyExplorationSites(markers, player, 82)) {
      if (!visibility(marker.x, sampleWorld(marker.x, marker.z).height + 1, marker.z, 2)) continue;
      const water = marker.biome === 'lake', key = `${marker.theme}:${water}`;
      let group = groups.get(key);
      if (!group) groups.set(key, group = { key, theme: marker.theme, water, items: [] });
      group.items.push(marker);
    }
    for (const [key, group] of groups) {
      const previous = previousGroups.current.get(key);
      if (previous && previous.items.length === group.items.length && previous.items.every((item, index) => item === group.items[index])) groups.set(key, previous);
    }
    previousGroups.current = groups;
    return [...groups.values()];
  }, [markers, player.x, player.z, visibility, sampleWorld]);
  return <group name={`exploration-landmarks:${atlas.id}`} userData={{ gaesupWorldObject: 'exploration-landmarks' }}>
    {markerGroups.map(group => <EdgeMarkerInstances key={group.key} markers={group.items} sampleWorld={sampleWorld} theme={group.theme} water={group.water} />)}
    {nearbySites.map(site => {
      const y = terrainSurfaceHeight(sampleWorld, site.x, site.z), showLabel = Math.hypot(site.x - player.x, site.z - player.z) <= 15;
      return <group key={site.id} position={[site.x, y, site.z]}>
        {site.kind === 'junction' ? <Signpost site={site} directions={site.connectedLocationIds.flatMap(id => { const place = atlas.locations.find(item => item.id === id); return place ? [{ name: place.name, x: place.x, z: place.z }] : []; })} onNavigate={onNavigate} showLabel={showLabel} />
          : site.kind === 'rest' ? <RestSpot site={site} rotation={awayFromRoad(atlas, site)} onNavigate={onNavigate} showLabel={showLabel} />
            : site.kind === 'lookout' ? <Lookout site={site} rotation={awayFromRoad(atlas, site)} onNavigate={onNavigate} showLabel={showLabel} />
              : <Bridge site={site} sampleWorld={sampleWorld} onNavigate={onNavigate} showLabel={showLabel} />}
      </group>;
    })}
  </group>;
}
