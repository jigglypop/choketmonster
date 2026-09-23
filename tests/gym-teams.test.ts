import { describe, expect, it } from 'vitest';
import { getSpecies } from '../src/data/pokemon';
import { CAMPAIGN_REGIONS, getCampaignGyms } from '../src/game/campaign';
import { createGame } from '../src/game/engine';
import { GYM_TEAMS, gymTeam } from '../src/game/gym-teams';

describe('gym leader parties', () => {
  const game = createGame(1, 'gym-teams');

  for (const region of CAMPAIGN_REGIONS) it(`${region} has a source party for each of its eight gyms`, () => {
    expect(Object.keys(GYM_TEAMS[region]).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const gyms = getCampaignGyms(game, region);
    expect(gyms.map(gym => gym.badge)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const gym of gyms) {
      const party = gymTeam(region, gym.badge)!;
      expect(party).toBe(GYM_TEAMS[region][gym.badge]);
      expect(party.length).toBeGreaterThanOrEqual(1); expect(party.length).toBeLessThanOrEqual(6);
      for (const [speciesId, level] of party) {
        expect(Number.isInteger(level) && level >= 1 && level <= 100).toBe(true);
        expect(getSpecies(speciesId).id).toBe(speciesId);
      }
      expect(party.at(-1)).toEqual([gym.speciesId, gym.level]);
    }
  });

  it('returns nothing for unknown regions or badges', () => {
    expect(gymTeam('orre', 1)).toBeUndefined();
    expect(gymTeam('toString', 1)).toBeUndefined();
    expect(gymTeam('kanto', 9)).toBeUndefined();
  });
});
