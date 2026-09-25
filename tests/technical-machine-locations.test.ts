import { describe, expect, it } from 'vitest';
import { TECHNICAL_MACHINE_LOCATIONS } from '../src/data/technical-machine-locations';
import { getWorldAtlas, type WorldRegionId } from '../src/openworld/atlas';
import { activeFieldItemPickups } from '../src/openworld/item-sources';
import { getTechnicalMachine } from '../src/game/technical-machines';

describe('technical machines at their version locations', () => {
  it('names only machines the game has and places each region has', () => {
    for (const [region, machines] of Object.entries(TECHNICAL_MACHINE_LOCATIONS)) {
      const ids = new Set(getWorldAtlas(region as WorldRegionId).locations.map(location => location.id));
      for (const [move, places] of Object.entries(machines)) {
        expect(getTechnicalMachine(Number(move)), `${region} move ${move}`).toBeDefined();
        expect(places.length, `${region} move ${move}`).toBeGreaterThan(0);
        for (const place of places) expect(ids.has(place), `${region} ${place}`).toBe(true);
      }
    }
    expect(Object.keys(TECHNICAL_MACHINE_LOCATIONS.hisui)).toEqual([]);
  });

  it('only rolls a machine near where its version finds it', () => {
    // Every roadside slot rolls with all eight badges; across many seeds, Thunder turns up only around the Power Plant.
    const thunderPlaces = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      for (const pickup of activeFieldItemPickups('kanto', seed, {}, 8)) if (pickup.kind === 'technical-machine' && pickup.moveId === 87) thunderPlaces.add(pickup.locationId);
    }
    const atlas = getWorldAtlas('kanto'), plant = atlas.locations.find(location => location.id === 'power-plant')!;
    for (const id of thunderPlaces) {
      const place = atlas.locations.find(location => location.id === id)!;
      expect(id === 'power-plant' || Math.hypot(place.x - plant.x, place.z - plant.z) < 60, id).toBe(true);
    }
  });

  it('keeps Hisui free of machines', () => {
    for (let seed = 1; seed <= 10; seed++) {
      expect(activeFieldItemPickups('hisui', seed, {}, 8).some(pickup => pickup.kind === 'technical-machine')).toBe(false);
    }
  });
});
