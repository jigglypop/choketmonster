import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { CAVE_SCENES, type CaveScene } from '../src/openworld/caves';
import { LAIR_DAIS_RADIUS, caveCrystals, cavePuddles, lairLayout, sceneDoorways, wallBandSpots } from '../src/openworld/interior-layout';
import { lairGeometry } from '../src/openworld/lair-geometry';
import { floorDressing, roomProps } from '../src/openworld/temple-geometry';
import { chamferBox } from '../src/openworld/interior-kit';
import { interiorSurface } from '../src/openworld/interior-textures';

const LAIRS = CAVE_SCENES.filter(scene => scene.legendary?.length);
const ROOMS = CAVE_SCENES.filter(scene => scene.room);
const CHAMBERS = CAVE_SCENES.filter(scene => scene.kind === 'cave');
const palette = { floor: '#8e8c87', wall: '#77756f', trim: '#55534e', props: {} };

/** Closed to walking here or within a hand's width of it. */
const closed = (scene: CaveScene, x: number, z: number) => scene.sample(x, z).blocked
  || Array.from({ length: 8 }, (_, step) => step / 8 * Math.PI * 2).some(angle => scene.sample(x + Math.cos(angle) * .15, z + Math.sin(angle) * .15).blocked);

/** Every vertex between ankle and head height stands on ground the partner cannot walk. */
function standsOnClosedGround(scene: CaveScene, geometry: BufferGeometry | undefined) {
  if (!geometry) return;
  const position = geometry.getAttribute('position');
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index), y = position.getY(index) - scene.sample(position.getX(index), position.getZ(index)).height, z = position.getZ(index);
    if (y > .2 && y < 2.2) expect(closed(scene, x, z), `${scene.sceneId} vertex at ${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`).toBe(true);
  }
}

describe('legendary lair shrines', () => {
  it('build a dais at every altar with pillars and braziers only on ground that was already closed', () => {
    for (const scene of LAIRS) {
      const layout = lairLayout(scene)!;
      expect(layout, scene.sceneId).toBeDefined();
      expect(scene.sample(scene.altar!.x, scene.altar!.z).blocked, scene.sceneId).toBe(false);
      expect(layout.braziers, scene.sceneId).toHaveLength(2);
      for (const piece of [...layout.pillars, ...layout.braziers]) {
        expect(scene.sample(piece.x, piece.z).blocked, scene.sceneId).toBe(true);
        expect(Math.hypot(piece.x - scene.altar!.x, piece.z - scene.altar!.z)).toBeGreaterThan(LAIR_DAIS_RADIUS + .5);
        for (const door of sceneDoorways(scene)) expect(Math.hypot(piece.x - door.x, piece.z - door.z)).toBeGreaterThan(3.5);
      }
      const built = lairGeometry(scene, layout, { stone: '#9a978f', trim: '#55534e' }, '#ff88aa', 1.6);
      standsOnClosedGround(scene, built.solid);
      expect(built.fires).toHaveLength(2);
    }
  }, 30_000);

  it('keep the dais and the paved approach under ankle height, so the altar is walked onto', () => {
    for (const scene of LAIRS) {
      const altar = scene.altar!, layout = lairLayout(scene)!;
      const position = lairGeometry(scene, layout, { stone: '#9a978f', trim: '#55534e' }, '#ff88aa', 1.6).solid!.getAttribute('position');
      for (let index = 0; index < position.count; index++) {
        const x = position.getX(index), z = position.getZ(index);
        if (Math.hypot(x - altar.x, z - altar.z) > LAIR_DAIS_RADIUS && closed(scene, x, z)) continue;
        expect(position.getY(index) - scene.sample(x, z).height, scene.sceneId).toBeLessThan(.2);
      }
    }
  });
});

describe('temple and tower dressing', () => {
  it('models furniture and wall-foot dressing without standing anywhere the partner walks', () => {
    for (const scene of ROOMS) {
      standsOnClosedGround(scene, roomProps(scene, palette, 1.6).solid);
      standsOnClosedGround(scene, floorDressing(scene, palette, 1.6).solid);
      for (const spot of wallBandSpots(scene)) {
        expect(scene.sample(spot.x, spot.z).blocked).toBe(true);
        for (const door of sceneDoorways(scene)) expect(Math.hypot(spot.x - door.x, spot.z - door.z)).toBeGreaterThan(3.5);
      }
    }
  }, 60_000);

  it('lights temple floors with braziers or lanterns and bakes tiling surfaces', () => {
    for (const scene of ROOMS.filter(item => ['stone', 'ruins', 'sand'].includes(item.style))) expect(floorDressing(scene, palette, 1.6).fires.length, scene.sceneId).toBeGreaterThan(0);
    for (const scene of ROOMS.filter(item => ['pagoda', 'bell'].includes(item.style))) expect(roomProps(scene, palette, 1.6).lanterns.length, scene.sceneId).toBeGreaterThan(0);
    const flagstone = interiorSurface('flagstone');
    expect(flagstone.map.image.width).toBe(256);
    expect(interiorSurface('flagstone')).toBe(flagstone);
    const bevelled = chamferBox(1, .5, 2, .08);
    expect(bevelled.getAttribute('position').count).toBe(96);
    bevelled.computeBoundingBox();
    expect(bevelled.boundingBox!.max.toArray()).toEqual([.5, .25, 1]);
  });
});

describe('cave crystals and puddles', () => {
  it('grow crystals from the closed foot of the walls and pool water on open floor', () => {
    let puddles = 0;
    for (const scene of CHAMBERS) {
      const clusters = caveCrystals(scene);
      expect(clusters.length, scene.sceneId).toBeGreaterThan(3);
      for (const cluster of clusters) expect(scene.sample(cluster.x, cluster.z).blocked).toBe(true);
      for (const puddle of cavePuddles(scene)) {
        puddles++;
        expect(scene.sample(puddle.x, puddle.z).blocked).toBe(false);
        for (const door of sceneDoorways(scene)) expect(Math.hypot(puddle.x - door.x, puddle.z - door.z)).toBeGreaterThan(4);
        if (scene.altar) expect(Math.hypot(puddle.x - scene.altar.x, puddle.z - scene.altar.z)).toBeGreaterThan(5);
      }
    }
    expect(puddles).toBeGreaterThan(CHAMBERS.length);
  });
});
