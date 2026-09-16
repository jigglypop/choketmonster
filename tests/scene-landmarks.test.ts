import { describe, expect, it } from 'vitest';
import { LEAGUE_LOCATION_IDS, gateVisualState, gymVisualState, isRegionalLeagueLocation } from '../src/openworld/scene-landmarks';
import { KANTO_GATES, KANTO_GYMS } from '../src/openworld/kanto';

describe('world progression landmarks', () => {
  it('derives visible road gate locks from the same required-badge data as traversal', () => {
    for (const gate of KANTO_GATES) {
      expect(gateVisualState(gate.requiredBadges, gate.requiredBadges - 1).locked).toBe(true);
      expect(gateVisualState(gate.requiredBadges, gate.requiredBadges).locked).toBe(false);
    }
  });

  it('treats gym level as a recommendation and locks only out-of-order gyms', () => {
    for (const gym of KANTO_GYMS) {
      expect(gymVisualState(gym, gym.badge - 1)).toMatchObject({ status: 'available', recommendedLevel: gym.level });
      if (gym.badge > 1) expect(gymVisualState(gym, gym.badge - 2).status).toBe('locked');
      expect(gymVisualState(gym, gym.badge).status).toBe('cleared');
    }
  });

  it('maps every implemented regional league to its campaign destination', () => {
    expect(LEAGUE_LOCATION_IDS).toEqual({ johto: 'tohjo-falls', kanto: 'indigo-plateau', hoenn: 'ever-grande-city', sinnoh: 'sinnoh-pokemon-league', unova: 'unova-pokemon-league', kalos: 'kalos-pokemon-league', alola: 'alola-pokemon-league', galar: 'galar-pokemon-league', hisui: 'temple-of-sinnoh', paldea: 'paldea-pokemon-league' });
    for (const [region, location] of Object.entries(LEAGUE_LOCATION_IDS)) expect(isRegionalLeagueLocation(region, location!)).toBe(true);
  });
});
