import { describe, expect, it } from 'vitest';
import { AnimationClip, Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, VectorKeyframeTrack } from 'three';
import { normalizePokemonModel, preparePokemonModel } from '../src/openworld/model-normalization';
import { createGrounding } from '../src/openworld/grounding';

describe('prepared animated model bounds', () => {
  it('rejects empty, hidden and fully transparent bodies before they can be marked ready', async () => {
    const empty = new Group();
    await expect(preparePokemonModel(empty, [])).rejects.toThrow('no visible geometry');
    for (const invisible of ['hidden', 'transparent', 'empty-draw'] as const) {
      const source = new Group(), material = new MeshStandardMaterial(), mesh = new Mesh(new BoxGeometry(), material);
      source.add(mesh);
      if (invisible === 'hidden') source.visible = false;
      if (invisible === 'transparent') { material.transparent = true; material.opacity = 0; }
      if (invisible === 'empty-draw') mesh.geometry.setDrawRange(0, 0);
      await expect(preparePokemonModel(source, [])).rejects.toThrow('no visible geometry');
      expect(() => normalizePokemonModel(source, [], 1)).toThrow('no visible geometry');
    }
  });
  it('reuses prepared dimensions while keeping instance transforms and grounding independent', async () => {
    const source = new Group(), mesh = new Mesh(new BoxGeometry(1, 2, 1), new MeshStandardMaterial());
    mesh.name = 'body'; source.add(mesh);
    const clips = [new AnimationClip('walk', 1, [new VectorKeyframeTrack('body.scale', [0, .5, 1], [1, 1, 1, 1, 2, 1, 1, 1, 1])])];
    await preparePokemonModel(source, clips);
    const first = normalizePokemonModel(source.clone(true), clips, 2, {}, source);
    const second = normalizePokemonModel(source.clone(true), clips, 1, {}, source);
    expect(first.sourceSize.y).toBe(4); expect(first.scale).toBeCloseTo(second.scale * 2);
    expect((first.animatedRoot.children[0] as Mesh).frustumCulled).toBe(false);
    expect(mesh.frustumCulled).toBe(true); // cached source stays owned by its loader
    first.animatedRoot.position.x += 3;
    expect(second.animatedRoot.position.x).toBe(0); expect(source.position.x).toBe(0);
    const parent = new Group(), offset = new Group(); parent.add(offset); offset.add(second.visual);
    const ground = createGrounding(second.visual, offset, second.grounding);
    for (const tilt of [0, Math.PI / 2]) {
      offset.rotation.z = tilt; parent.position.y = 2; ground(2);
      expect(new Box3().setFromObject(second.visual, true).min.y).toBeCloseTo(2, 7);
    }
    expect(source.children[0].scale.y).toBe(1);
  });
});
