import { describe, expect, it } from 'vitest';
import { AnimationClip, Bone, BoxGeometry, BufferAttribute, Group, MeshStandardMaterial, Skeleton, SkinnedMesh, type QuaternionKeyframeTrack } from 'three';
import { pokemonBodyPlan } from '../src/data/body-plans';
import { clipGroundSpeed } from '../src/data/model-motion';
import { pokemonBodyShape } from '../src/data/pokemon-body-shapes';
import { johtoRigShape, prepareRegionalRig } from '../src/three/johto-rig';

describe('body plans', () => {
  it('classify every species from its Pokédex body shape', () => {
    for (let id = 1; id <= 1025; id++) expect(pokemonBodyShape(id), String(id)).toBeDefined();
    expect([448, 25, 336, 16, 100, 99, 129, 94].map(id => pokemonBodyPlan(id))).toEqual(['biped', 'quadruped', 'serpent', 'flyer', 'floater', 'multileg', 'fish', 'biped']);
    // Sentret stands on its tail whatever its icon; Darkrai hovers.
    expect([161, 491].map(id => pokemonBodyPlan(id))).toEqual(['biped', 'floater']);
    expect([pokemonBodyPlan(26), pokemonBodyPlan(26, 'raichu-alola')]).toEqual(['biped', 'floater']);
  });

  it('give static models a skeleton that matches the body, not the type', () => {
    // Treecko and Pansage walk on two legs, Leafeon and Virizion on four; Sunkern and Hoppip keep their plant rigs.
    expect([252, 511, 470, 640, 700, 888, 336, 191, 187].map(johtoRigShape)).toEqual(['biped', 'biped', 'quadruped', 'quadruped', 'quadruped', 'quadruped', 'serpent', 'plant', 'floatingPlant']);
  });
});

/** Hips > Spine, two-segment legs hanging straight down. */
function legs() {
  const bone = (name: string, parent: Bone | undefined, x: number, y: number) => { const value = new Bone(); value.name = name; value.position.set(x, y, 0); parent?.add(value); return value; };
  const hips = bone('Hips', undefined, 0, .9), spine = bone('Spine', hips, 0, .4);
  const lThigh = bone('LThigh', hips, -.15, 0), rThigh = bone('RThigh', hips, .15, 0);
  const bones = [hips, spine, lThigh, rThigh, bone('LLeg', lThigh, 0, -.45), bone('RLeg', rThigh, 0, -.45), bone('LFoot', lThigh.children[0] as Bone, 0, -.4), bone('RFoot', rThigh.children[0] as Bone, 0, -.4)];
  const geometry = new BoxGeometry(.6, 1.6, .3, 2, 8, 2).translate(0, .8, 0), count = geometry.getAttribute('position').count;
  const indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) { const y = geometry.getAttribute('position').getY(i), x = geometry.getAttribute('position').getX(i); indices[i * 4] = y < .45 ? (x < 0 ? 4 : 5) : y < .9 ? (x < 0 ? 2 : 3) : 1; weights[i * 4] = 1; }
  geometry.setAttribute('skinIndex', new BufferAttribute(indices, 4)); geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4));
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial()), scene = new Group(); scene.add(hips, mesh);
  scene.updateMatrixWorld(true); mesh.bind(new Skeleton(bones));
  return scene;
}
/** Signed rotation about X of each key of an unrotated bone's track. */
const pitch = (track: QuaternionKeyframeTrack) => Array.from({ length: track.times.length }, (_, key) => 2 * Math.atan2(track.values[key * 4], track.values[key * 4 + 3]));

describe('stepping walk', () => {
  it('plants each foot while its hip swings back, lifts it on the way forward, and alternates sides', () => {
    const gltf = { scene: legs(), animations: [] as AnimationClip[] };
    prepareRegionalRig(gltf, 448);
    const walk = gltf.animations.find(clip => clip.name === 'CM_walk')!, track = (name: string) => pitch(walk.tracks.find(item => item.name === `${name}.quaternion`) as QuaternionKeyframeTrack);
    expect(clipGroundSpeed(walk)).toBeGreaterThan(0);
    const [thigh, knee, otherKnee] = [track('LThigh'), track('LLeg'), track('RLeg')];
    // 25 keys over one cycle; the left foot is down for the first 60%.
    for (let key = 1; key <= 14; key++) { expect(thigh[key]).toBeGreaterThan(thigh[key - 1]); expect(Math.abs(knee[key])).toBeLessThan(1e-6); }
    expect(knee[19]).toBeGreaterThan(.2);
    // Half a cycle later the right leg swings while the left is planted.
    expect(otherKnee[7]).toBeGreaterThan(.2);
    expect(Math.abs(otherKnee[19])).toBeLessThan(1e-6);
  });
});
