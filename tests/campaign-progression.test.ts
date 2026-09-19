import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { getMove, getSpecies } from '../src/data/pokemon';
import { hasPokemonModel } from '../src/data/pokemon-models';
import { actBattle, buyItem, challengeCampaignGym, challengeCampaignTrainer, claimRegionalStarter, createGame, createMonster, depositMonster, duplicateMergeValue, experienceAtLevel, heal, restoreGame, serializeGame, validateGame, withdrawMonster, type GameState } from '../src/game/engine';
import { CAMPAIGN_TRAINERS, campaignProgress, campaignTravelReason, getCampaignGyms, getNextCampaignTrainer, getRegionalBadges, regionalWildLevels } from '../src/game/campaign';
import { calculateDamage } from '../src/game/battle';
import { getWorldAtlas } from '../src/openworld/atlas';
import { OpenWorldSimulation, restoreOpenWorld, serializeOpenWorld } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
function badges(game: GameState, region: 'johto' | 'kanto') {
  if (region === 'johto') game.campaign!.johtoBadges = [1,2,3,4,5,6,7,8];
  else { game.player.badges = 8; game.defeatedGyms = [1,2,3,4,5,6,7,8]; }
}
function trainedTeam(game: GameState, origin: 'johto' | 'kanto', level: number) {
  game.player.team = [150,149,130,6,3,9].map(id => createMonster(game, id, level, origin));
  game.dex.caught = [...new Set([...game.dex.caught, ...game.player.team.map(mon => mon.speciesId)])].sort((a,b) => a-b);
  game.dex.seen = [...new Set([...game.dex.seen, ...game.dex.caught])].sort((a,b) => a-b);
}
function finishWithRealTurns(game: GameState) {
  // Actual seeded opponent turns, HP, PP, type matchups and faint/switch rules.
  let turns = 0;
  while (game.battle && turns++ < 500) {
    const battle = game.battle, self = battle.player.team[battle.player.activeIndex], foe = battle.enemy.team[battle.enemy.activeIndex];
    if (battle.awaitingSwitch) { actBattle(game, { type: 'switch', index: game.player.team.findIndex(mon => mon.hp > 0) }); continue; }
    const choices = self.moves.map((slot, index) => ({ index, score: slot.pp > 0 && getMove(slot.moveId).power > 0
      ? calculateDamage({...self, types:getSpecies(self.speciesId).types}, {...foe, types:getSpecies(foe.speciesId).types}, getMove(slot.moveId), 1).damage : -1 }));
    choices.sort((a,b) => b.score - a.score);
    const result = actBattle(game, { type: 'move', index: choices[0]?.index ?? 0 });
    if (result.battleEnded) expect(result.outcome).toBe('won');
  }
  expect(game.battle).toBeUndefined();
}

describe('regional campaign and growth', () => {
  it('starts Johto partners in New Bark and preserves collection-independent travel gates and saves', () => {
    const game = createGame(152, 'new-johto'), world = new OpenWorldSimulation(graph, game, 211);
    expect(world.regionId).toBe('johto'); expect(world.locationAt(world.player.x, world.player.z).id).toBe('new-bark');
    world.changeVersion('red'); expect(() => world.changeRegion('kanto')).toThrow(/성도/);
    expect(new OpenWorldSimulation(graph, game, 212).regionId).toBe('johto');
    const before = JSON.stringify(game);
    expect(() => challengeCampaignGym(game, 'kanto', 'pewter')).toThrow(/성도/);
    expect(JSON.stringify(game)).toBe(before);
    badges(game, 'johto'); game.campaign!.johtoLeague = 5;
    world.changeRegion('kanto'); expect(world.regionId).toBe('kanto'); expect(game.adventureVersion).toBe('red');
    const restored = restoreOpenWorld(graph, serializeOpenWorld(game, world));
    expect(restored.game.campaign).toEqual(game.campaign); expect(restored.simulation.regionId).toBe('kanto');
    expect(getRegionalBadges(game, 'kanto')).toBe(0); expect(getRegionalBadges(game, 'johto')).toBe(8);
  });

  it('plays both sets of eight gyms, both ordered leagues and Red using real battle turns', () => {
    let game = createGame(155, 'campaign-real-turns');
    expect(() => challengeCampaignTrainer(game, 'johto')).toThrow(/8/);
    for (const region of ['johto', 'kanto'] as const) {
      if (region === 'kanto') claimRegionalStarter(game, region, 1);
      for (const gym of getCampaignGyms(game, region)) {
        trainedTeam(game, region, 20 + (gym.badge - 1) * 10);
        heal(game); challengeCampaignGym(game, region, gym.locationId); finishWithRealTurns(game);
        expect(getRegionalBadges(game, region)).toBe(gym.badge);
        game = restoreGame(serializeGame(game));
      }
      trainedTeam(game, region, 100);
      for (let stage = 0; stage < 5; stage++) {
        heal(game); challengeCampaignTrainer(game, region);
        const saved = serializeGame(game), duplicate = restoreGame(saved);
        finishWithRealTurns(game); finishWithRealTurns(duplicate);
        expect(serializeGame(duplicate)).toBe(serializeGame(game));
        game = restoreGame(serializeGame(game));
      }
      expect(campaignProgress(game)[region === 'johto' ? 'johtoLeague' : 'kantoLeague']).toBe(5);
    }
    expect(getNextCampaignTrainer(game, 'johto')?.id).toBe('red');
    heal(game); challengeCampaignTrainer(game, 'johto'); finishWithRealTurns(game);
    expect(game.campaign!.redDefeated).toBe(true); expect(game.championDefeated).toBe(true);
    expect(getNextCampaignTrainer(game, 'johto')).toBeUndefined(); validateGame(game);
  });

  it('retains the current trainer after a loss and rejects forged stage/region state', () => {
    const game = createGame(158, 'campaign-loss'); badges(game, 'johto');
    challengeCampaignTrainer(game, 'johto'); game.player.team[0].hp = 0;
    expect(actBattle(game, { type: 'wait' }).outcome).toBe('lost');
    expect(game.campaign!.johtoLeague).toBe(0);
    challengeCampaignTrainer(game, 'johto');
    expect(game.battle!.trainerId).toBe('johto-will');
    const forged = structuredClone(game); forged.battle!.trainerId = 'johto-lance'; expect(() => validateGame(forged)).toThrow(/리그/);
    const invalid = structuredClone(game); invalid.campaign!.redDefeated = true; expect(() => validateGame(invalid)).toThrow(/리그/);
  });

  it('conserves legacy balls and permits battle shopping/storage without changing active identity, HP, PP or brain', () => {
    const game = createGame(1, 'battle-storage'); badges(game, 'kanto');
    game.player.team.push(createMonster(game, 4, 20), createMonster(game, 7, 20));
    game.inventory['great-ball'] = 3; game.inventory['ultra-ball'] = 4;
    validateGame(game); expect(game.inventory['poke-ball']).toBe(15);
    validateGame(game); expect(game.inventory['poke-ball']).toBe(15);
    challengeCampaignTrainer(game, 'kanto');
    game.battle!.player.activeIndex = 2;
    const active = game.player.team[2], saved = structuredClone(active), turn = game.battle!.turn;
    expect(() => buyItem(game, 'poke-ball', 5)).toThrow(/판매/); expect(game.inventory['poke-ball']).toBe(15);
    expect(() => buyItem(game, 'ultra-ball')).toThrow();
    depositMonster(game, 0);
    expect(game.battle!.player.activeIndex).toBe(1); expect(game.battle!.player.team[1]).toBe(active);
    expect(() => depositMonster(game, 1)).toThrow(/출전/);
    withdrawMonster(game, 0); expect(active).toEqual(saved); expect(game.battle!.turn).toBe(turn);
    game.dex.caught = [1,4,7]; game.dex.seen = [...new Set([...game.dex.seen, 4,7])].sort((a,b)=>a-b);
    expect(() => restoreGame(serializeGame(game))).not.toThrow();
    const before = JSON.stringify(game); expect(() => depositMonster(game, -1)).toThrow(); expect(JSON.stringify(game)).toBe(before);
  });

  it('limits duplicate merge bonus to 5 percent of the highest participant level without recycling accumulated XP', () => {
    const game = createGame(1, 'rarity');
    const common = duplicateMergeValue(createMonster(game, 19, 20)), rare = duplicateMergeValue(createMonster(game, 113, 20));
    expect(common).toEqual({ levels: 1, percent: 5 }); expect(rare).toEqual(common);
    expect(duplicateMergeValue(createMonster(game, 19, 40))).toEqual({ levels: 2, percent: 5 });
    const same = createMonster(game, 19, 20);
    same.xp += 1000; expect(duplicateMergeValue(same)).toEqual(common);
  });

  it('gives every living teammate equal XP without changing boxed XP', () => {
    const game = createGame(1, 'catch-up'), lead = createMonster(game, 1, 20), lagging = createMonster(game, 4, 5), peer = createMonster(game, 7, 20);
    game.player.team = [lead,lagging,peer]; const enemy = createMonster(game, 19, 20); enemy.hp = 0;
    game.battle = { kind:'wild',regionId:game.regionId,canRun:true,turn:1,player:{team:game.player.team,activeIndex:0},enemy:{team:[enemy],activeIndex:0} };
    const result = actBattle(game, {type:'wait'}, 4), full = result.experienceGains.find(gain=>gain.instanceId===lead.instanceId)!.amount;
    expect(result.experienceGains.find(gain=>gain.instanceId===lagging.instanceId)!.amount).toBe(full);
    expect(result.experienceGains.find(gain=>gain.instanceId===peer.instanceId)!.amount).toBe(full);
  });

  it('rejects a forged ball without consuming inventory, a turn or simulation randomness', () => {
    const game = createGame(152, 'invalid-ball'), enemy = createMonster(game, 19, 5);
    game.battle = { kind:'wild',regionId:game.regionId,canRun:true,turn:1,player:{team:game.player.team,activeIndex:0},enemy:{team:[enemy],activeIndex:0} };
    const before = JSON.stringify(game);
    expect(() => actBattle(game, {type:'catch',ball:'forged'} as never)).toThrow();
    expect(JSON.stringify(game)).toBe(before);
  });

  it('keeps legacy travel and maps intact while making the new Kanto stage stronger and providing every boss model', () => {
    const legacy = createGame(1, 'legacy'); delete legacy.campaign; validateGame(legacy);
    expect(campaignTravelReason(legacy,'kanto')).toBeUndefined();
    const game = createGame(152, 'level-bands'), location = getWorldAtlas('kanto').locations.find(item=>item.id==='route-1')!;
    expect(regionalWildLevels(legacy,'kanto',location)).toEqual({minLevel:2,maxLevel:4});
    expect(regionalWildLevels(game,'kanto',location)).toEqual({minLevel:2,maxLevel:4});
    for (const trainer of CAMPAIGN_TRAINERS) for (const [id, level] of trainer.team) { expect(hasPokemonModel(id),`${trainer.id}: ${id}`).toBe(true); expect(level).toBeLessThanOrEqual(100); }
    expect(experienceAtLevel(100,'medium')).toBe(1000000);
  });
});
