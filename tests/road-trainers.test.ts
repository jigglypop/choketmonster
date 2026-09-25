import { describe, expect, it } from 'vitest';
import { fieldTrainersAt } from '../src/data/field-trainers';
import { getWorldAtlas } from '../src/openworld/atlas';
import { roadTrainers } from '../src/openworld/road-trainers';

const REGIONS = ['kanto', 'johto', 'hoenn', 'sinnoh', 'unova', 'kalos', 'alola'];

describe('road trainers', () => {
  it('stand on open ground of their own route, apart, in more than one figure', { timeout: 60_000 }, () => {
    for (const region of REGIONS) {
      const atlas = getWorldAtlas(region), trainers = roadTrainers(atlas);
      expect(trainers.length, region).toBeGreaterThan(0);
      for (const entry of trainers) {
        expect(atlas.sample(entry.x, entry.z).blocked, `${region}:${entry.trainer.id}`).toBe(false);
        expect(fieldTrainersAt(region, atlas.locationAt(entry.x, entry.z).id), `${region}:${entry.trainer.id}`).toContain(entry.trainer);
        for (const other of trainers) if (other !== entry) expect(Math.hypot(other.x - entry.x, other.z - entry.z)).toBeGreaterThanOrEqual(3.2);
      }
      expect(new Set(trainers.map(entry => entry.model)).size, region).toBeGreaterThanOrEqual(Math.min(3, trainers.length));
    }
  });

  it('dress the nurse and the boy by class', () => {
    const models = new Map(roadTrainers(getWorldAtlas('johto')).map(entry => [entry.trainer.trainerClass, entry.model]));
    expect(models.get('반바지 꼬마')).toContain('/boy.glb');
    expect(models.get('곤충채집소년')).toContain('/boy.glb');
    expect(models.get('아가씨')).toContain('/nurse.glb');
    expect(models.get('등산가')).toContain('/mountain.glb');
  });
});
