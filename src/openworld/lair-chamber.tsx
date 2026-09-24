import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending, Color, CylinderGeometry, DataTexture, DoubleSide, InstancedMesh, LinearFilter, Matrix4, MeshBasicMaterial, MeshStandardMaterial,
  OctahedronGeometry, RGBAFormat, type PointLight,
} from 'three';
import { getSpecies } from '../data/pokemon';
import type { CaveScene } from './caves';
import { interiorSurface } from './interior-textures';
import { lairLayout } from './interior-layout';
import { lairGeometry } from './lair-geometry';
import { mix } from './interior-kit';
import { TYPE_COLORS } from './type-colors';

/** The shrine's glow takes the colour of the first legendary waiting there. */
export function lairAccent(scene: CaveScene): string {
  const speciesId = scene.legendary?.[0], type = speciesId === undefined ? undefined : getSpecies(speciesId)?.types[0];
  return `#${mix(TYPE_COLORS[type ?? 'psychic'] ?? TYPE_COLORS.psychic, '#ffffff', .18).getHexString()}`;
}

/** Carved, vertex-tinted stone shared by temple props and lair pieces. */
export function carvedMaterial(name: string): MeshStandardMaterial {
  const grain = interiorSurface('grain');
  return new MeshStandardMaterial({ name, vertexColors: true, map: grain.map, normalMap: grain.normalMap, roughnessMap: grain.ormMap, aoMap: grain.ormMap, roughness: 1 });
}
/** Unlit flames, paper and runes; they must not be darkened by the shadows they sit in. */
export function glowMaterial(name: string): MeshBasicMaterial {
  return new MeshBasicMaterial({ name, vertexColors: true, toneMapped: false });
}

let shaftTexture: DataTexture | undefined;
/** Vertical falloff for the light shaft: soft at the floor, brightest just above it, gone near the top. */
function shaftFade(): DataTexture {
  if (shaftTexture) return shaftTexture;
  const height = 64, pixels = new Uint8Array(height * 4);
  for (let y = 0; y < height; y++) {
    const v = (y + .5) / height, alpha = Math.min(1, v / .06) * Math.pow(1 - v, 1.6);
    pixels.set([255, 255, 255, Math.round(alpha * 255)], y * 4);
  }
  shaftTexture = new DataTexture(pixels, 1, height, RGBAFormat);
  shaftTexture.minFilter = shaftTexture.magFilter = LinearFilter; shaftTexture.needsUpdate = true;
  return shaftTexture;
}

const MOTES = 26;
/** Sparks drifting up through the light shaft. */
function Motes({ x, y, z, color }: { x: number; y: number; z: number; color: string }) {
  const ref = useRef<InstancedMesh>(null);
  const geometry = useMemo(() => new OctahedronGeometry(.045, 0), []);
  const material = useMemo(() => new MeshBasicMaterial({ name: 'lair-motes', color, toneMapped: false }), [color]);
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  const matrix = useMemo(() => new Matrix4(), []);
  useFrame(({ clock }) => {
    const mesh = ref.current; if (!mesh) return;
    const time = clock.elapsedTime;
    for (let index = 0; index < MOTES; index++) {
      const phase = (time * (.12 + (index % 5) * .02) + index / MOTES) % 1, angle = index * 2.4 + time * .25, radius = .35 + (index * 37 % 13) / 13 * 1.2;
      const scale = Math.sin(phase * Math.PI) * (.7 + (index % 3) * .25);
      matrix.makeScale(scale, scale, scale).setPosition(x + Math.cos(angle) * radius, y + .2 + phase * 3.6, z + Math.sin(angle) * radius);
      mesh.setMatrixAt(index, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} name="lair-motes" args={[geometry, material, MOTES]} frustumCulled={false} dispose={null} />;
}

/**
 * The last floor of a legendary lair ends at a shrine around the altar: a low walkable dais with a glowing
 * inlay, pillars or standing stones behind it, two braziers and a shaft of light with drifting sparks.
 * Nothing here blocks walking; every solid piece stands on ground that was already closed.
 */
export function LairChamber({ scene, stone, trim, mobile }: { scene: CaveScene; stone: string; trim: string; mobile: boolean }) {
  const layout = useMemo(() => lairLayout(scene), [scene]);
  const accent = useMemo(() => lairAccent(scene), [scene]);
  const built = useMemo(() => layout ? lairGeometry(scene, layout, { stone, trim }, accent, interiorSurface('grain').tile) : undefined, [scene, layout, stone, trim, accent]);
  const materials = useMemo(() => {
    const shaft = new MeshBasicMaterial({ name: 'lair-light-shaft', color: new Color(accent).lerp(new Color('#fff4d8'), .35), map: shaftFade(), transparent: true, opacity: .22,
      blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
    shaft.forceSinglePass = true;
    return { solid: carvedMaterial('lair-stone'), glow: glowMaterial('lair-glow'), shaft };
  }, [accent]);
  const shaftGeometry = useMemo(() => new CylinderGeometry(1.25, 1.75, 11, 24, 1, true), []);
  useEffect(() => () => { built?.solid?.dispose(); built?.glow?.dispose(); }, [built]);
  useEffect(() => () => { Object.values(materials).forEach(material => material.dispose()); shaftGeometry.dispose(); }, [materials, shaftGeometry]);
  const altarLight = useRef<PointLight>(null), fireLights = useRef<Array<PointLight | null>>([]);
  useFrame(({ clock }) => {
    const time = clock.elapsedTime;
    if (altarLight.current) altarLight.current.intensity = 10 * (1 + Math.sin(time * 1.3) * .12);
    fireLights.current.forEach((light, index) => { if (light) light.intensity = 5.5 * (1 + Math.sin(time * 9.1 + index * 2) * .08 + Math.sin(time * 23.7 + index) * .05); });
  });
  if (!layout || !built) return null;
  const { x, y, z } = layout.center;
  return <group name={`lair-chamber:${scene.id}`}>
    {built.solid && <mesh name="lair-shrine" geometry={built.solid} material={materials.solid} castShadow receiveShadow dispose={null} />}
    {built.glow && <mesh name="lair-shrine-glow" geometry={built.glow} material={materials.glow} dispose={null} />}
    <mesh name="lair-light-shaft" geometry={shaftGeometry} material={materials.shaft} position={[x, y + 5.5, z]} renderOrder={2} dispose={null} />
    <Motes x={x} y={y} z={z} color={accent} />
    <pointLight ref={altarLight} name="lair-altar-light" position={[x, y + 2.4, z]} color={accent} intensity={10} distance={11} decay={2} />
    {/* Brazier fires light the shrine on desktop; phones keep only the altar glow. */}
    {!mobile && built.fires.map((fire, index) => <pointLight key={index} ref={light => { fireLights.current[index] = light; }} name="lair-brazier-light"
      position={[fire.x, fire.y + .3, fire.z]} color={fire.color} intensity={5.5} distance={8} decay={2} />)}
  </group>;
}
