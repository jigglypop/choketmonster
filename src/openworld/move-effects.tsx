import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending, BoxGeometry, BufferGeometry, Color, DodecahedronGeometry, DoubleSide, IcosahedronGeometry, InstancedMesh,
  Mesh, MeshBasicMaterial, NormalBlending, Object3D, OctahedronGeometry, PlaneGeometry, RingGeometry, SphereGeometry, Vector3,
} from 'three';
import { terrainSurfaceHeight } from './grounding';
import type { WorldMoveEffect, WorldSample } from './types';

type Shape = 'orb' | 'bubble' | 'shard' | 'leaf' | 'rock' | 'star';
type Motion = 'burst' | 'rise' | 'fall' | 'spiral' | 'splash';
type Preset = { color: string; glow: string; shape: Shape; motion: Motion; additive: boolean; bolt?: boolean };

/** Per-type particle language: fire rises, water splashes, rock falls, grass swirls, electricity also strikes. */
const PRESETS: Record<string, Preset> = {
  normal: { color: '#fff3d1', glow: '#ffd98a', shape: 'star', motion: 'burst', additive: true },
  fire: { color: '#ff7a2f', glow: '#ffd35a', shape: 'orb', motion: 'rise', additive: true },
  water: { color: '#5cc6ff', glow: '#dff6ff', shape: 'bubble', motion: 'splash', additive: true },
  electric: { color: '#ffe84a', glow: '#fffbd8', shape: 'shard', motion: 'burst', additive: true, bolt: true },
  grass: { color: '#79d957', glow: '#dcff9c', shape: 'leaf', motion: 'spiral', additive: false },
  ice: { color: '#bdf3ff', glow: '#ffffff', shape: 'shard', motion: 'burst', additive: true },
  fighting: { color: '#ff7a52', glow: '#ffe1b8', shape: 'star', motion: 'burst', additive: true },
  poison: { color: '#c066e0', glow: '#f2c0ff', shape: 'bubble', motion: 'rise', additive: true },
  ground: { color: '#c8995a', glow: '#e8cf9c', shape: 'rock', motion: 'splash', additive: false },
  flying: { color: '#e6f3ff', glow: '#a9cdf5', shape: 'leaf', motion: 'spiral', additive: true },
  psychic: { color: '#ff6fc2', glow: '#ffd3ee', shape: 'orb', motion: 'spiral', additive: true },
  bug: { color: '#b3d445', glow: '#f1ffb0', shape: 'orb', motion: 'spiral', additive: true },
  rock: { color: '#b8a36a', glow: '#e3d6a8', shape: 'rock', motion: 'fall', additive: false },
  ghost: { color: '#9b7cf0', glow: '#d6c8ff', shape: 'orb', motion: 'rise', additive: true },
  dragon: { color: '#7b6cff', glow: '#ffb27a', shape: 'shard', motion: 'spiral', additive: true },
  dark: { color: '#6a4f86', glow: '#c9b6ff', shape: 'shard', motion: 'burst', additive: false },
  steel: { color: '#dbe4ec', glow: '#ffffff', shape: 'shard', motion: 'burst', additive: true },
  fairy: { color: '#ffb0de', glow: '#ffffff', shape: 'star', motion: 'rise', additive: true },
};

const PARTICLES = 22, BOLT_SEGMENTS = 6, LIFE = .75, DURATION = 1.6;
const TRAVEL = { physical: .18, special: .42, status: 0 } as const;

let shared: Record<Shape | 'bolt' | 'ring' | 'sphere', BufferGeometry> | undefined;
/** Shared geometry: effects come and go every turn, the meshes never own it. */
function geometries() {
  return shared ??= {
    orb: new IcosahedronGeometry(1, 1), bubble: new SphereGeometry(1, 10, 8), shard: new OctahedronGeometry(1),
    leaf: new PlaneGeometry(1, .55), rock: new DodecahedronGeometry(1), star: new OctahedronGeometry(1),
    bolt: new BoxGeometry(.06, 1, .06), ring: new RingGeometry(.7, 1, 40), sphere: new SphereGeometry(1, 16, 12),
  };
}

function seeded(key: string) {
  let state = 2166136261;
  for (let index = 0; index < key.length; index++) state = Math.imul(state ^ key.charCodeAt(index), 16777619);
  return () => { state = Math.imul(state ^ (state >>> 15), 2246822519) >>> 0; state ^= state >>> 13; return (state >>> 0) / 4294967296; };
}

function Effect({ effect, sample }: { effect: WorldMoveEffect; sample: (x: number, z: number) => WorldSample }) {
  const preset = PRESETS[effect.moveType] ?? PRESETS.normal, shapes = geometries();
  const particles = useRef<InstancedMesh>(null), bolt = useRef<InstancedMesh>(null);
  const orb = useRef<Mesh>(null), halo = useRef<Mesh>(null), flash = useRef<Mesh>(null), ring = useRef<Mesh>(null);
  const blending = preset.additive ? AdditiveBlending : NormalBlending;
  const materials = useMemo(() => ({
    particle: new MeshBasicMaterial({ color: preset.color, transparent: true, depthWrite: false, blending, side: DoubleSide, toneMapped: false }),
    glow: new MeshBasicMaterial({ color: preset.glow, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
    ring: new MeshBasicMaterial({ color: preset.color, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, toneMapped: false }),
    bolt: new MeshBasicMaterial({ color: new Color(preset.glow), transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
  }), [blending, preset.color, preset.glow]);
  useEffect(() => () => Object.values(materials).forEach(material => material.dispose()), [materials]);
  const plan = useMemo(() => {
    const random = seeded(effect.key), ground = (x: number, z: number) => terrainSurfaceHeight(sample, x, z);
    const from = new Vector3(effect.from.x, ground(effect.from.x, effect.from.z) + effect.from.height * .55, effect.from.z);
    const to = new Vector3(effect.to.x, ground(effect.to.x, effect.to.z) + effect.to.height * .5, effect.to.z);
    const floor = ground(effect.to.x, effect.to.z), reach = Math.max(.8, Math.min(2.4, effect.to.height * .6));
    const self = from.distanceToSquared(to) < .01;
    // A miss flies past the target instead of connecting.
    if (!effect.hit && !self) to.add(to.clone().sub(from).setY(0).normalize().multiplyScalar(1.6));
    const seeds = Array.from({ length: PARTICLES }, () => {
      const angle = random() * Math.PI * 2, lift = .25 + random() * .75;
      return { angle, lift, radius: .25 + random() * .75, speed: (1.1 + random() * 1.5) * reach, size: (.06 + random() * .1) * reach, delay: random() * .12, spin: (random() - .5) * 14 };
    });
    const zig = Array.from({ length: BOLT_SEGMENTS }, () => [(random() - .5) * .7, (random() - .5) * .7] as const);
    return { from, to, floor, reach, self, seeds, zig };
  }, [effect, sample]);
  const dummy = useMemo(() => new Object3D(), []);

  useFrame(() => {
    const t = (performance.now() - effect.start) / 1000, travel = TRAVEL[effect.style];
    const impact = t - travel, { from, to, floor, reach, seeds, zig, self } = plan;
    const alive = t >= 0 && t < DURATION;
    const connects = effect.hit || self || effect.style === 'status';
    // Special moves: a glowing orb arcs from the user to the target.
    if (orb.current && halo.current) {
      const flying = alive && effect.style === 'special' && !self && t < travel;
      orb.current.visible = halo.current.visible = flying;
      if (flying) {
        const s = t / travel;
        orb.current.position.lerpVectors(from, to, s); orb.current.position.y += Math.sin(Math.PI * s) * .6 * reach;
        halo.current.position.copy(orb.current.position);
        orb.current.scale.setScalar(.16 * reach); halo.current.scale.setScalar((.34 + Math.sin(t * 40) * .04) * reach);
        materials.glow.opacity = .55;
      }
    }
    // Impact flash on physical and special hits.
    if (flash.current) {
      const shown = alive && connects && effect.style !== 'status' && impact >= 0 && impact < .28;
      flash.current.visible = shown;
      if (shown) { const s = impact / .28; flash.current.position.copy(to); flash.current.scale.setScalar((.3 + s * .9) * reach); materials.glow.opacity = (1 - s) * .8; }
    }
    // Ground ring: a shock ring on hits, a slow aura for status moves.
    if (ring.current) {
      const span = effect.style === 'status' ? 1.1 : .45, local = effect.style === 'status' ? t : impact;
      const shown = alive && connects && local >= 0 && local < span;
      ring.current.visible = shown;
      if (shown) { const s = local / span; ring.current.position.set(to.x, floor + .06, to.z); ring.current.scale.setScalar((.5 + s * (effect.style === 'status' ? .8 : 1.6)) * reach); materials.ring.opacity = (1 - s) * .85; }
    }
    // Particles.
    if (particles.current) {
      const mesh = particles.current;
      let visible = 0;
      for (let index = 0; index < PARTICLES; index++) {
        const seed = seeds[index], local = (effect.style === 'status' ? t * .8 : impact) - seed.delay;
        if (!alive || (!connects && index % 3 !== 0) || local < 0 || local > LIFE) { dummy.scale.setScalar(0); dummy.position.copy(to); dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix); continue; }
        const s = local / LIFE, ease = 1 - (1 - s) * (1 - s), cos = Math.cos(seed.angle), sin = Math.sin(seed.angle);
        const origin = to;
        switch (preset.motion) {
          case 'burst': dummy.position.set(origin.x + cos * seed.speed * ease * .8, origin.y + seed.lift * seed.speed * ease * .7 - 1.6 * local * local, origin.z + sin * seed.speed * ease * .8); break;
          case 'rise': dummy.position.set(origin.x + cos * seed.radius * reach * .7 + Math.sin(local * 9 + index) * .06, origin.y - reach * .35 + local * seed.speed * 1.1, origin.z + sin * seed.radius * reach * .7); break;
          case 'fall': dummy.position.set(origin.x + cos * seed.radius * reach, Math.max(floor + seed.size, origin.y + reach * 2.2 - local * 7.5), origin.z + sin * seed.radius * reach); break;
          case 'spiral': { const angle = seed.angle + local * 7, radius = (.35 + ease * .9) * reach; dummy.position.set(origin.x + Math.cos(angle) * radius, origin.y - reach * .3 + ease * 1.2 * reach, origin.z + Math.sin(angle) * radius); break; }
          case 'splash': dummy.position.set(origin.x + cos * seed.speed * local * .9, Math.max(floor, origin.y - reach * .2 + seed.speed * 1.5 * local - 4.9 * local * local), origin.z + sin * seed.speed * local * .9); break;
        }
        dummy.rotation.set(seed.spin * local, seed.angle + seed.spin * local * .6, seed.spin * local * .4);
        const size = seed.size * (preset.motion === 'fall' ? 1.4 : 1 - s * .75);
        if (preset.shape === 'shard') dummy.scale.set(size * .55, size * 2.2, size * .55);
        else if (preset.shape === 'star') dummy.scale.set(size * 1.3, size * 1.3, size * .35);
        else dummy.scale.setScalar(size);
        dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix); visible++;
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = visible > 0;
      materials.particle.opacity = preset.shape === 'bubble' ? .6 : .95;
    }
    // Electric moves also strike the target from above.
    if (bolt.current) {
      const mesh = bolt.current, shown = alive && preset.bolt === true && connects && impact > -.06 && impact < .3 && Math.floor(t * 30) % 3 !== 0;
      mesh.visible = shown;
      if (shown) {
        const top = new Vector3(to.x, to.y + 3.2 * reach, to.z);
        let previous = top;
        for (let index = 0; index < BOLT_SEGMENTS; index++) {
          const s = (index + 1) / BOLT_SEGMENTS, [dx, dz] = index === BOLT_SEGMENTS - 1 ? [0, 0] : zig[index];
          const next = new Vector3(to.x + dx * reach, top.y + (to.y - top.y) * s, to.z + dz * reach);
          dummy.position.copy(previous).add(next).multiplyScalar(.5);
          dummy.scale.set(reach, previous.distanceTo(next), reach);
          dummy.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), next.clone().sub(previous).normalize());
          dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix); previous = next;
        }
        mesh.instanceMatrix.needsUpdate = true;
        materials.bolt.opacity = .95;
      }
    }
  });

  return <group name={`move-effect:${effect.moveType}:${effect.style}`}>
    <instancedMesh ref={particles} args={[shapes[preset.shape], materials.particle, PARTICLES]} frustumCulled={false} dispose={null} />
    {preset.bolt && <instancedMesh ref={bolt} args={[shapes.bolt, materials.bolt, BOLT_SEGMENTS]} frustumCulled={false} dispose={null} />}
    <mesh ref={orb} geometry={shapes.orb} material={materials.particle} visible={false} dispose={null} />
    <mesh ref={halo} geometry={shapes.sphere} material={materials.glow} visible={false} dispose={null} />
    <mesh ref={flash} geometry={shapes.sphere} material={materials.glow} visible={false} dispose={null} />
    <mesh ref={ring} geometry={shapes.ring} material={materials.ring} rotation={[-Math.PI / 2, 0, 0]} visible={false} dispose={null} />
  </group>;
}

/** Battle move effects between battlers. Each effect times itself from its start stamp. */
export const MoveEffects = memo(function MoveEffects({ effects, sample }: { effects?: readonly WorldMoveEffect[]; sample: (x: number, z: number) => WorldSample }) {
  if (!effects?.length) return null;
  return <group name="move-effects">{effects.map(effect => <Effect key={effect.key} effect={effect} sample={sample} />)}</group>;
});
