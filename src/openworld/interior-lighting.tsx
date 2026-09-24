import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  CircleGeometry, Color, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, Quaternion, Vector3, type DirectionalLight,
} from 'three';
import type { CaveScene } from './caves';
import { DUNGEON_LOOKS } from './dungeon-interior';
import { contactShadowTexture } from './interior-kit';
import type { WorldPoint, WorldSample } from './types';

export type IndoorRig = {
  sky: string; ground: string; hemisphere: number;
  key: { color: string; intensity: number };
  lamp?: { color: string; intensity: number };
  /** Share of the daylight sky environment left indoors. */
  environment: number;
};

/**
 * Indoor light balance. One angled key light casts every shadow; the sky fill, the partner's lamp and the
 * daylight environment stay low so those shadows still read. Caves stay the darkest.
 */
export function indoorRig(scene?: CaveScene, hall?: 'gym' | 'league'): IndoorRig {
  if (scene) {
    const look = DUNGEON_LOOKS[scene.style], cave = scene.kind === 'cave';
    return {
      sky: look.light, ground: look.ground, hemisphere: look.intensity,
      key: { color: `#${new Color(look.lamp).lerp(new Color('#ffffff'), .45).getHexString()}`, intensity: cave ? 2.3 : 2.6 },
      lamp: { color: look.lamp, intensity: look.lampIntensity }, environment: cave ? .1 : .15,
    };
  }
  return { sky: '#d9eeed', ground: '#434f3f', hemisphere: hall === 'league' ? .7 : .78, key: { color: '#fff6e8', intensity: 2.7 }, environment: hall ? .26 : .2 };
}

/**
 * Indoors the shadow light comes in from the camera's left at about 57°, as through a high opening, so every
 * pillar, prop and Pokémon throws a shadow the default camera sees from the side. The shadow box is tighter
 * and denser than outdoors and refreshes more often, since interiors carry far fewer casters.
 */
function IndoorKeyLight({ player, mobile, color, intensity }: { player: WorldPoint; mobile: boolean; color: string; intensity: number }) {
  const light = useRef<DirectionalLight>(null);
  const target = useMemo(() => new Object3D(), []);
  const elapsed = useRef(1);
  const reach = mobile ? 13 : 20, size = mobile ? 256 : 1024;
  useFrame((_, delta) => {
    elapsed.current += delta;
    if (light.current && elapsed.current >= 1 / (mobile ? 12 : 30)) { light.current.shadow.needsUpdate = true; elapsed.current = 0; }
  });
  const x = Math.round(player.x / 4) * 4, z = Math.round(player.z / 4) * 4;
  useLayoutEffect(() => { target.position.set(x, 0, z); target.updateMatrixWorld(); }, [x, z, target]);
  return <><primitive object={target} /><directionalLight ref={light} name="indoor-key-light" target={target} position={[x - 12, 22, z + 8]} intensity={intensity} color={color} castShadow
    shadow-autoUpdate={false} shadow-mapSize={[size, size]} shadow-camera-near={1} shadow-camera-far={70}
    shadow-camera-left={-reach} shadow-camera-right={reach} shadow-camera-top={reach} shadow-camera-bottom={-reach}
    shadow-normalBias={.035} shadow-bias={-.0005} /></>;
}

/** Holds the scene's environment light at `value` while mounted; the daylight sky rig sets its own value on mount. */
function EnvironmentLevel({ value }: { value: number }) {
  const scene = useThree(state => state.scene), saved = useRef<number | undefined>(undefined);
  useFrame(() => {
    if (scene.environmentIntensity === value) return;
    saved.current ??= scene.environmentIntensity;
    scene.environmentIntensity = value;
  });
  useEffect(() => () => { if (saved.current !== undefined) scene.environmentIntensity = saved.current; }, [scene]);
  return null;
}

type ShadowedCreature = { creature: { id: string; displayHeight?: number } };
const up = new Vector3(0, 1, 0);
/**
 * A soft contact shadow under every drawn Pokémon, following the model's interpolated position and tilted to
 * the floor. It sits beside the scene's creature groups, which it looks up by name each frame.
 */
function CreatureContactShadows({ creatures, sample }: { creatures: readonly ShadowedCreature[]; sample(x: number, z: number): WorldSample }) {
  const mesh = useRef<InstancedMesh>(null), capacity = 32;
  const geometry = useMemo(() => new CircleGeometry(1, 24).rotateX(-Math.PI / 2), []);
  const material = useMemo(() => {
    const result = new MeshBasicMaterial({ name: 'creature-contact-shadow', color: '#050708', map: contactShadowTexture(), transparent: true, opacity: .34, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    result.forceSinglePass = true;
    return result;
  }, []);
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  const sizes = useMemo(() => new Map(creatures.map(({ creature }) => [`creature:${creature.id}`, creature.displayHeight ?? 1.2])), [creatures]);
  const scratch = useMemo(() => ({ matrix: new Matrix4(), rotation: new Quaternion(), normal: new Vector3(), position: new Vector3(), scale: new Vector3() }), []);
  useFrame(() => {
    const target = mesh.current, parent = target?.parent; if (!target || !parent) return;
    let count = 0;
    for (const child of parent.children) {
      if (count >= capacity) break;
      const height = sizes.get(child.name);
      if (height === undefined || !child.visible || !child.children.some(part => part.name.startsWith('pokemon-model:'))) continue;
      const { x, y, z } = child.position, radius = Math.max(.32, Math.min(2.4, height * .36 + .18));
      const step = Math.min(.6, radius * .5);
      const slopeX = (sample(x + step, z).height - sample(x - step, z).height) / (step * 2), slopeZ = (sample(x, z + step).height - sample(x, z - step).height) / (step * 2);
      scratch.rotation.setFromUnitVectors(up, scratch.normal.set(-slopeX, 1, -slopeZ).normalize());
      scratch.matrix.compose(scratch.position.set(x, y + .035, z), scratch.rotation, scratch.scale.set(radius, 1, radius));
      target.setMatrixAt(count++, scratch.matrix);
    }
    target.count = count;
    target.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} name="creature-contact-shadows" args={[geometry, material, capacity]} frustumCulled={false} renderOrder={1} dispose={null} />;
}

/** Everything that lights a cave, dungeon floor or hall. Outdoors the sun rig is used instead. */
export function IndoorLighting({ scene, hall, player, mobile, sample, creatures }: {
  scene?: CaveScene; hall?: 'gym' | 'league'; player: WorldPoint; mobile: boolean;
  sample(x: number, z: number): WorldSample; creatures: readonly ShadowedCreature[];
}) {
  const rig = indoorRig(scene, hall), floor = sample(player.x, player.z).height;
  return <>
    <hemisphereLight color={rig.sky} groundColor={rig.ground} intensity={rig.hemisphere} />
    <IndoorKeyLight player={player} mobile={mobile} color={rig.key.color} intensity={rig.key.intensity} />
    {/* The partner's lamp: a warm pool that falls off quickly, without shadows of its own. */}
    {rig.lamp && <pointLight name="partner-lamp" position={[player.x, floor + 3.3, player.z]} color={rig.lamp.color} intensity={rig.lamp.intensity} distance={16} decay={2} />}
    <EnvironmentLevel value={rig.environment} />
    <CreatureContactShadows creatures={creatures} sample={sample} />
  </>;
}
