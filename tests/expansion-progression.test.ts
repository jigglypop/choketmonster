import { readFileSync } from 'node:fs';
import { DUNGEON_PLANS } from '../src/openworld/dungeons';
import { describe, expect, it } from 'vitest';
import { createGame, createMonster, heal, challengeCampaignGym, challengeCampaignTrainer, actBattle, serializeGame, restoreGame, validateGame, type GameState } from '../src/game/engine';
import { campaignTravelReason, getCampaignGyms, getRegionalBadges } from '../src/game/campaign';
import { OpenWorldSimulation, serializeOpenWorld, restoreOpenWorld, regionalEncounters } from '../src/openworld/simulation';
import { nextDestinationGuide } from '../src/openworld/next-destination';
import { getMove, getSpecies } from '../src/data/pokemon';
import { calculateDamage } from '../src/game/battle';
import { expansionSourceSpeciesIds, expansionSupplementalRules } from '../src/data/expansion-spawns';
import { isPlayableSpecies } from '../src/openworld/availability';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
function previousCampaignCleared(): GameState {
  const game = createGame(152, 'expansion-progression');
  game.player.badges = 8; game.defeatedGyms = [1,2,3,4,5,6,7,8]; game.championDefeated = true;
  Object.assign(game.campaign!, { johtoBadges: [1,2,3,4,5,6,7,8], johtoLeague: 5, kantoLeague: 5 });
  game.player.team = [150,149,130,6,3,9].map(id => createMonster(game, id, 100));
  game.dex.caught = [...new Set([...game.dex.caught, ...game.player.team.map(mon => mon.speciesId)])].sort((a,b) => a-b);
  game.dex.seen = [...game.dex.caught];
  return game;
}
function winRealBattle(game: GameState) {
  for (let turn = 0; game.battle && turn < 500; turn++) {
    const battle = game.battle, ally = battle.player.team[battle.player.activeIndex], foe = battle.enemy.team[battle.enemy.activeIndex];
    if (battle.awaitingSwitch) { actBattle(game, { type: 'switch', index: game.player.team.findIndex(mon => mon.hp > 0) }); continue; }
    const moves = ally.moves.map((slot, index) => ({ index, score: getMove(slot.moveId).power > 0 ? calculateDamage({ ...ally, types: getSpecies(ally.speciesId).types }, { ...foe, types: getSpecies(foe.speciesId).types }, getMove(slot.moveId), 1).damage : -1 })).sort((a,b) => b.score-a.score);
    const result = actBattle(game, { type: 'move', index: moves[0].index });
    if (result.battleEnded) expect(result.outcome).toBe('won');
  }
  expect(game.battle).toBeUndefined();
}
describe('Hoenn through Alola runtime progression', () => {
  it('plays 24 gyms and 15 league battles with real turns and preserves regional progress across saves', () => {
    let game = previousCampaignCleared();
    expect(campaignTravelReason(game, 'sinnoh')).toContain('호연');
    expect(campaignTravelReason(game, 'unova')).toContain('신오');
    for (const region of ['hoenn', 'sinnoh', 'unova', 'kalos', 'alola'] as const) {
      let world = new OpenWorldSimulation(graph, game, 917);
      world.changeRegion(region); world.setControlMode('manual');
      world.claimRegionalStarter(({hoenn:252,sinnoh:387,unova:495,kalos:650,alola:722} as const)[region]);
      expect(world.rosterStatus().total).toBe(15);
      expect(nextDestinationGuide(game, world.atlas, world.sceneId, world.player).destinationId).toBe(getCampaignGyms(game, region)[0].locationId);
      for (let step = 0; step < 8; step++) world.step({ deltaSeconds: .1, learning: false });
      const restore = restoreOpenWorld(graph, serializeOpenWorld(game, world));
      expect(restore.simulation.regionId).toBe(region);
      expect(restore.simulation.rosterStatus()).toEqual(world.rosterStatus());
      game = restore.game; world = restore.simulation;
      for (const gym of getCampaignGyms(game, region)) {
        game.player.team = [150,149,130,6,3,9].map(id => createMonster(game, id, 20 + (gym.badge - 1) * 10, region));
        game.dex.caught = [...new Set([...game.dex.caught, ...game.player.team.map(mon => mon.speciesId)])].sort((a,b) => a-b); game.dex.seen = [...game.dex.caught];
        heal(game); challengeCampaignGym(game, region, gym.locationId); winRealBattle(game);
        expect(getRegionalBadges(game, region)).toBe(gym.badge);
        game = restoreGame(serializeGame(game));
      }
      game.player.team = [150,149,130,6,3,9].map(id => createMonster(game, id, 100, region));
      game.dex.caught = [...new Set([...game.dex.caught, ...game.player.team.map(mon => mon.speciesId)])].sort((a,b) => a-b); game.dex.seen = [...game.dex.caught];
      for (let stage = 0; stage < 5; stage++) {
        heal(game); challengeCampaignTrainer(game, region);
        game = restoreGame(serializeGame(game)); winRealBattle(game);
        expect(game.campaign!.expansion![region]!.league).toBe(stage + 1);
      }
      validateGame(game);
    }
  }, 50_000);
  it('offers every native species through an original pool or a labeled rare supplement', () => {
    for (const [region, first, last] of [['hoenn',252,386],['sinnoh',387,493],['unova',494,649],['kalos',650,721],['alola',722,809],['galar',810,898],['hisui',899,905],['paldea',906,1025]] as const) {
      // Source means the tables the 3D world spawns from: walk on land places, surf on sea places.
      const source = new Set(expansionSourceSpeciesIds(region));
      const rules = expansionSupplementalRules(region), added = new Set(rules.map(rule => rule.speciesId));
      // Legendary and mythical species wait in lairs instead of rare slots.
      const lairs = new Set(DUNGEON_PLANS.flatMap(plan => plan.legendary ?? []));
      for (let id = first; id <= last; id++) { expect(source.has(id) || added.has(id) || lairs.has(id), `${region}:${id}`).toBe(true); expect(isPlayableSpecies(id)).toBe(true); }
      for (const rule of rules) {
        expect(rule.origin).toBe('supplemental'); expect(source.has(rule.speciesId)).toBe(false);
        expect(regionalEncounters(rule.locationId, 8, region, rule.period, rule.biome)).toContain(rule.speciesId);
      }
    }
  });
});
