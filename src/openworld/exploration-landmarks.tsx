import { Html } from '@react-three/drei';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { CanvasTexture, DoubleSide, InstancedMesh, Matrix4, Quaternion, SRGBColorSpace, Vector3 } from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { WorldAtlas } from './atlas';
import type { VisibilityTest } from './lod';
import type { WorldPoint, WorldSample } from './types';
import { terrainSurfaceHeight } from './grounding';
import { buildExplorationSites, buildRouteEdgeMarkers, nearbyExplorationSites, type ExplorationSite, type ExplorationTheme, type RouteEdgeMarker } from './exploration-sites';

export type ExplorationLandmarksProps = {
  atlas: WorldAtlas;
  sampleWorld: (x: number, z: number) => WorldSample;
  player: WorldPoint;
  visibility: VisibilityTest;
  onNavigate: (point: WorldPoint) => void;
  badges: number;
};

export const THEME_COLORS: Record<ExplorationTheme, { wood: string; accent: string; stone: string }> = {
  classic: { wood: '#765534', accent: '#d94f45', stone: '#8f968d' }, heritage: { wood: '#5f4431', accent: '#a94b42', stone: '#817a70' },
  volcanic: { wood: '#57463c', accent: '#e36b3e', stone: '#6e625d' }, alpine: { wood: '#6c5541', accent: '#8cb9cf', stone: '#8c989c' },
  metro: { wood: '#4d5960', accent: '#e8b64b', stone: '#77858b' }, garden: { wood: '#74604b', accent: '#8e73ad', stone: '#aca28f' },
  island: { wood: '#8a6039', accent: '#48a9a0', stone: '#ac9b78' }, rail: { wood: '#594c43', accent: '#b84d4d', stone: '#73777a' },
  frontier: { wood: '#745b3c', accent: '#6e9470', stone: '#80796b' }, mosaic: { wood: '#75543e', accent: '#d38251', stone: '#99907d' },
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
    <mesh position={[0, 1.35, 0]} castShadow><cylinderGeometry args={[.13, .18, 2.7, site.theme === 'metro' ? 8 : 6]} /><meshStandardMaterial color={colors.wood} roughness={.8} /></mesh>
    {directions.slice(0, arms).map((direction, index) => <group key={index} position={[(index % 2 ? -1 : 1) * .72, 2.2 - index * .43, 0]}>
      <SignBoard name={direction.name} color={index === 0 ? colors.accent : colors.wood} onNavigate={() => onNavigate(direction)} />
    </group>)}
    <mesh position={[0, 2.87, 0]} rotation={[0, Math.PI / 4, 0]} castShadow><octahedronGeometry args={[.28]} /><meshStandardMaterial color={colors.accent} /></mesh>
    {showLabel && <NearbyLabel site={site} />}
  </group>;
}

function RestSpot({ site, onNavigate, showLabel }: { site: ExplorationSite; onNavigate: (point: WorldPoint) => void; showLabel: boolean }) {
  const colors = THEME_COLORS[site.theme];
  return <group name={site.id} rotation={[0, site.yaw, 0]} onClick={clickTo(site, onNavigate)}>
    <mesh position={[0, .62, 0]} castShadow receiveShadow><boxGeometry args={[2.5, .24, .72]} /><meshStandardMaterial color={colors.wood} roughness={.9} /></mesh>
    {[-.88, .88].map(x => <mesh key={x} position={[x, .28, 0]} castShadow><boxGeometry args={[.2, .62, .55]} /><meshStandardMaterial color={colors.stone} roughness={1} /></mesh>)}
    <mesh position={[-1.7, .32, -.15]} castShadow><cylinderGeometry args={[.42, .5, .36, 9]} /><meshStandardMaterial color={colors.stone} roughness={1} /></mesh>
    <mesh position={[-1.7, .56, -.15]}><circleGeometry args={[.28, 12]} /><meshBasicMaterial color={site.theme === 'volcanic' ? '#e7793f' : colors.accent} /></mesh>
    {showLabel && <NearbyLabel site={site} />}
  </group>;
}

function Lookout({ site, onNavigate, showLabel }: { site: ExplorationSite; onNavigate: (point: WorldPoint) => void; showLabel: boolean }) {
  const colors = THEME_COLORS[site.theme];
  return <group name={site.id} rotation={[0, site.yaw, 0]} onClick={clickTo(site, onNavigate)}>
    <mesh position={[0, .16, 0]} receiveShadow><cylinderGeometry args={[2.1, 2.25, .32, site.theme === 'mosaic' ? 8 : 16]} /><meshStandardMaterial color={colors.stone} roughness={.95} /></mesh>
    {[-1.7, 0, 1.7].map(x => <mesh key={x} position={[x, .82, -.9]} castShadow><boxGeometry args={[.12, 1.25, .12]} /><meshStandardMaterial color={colors.wood} /></mesh>)}
    <mesh position={[0, 1.3, -.9]} castShadow><boxGeometry args={[3.6, .14, .16]} /><meshStandardMaterial color={colors.wood} /></mesh>
    <mesh position={[0, 1.28, .45]} rotation={[-.24, 0, 0]} castShadow><cylinderGeometry args={[.22, .34, 1.35, 10]} /><meshStandardMaterial color={colors.accent} metalness={.25} roughness={.5} /></mesh>
    {showLabel && <NearbyLabel site={site} />}
  </group>;
}

function BridgeRails({ site, onNavigate, showLabel }: { site: ExplorationSite; onNavigate: (point: WorldPoint) => void; showLabel: boolean }) {
  const colors = THEME_COLORS[site.theme];
  return <group name={site.id} rotation={[0, site.yaw, 0]} onClick={clickTo(site, onNavigate)}>
    {[-1, 1].map(side => <group key={side} position={[side * 2.15, 0, 0]}>
      {[-3.2, 0, 3.2].map(z => <mesh key={z} position={[0, .76, z]} castShadow><boxGeometry args={[.14, 1.45, .14]} /><meshStandardMaterial color={colors.stone} /></mesh>)}
      <mesh position={[0, 1.35, 0]} castShadow><boxGeometry args={[.16, .16, 6.55]} /><meshStandardMaterial color={colors.accent} metalness={site.theme === 'metro' || site.theme === 'rail' ? .35 : 0} /></mesh>
    </group>)}
    {showLabel && <NearbyLabel site={site} />}
  </group>;
}

function EdgeMarkerInstances({ markers, sampleWorld, color }: { markers: readonly RouteEdgeMarker[]; sampleWorld: (x: number, z: number) => WorldSample; color: string }) {
  const ref = useRef<InstancedMesh>(null), matrix = useMemo(() => new Matrix4(), []), rotation = useMemo(() => new Quaternion(), []);
  useLayoutEffect(() => {
    if (!ref.current) return;
    markers.forEach((marker, index) => {
      const y = terrainSurfaceHeight(sampleWorld, marker.x, marker.z) + .62;
      rotation.setFromAxisAngle(new Vector3(0, 1, 0), marker.yaw);
      matrix.compose(new Vector3(marker.x, y, marker.z), rotation, new Vector3(1, marker.biome === 'rock' ? 1.25 : 1, 1));
      ref.current!.setMatrixAt(index, matrix);
    });
    ref.current.count = markers.length; ref.current.instanceMatrix.needsUpdate = true; ref.current.computeBoundingSphere();
  }, [markers, sampleWorld, matrix, rotation]);
  return <instancedMesh ref={ref} args={[undefined, undefined, markers.length]} castShadow frustumCulled>
    <cylinderGeometry args={[.11, .16, 1.24, 6]} /><meshStandardMaterial color={color} roughness={.86} />
  </instancedMesh>;
}

/** 3D roadside landmarks derived from the active atlas. TrailAndWater remains the sole road-surface owner. */
export function ExplorationLandmarks({ atlas, sampleWorld, player, visibility, onNavigate, badges }: ExplorationLandmarksProps) {
  const sites = useMemo(() => buildExplorationSites(atlas, sampleWorld, badges), [atlas, sampleWorld, badges]);
  const markers = useMemo(() => buildRouteEdgeMarkers(atlas, sampleWorld, badges), [atlas, sampleWorld, badges]);
  const nearbySites = nearbyExplorationSites(sites, player, 92).filter(site => visibility(site.x, sampleWorld(site.x, site.z).height + 2, site.z, 7));
  const nearbyMarkers = nearbyExplorationSites(markers, player, 82).filter(marker => visibility(marker.x, sampleWorld(marker.x, marker.z).height + 1, marker.z, 2));
  const markerGroups = [...new Map(nearbyMarkers.map(marker => [marker.theme, nearbyMarkers.filter(item => item.theme === marker.theme)])).entries()];
  return <group name={`exploration-landmarks:${atlas.id}`} userData={{ gaesupWorldObject: 'exploration-landmarks' }}>
    {markerGroups.map(([theme, items]) => <EdgeMarkerInstances key={theme} markers={items} sampleWorld={sampleWorld} color={THEME_COLORS[theme].accent} />)}
    {nearbySites.map(site => {
      const y = terrainSurfaceHeight(sampleWorld, site.x, site.z), showLabel = Math.hypot(site.x - player.x, site.z - player.z) <= 15;
      return <group key={site.id} position={[site.x, y, site.z]}>
        {site.kind === 'junction' ? <Signpost site={site} directions={site.connectedLocationIds.flatMap(id => { const place = atlas.locations.find(item => item.id === id); return place ? [{ name: place.name, x: place.x, z: place.z }] : []; })} onNavigate={onNavigate} showLabel={showLabel} />
          : site.kind === 'rest' ? <RestSpot site={site} onNavigate={onNavigate} showLabel={showLabel} />
            : site.kind === 'lookout' ? <Lookout site={site} onNavigate={onNavigate} showLabel={showLabel} />
              : <BridgeRails site={site} onNavigate={onNavigate} showLabel={showLabel} />}
      </group>;
    })}
  </group>;
}
