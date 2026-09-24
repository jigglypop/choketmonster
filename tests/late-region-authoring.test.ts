import { describe, expect, it } from 'vitest';
import { DUNGEON_PLANS } from '../src/openworld/dungeons';
import { createGame, restoreGame, serializeGame, validateGame } from '../src/game/engine';
import { campaignTravelReason, getCampaignGyms, getNextCampaignTrainer, recordCampaignGymVictory, recordCampaignLeagueVictory, validateExpansionCampaign } from '../src/game/campaign';
import { expansionEncounterPoolOrigin, expansionEncounterPools } from '../src/data/expansion-encounters';
import { chooseExpansionEncounter, expansionSupplementalRules } from '../src/data/expansion-spawns';
import { getWorldAtlas } from '../src/openworld/atlas';
import { isPlayableWorldRegion } from '../src/openworld/availability';

const definitions = [
  { id: 'galar' as const, league: 'galar-pokemon-league', native: [810, 898] as const },
  { id: 'hisui' as const, league: 'temple-of-sinnoh', native: [899, 905] as const },
  { id: 'paldea' as const, league: 'paldea-pokemon-league', native: [906, 1025] as const },
];

describe('Galar, Hisui and Paldea authored regions', () => {
  for (const definition of definitions) it(`${definition.id} has a connected collision-tested 3D traversal graph`, () => {
    const atlas = getWorldAtlas(definition.id), ids = new Set(atlas.locations.map(location => location.id));
    expect(atlas.mapVersion).toBe(`${definition.id}-authored-v1`);
    expect(ids.has(definition.league)).toBe(true);
    expect(atlas.gyms.map(gym => gym.badge)).toEqual([1,2,3,4,5,6,7,8]);
    const graph = new Map<string, string[]>();
    for (const [from, to] of atlas.connections) {
      expect(ids.has(from)).toBe(true); expect(ids.has(to)).toBe(true);
      graph.set(from, [...(graph.get(from) ?? []), to]); graph.set(to, [...(graph.get(to) ?? []), from]);
      const a=atlas.locations.find(location=>location.id===from)!,b=atlas.locations.find(location=>location.id===to)!;
      for(let step=0;step<=20;step++){const t=step/20,x=a.x+(b.x-a.x)*t,z=a.z+(b.z-a.z)*t;expect(atlas.sample(x,z).blocked,`${definition.id}:${from}->${to}@${step}`).toBe(false);}
      expect(atlas.evaluateTraversal(a,b,8).allowed).toBe(true);
    }
    const reached = new Set<string>(), queue = [atlas.locations[0].id];
    while (queue.length) { const id = queue.shift()!; if (reached.has(id)) continue; reached.add(id); queue.push(...(graph.get(id) ?? [])); }
    for (const location of atlas.locations) {
      expect(reached.has(location.id)).toBe(true);
      expect(atlas.sample(location.x, location.z).blocked).toBe(false);
      expect(atlas.nearestWalkable(location.x, location.z, 8)).toBeDefined();
    }
    for (const town of atlas.locations.filter(location => location.kind === 'town')) {
      for (const [dx, dz] of atlas.buildingOffsets(town)) expect(atlas.sample(town.x + dx, town.z + dz).blocked).toBe(true);
    }
    // Runtime admission is independent from the source label retained by each model.
    expect(isPlayableWorldRegion(definition.id)).toBe(true);
  });

  it('keeps PokeAPI Galar rows as source and labels Hisui/Paldea authored encounters supplemental', () => {
    const galar = expansionEncounterPools('galar', 'galar-route-1', 'walk', 'day');
    expect(galar.length).toBeGreaterThan(0); expect(galar.every(pool => expansionEncounterPoolOrigin(pool) === 'source')).toBe(true);
    for (const [region, locationId] of [['hisui','aspiration-hill'],['paldea','south-province-area-one']] as const) {
      const pools = expansionEncounterPools(region, locationId, 'walk', 'day');
      expect(pools.length).toBe(1); expect(expansionEncounterPoolOrigin(pools[0])).toBe('supplemental');
      const encounter = chooseExpansionEncounter(region, locationId, 'day', 'meadow', 8, 1, () => 0, { min: 2, max: 70 });
      expect(encounter.origin).toBe('supplemental');
    }
  });

  it('provides every late-generation native species through source or explicit rare supplements', () => {
    for (const { id, native: [first, last] } of definitions) {
      const atlas = getWorldAtlas(id);
      const base = new Set(atlas.locations.flatMap(location => expansionEncounterPools(id, location.id).flatMap(pool => pool.slots.map(slot => slot.speciesId))));
      const supplement = new Set(expansionSupplementalRules(id).map(rule => rule.speciesId));
      // Legendary and mythical species wait in lairs instead of rare slots.
      const lairs = new Set(DUNGEON_PLANS.flatMap(plan => plan.legendary ?? []));
      for (let speciesId = first; speciesId <= last; speciesId++) expect(base.has(speciesId) || supplement.has(speciesId) || lairs.has(speciesId), `${id}:${speciesId}`).toBe(true);
    }
  });

  it('runs and saves the sequential Galar, Hisui and Paldea campaign contract', () => {
    let game = createGame(1, 'late-regions');
    game.defeatedGyms=[1,2,3,4,5,6,7,8]; game.player.badges=8; game.championDefeated = true;
    game.campaign = { startRegion:'kanto', johtoBadges:[], johtoLeague:0, kantoLeague:5, redDefeated:false, expansion: {
      hoenn:{badges:[1,2,3,4,5,6,7,8],league:5}, sinnoh:{badges:[1,2,3,4,5,6,7,8],league:5}, unova:{badges:[1,2,3,4,5,6,7,8],league:5},
      kalos:{badges:[1,2,3,4,5,6,7,8],league:5}, alola:{badges:[1,2,3,4,5,6,7,8],league:5},
    }};
    for (const { id } of definitions) {
      expect(campaignTravelReason(game, id)).toBeUndefined();
      for (const gym of getCampaignGyms(game, id)) recordCampaignGymVictory(game, id, gym.badge);
      for (let stage=0; stage<5; stage++) {
        const trainer=getNextCampaignTrainer(game,id); expect(trainer?.region).toBe(id); recordCampaignLeagueVictory(game,trainer!);
      }
      game=restoreGame(serializeGame(game)); validateExpansionCampaign(game); validateGame(game);
    }
  });
});
