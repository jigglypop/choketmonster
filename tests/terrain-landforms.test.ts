import { describe, expect, it } from 'vitest';
import { HOENN_LOCATIONS, sampleHoennWorld } from '../src/openworld/hoenn';
import { SINNOH_LOCATIONS, sampleSinnohWorld } from '../src/openworld/sinnoh';
import { ALOLA_LOCATIONS, sampleAlolaWorld } from '../src/openworld/alola';
import { JOHTO_LOCATIONS, sampleJohtoWorld } from '../src/openworld/johto';
import { WORLD_SCALE } from '../src/openworld/world-space';
import { getWorldAtlas } from '../src/openworld/atlas';
import { worldSurfaceColor } from '../src/openworld/materials';

const at = (locations: readonly { id: string; x: number; z: number }[], id: string) => locations.find(location => location.id === id)!;

describe('authored regional landforms', () => {
  it('renders named mountains as raised traversable terrain instead of a cave-only label', () => {
    for (const [locations, id, sample] of [
      [SINNOH_LOCATIONS, 'mt-coronet', sampleSinnohWorld],
      [ALOLA_LOCATIONS, 'vast-poni-canyon', sampleAlolaWorld],
      [JOHTO_LOCATIONS, 'mt-silver', sampleJohtoWorld],
    ] as const) {
      const point = at(locations, id), summit = sample(point.x, point.z), foothill = sample(point.x + 14 * WORLD_SCALE, point.z);
      expect(summit.blocked, id).toBe(false);
      expect(summit.surface, id).toMatch(/mountain|snow/);
      expect(summit.height, id).toBeGreaterThan(foothill.height + 1);
    }
  });

  it('marks the Route 111 desert and Sinnoh and Alola snowfields without changing encounter biomes', () => {
    const desert = at(HOENN_LOCATIONS, 'hoenn-route-111');
    expect(sampleHoennWorld(desert.x, desert.z)).toMatchObject({ surface: 'desert', biome: 'meadow', blocked: false });
    for (const id of ['sinnoh-route-216', 'sinnoh-route-217'] as const) {
      const point = at(SINNOH_LOCATIONS, id);
      expect(sampleSinnohWorld(point.x, point.z)).toMatchObject({ surface: 'snow', biome: 'meadow', blocked: false });
    }
    const lanakila = at(ALOLA_LOCATIONS, 'mount-lanakila');
    expect(sampleAlolaWorld(lanakila.x, lanakila.z)).toMatchObject({ surface: 'snow', biome: 'rock', blocked: false });
  });

  it('keeps textured terrain but gives each landform a distinct vertex tint', () => {
    const atlas = getWorldAtlas('sinnoh'), sample = { height: 0, biome: 'meadow' as const, blocked: false };
    const colors = [undefined, 'mountain', 'snow', 'desert'].map(surface => worldSurfaceColor(atlas, { ...sample, surface } as typeof sample & { surface?: 'mountain' | 'snow' | 'desert' }, 0, 0).getHexString());
    expect(new Set(colors).size).toBe(4);
  });
});
