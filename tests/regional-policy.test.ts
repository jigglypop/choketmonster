import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { actBattle, challengeCampaignGym, claimRegionalStarter, createGame, createMonster, depositMonster, evolve, releaseMonster, restoreGame, serializeGame, swapTeam, useItem, validateGame } from '../src/game/engine';
import { getCampaignGyms } from '../src/game/campaign';
import { monsterRegionalUseReason, monsterRegionalUseTag, needsRegionalStarter, regionalLevelCap } from '../src/game/regional-policy';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;

describe('regional starter and usage policy', () => {
  it('claims each regional starter once and preserves its origin through evolution and save restore', () => {
    const game = createGame(1, 'regional-starter');
    expect(game.claimedRegionalStarters).toEqual(['kanto']);
    expect(needsRegionalStarter(game, 'johto')).toBe(true);
    const starter = claimRegionalStarter(game, 'johto', 152);
    expect(starter).toMatchObject({ speciesId: 152, level: 5, originRegion: 'johto' });
    expect(game.claimedRegionalStarters).toEqual(['kanto', 'johto']);
    expect(() => claimRegionalStarter(game, 'johto', 155)).toThrow(/이미/);
    game.inventory['rare-candy'] = 11; useItem(game, 'rare-candy', starter.instanceId, 11); evolve(game, starter.instanceId);
    expect(starter).toMatchObject({ speciesId: 153, originRegion: 'johto' });
    expect(restoreGame(serializeGame(game)).player.team.find(monster => monster.instanceId === starter.instanceId)?.originRegion).toBe('johto');
  });

  it('blocks foreign use before one badge and applies the local badge level cap without deleting or lowering anyone', () => {
    const game = createGame(1, 'regional-cap'), local = game.player.team[0];
    const foreign = createMonster(game, 152, 20, 'johto'); game.player.team.push(foreign);
    expect(regionalLevelCap(game, 'kanto')).toBe(20);
    expect(monsterRegionalUseReason(game, 'kanto', local)).toBeUndefined();
    expect(monsterRegionalUseReason(game, 'kanto', foreign)).toMatch(/배지 1개/);
    expect(monsterRegionalUseTag(game, 'kanto', local)).toBeUndefined();
    expect(monsterRegionalUseTag(game, 'kanto', foreign)).toBe('타지방 출신');
    local.hp = 0;
    expect(() => challengeCampaignGym(game, 'kanto', getCampaignGyms(game, 'kanto')[0].locationId)).toThrow(/사용할 수 있는/);
    expect(foreign).toMatchObject({ level: 20, originRegion: 'johto' });

    game.defeatedGyms = [1]; game.player.badges = 1;
    expect(regionalLevelCap(game, 'kanto')).toBe(30);
    expect(monsterRegionalUseReason(game, 'kanto', foreign)).toBeUndefined();
    foreign.level = 31;
    expect(monsterRegionalUseReason(game, 'kanto', foreign)).toMatch(/Lv\.30/);
    expect(monsterRegionalUseTag(game, 'kanto', foreign)).toBe('Lv.30 초과');
  });

  it('migrates legacy individuals deterministically to the campaign start region', () => {
    const legacy = createGame(152, 'legacy-origin');
    const second = createMonster(legacy, 1, 5, 'kanto'); legacy.player.box.push(second);
    delete legacy.claimedRegionalStarters;
    for (const monster of [...legacy.player.team, ...legacy.player.box]) delete monster.originRegion;
    validateGame(legacy);
    expect(legacy.claimedRegionalStarters).toEqual(['johto']);
    expect([...legacy.player.team, ...legacy.player.box].map(monster => monster.originRegion)).toEqual(['johto', 'johto']);
  });

  it('freezes battle growth at the local cap and resumes after the next badge', () => {
    const game = createGame(1, 'regional-growth-cap'), monster = createMonster(game, 1, 20, 'kanto');
    game.player.team = [monster];
    const finishBattle = () => {
      const enemy = createMonster(game, 150, 100, 'kanto'); enemy.hp = 0;
      game.battle = { kind: 'wild', regionId: game.regionId, policyRegion: 'kanto', canRun: true, turn: 1,
        player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 } };
      return actBattle(game, { type: 'wait' }, 4);
    };
    const cappedXp = monster.xp;
    expect(finishBattle().experienceGains).toEqual([]);
    expect(monster).toMatchObject({ level: 20, xp: cappedXp });
    game.player.badges = 1; game.defeatedGyms = [1];
    expect(finishBattle().experienceGains[0]?.amount).toBeGreaterThan(0);
    expect(monster.level).toBeGreaterThan(20);
    expect(monster.level).toBeLessThanOrEqual(30);
  });

  it('pauses a newly reached region until selection and then follows the eligible local starter', () => {
    const game = createGame(1, 'regional-arrival'), world = new OpenWorldSimulation(graph, game, 411);
    world.changeRegion('johto');
    expect(world.regionalStarterRequired).toBe(true);
    const before = structuredClone(world.player);
    expect(world.step({ deltaSeconds: 1 }).battleActive).toBe(false);
    expect(world.player).toEqual(before);
    const starter = world.claimRegionalStarter(152);
    expect(world.regionalStarterRequired).toBe(false);
    expect(world.entities.find(entity => entity.kind === 'companion')?.id).toBe(`companion:${starter.instanceId}`);
  });

  it('enforces candy growth and keeps one usable local member while placing a full-team starter in the team', () => {
    const game = createGame(1, 'regional-softlock');
    game.inventory['rare-candy'] = 16;
    useItem(game, 'rare-candy', game.player.team[0].instanceId, 15, 'kanto');
    const candyBefore = game.inventory['rare-candy'];
    expect(() => useItem(game, 'rare-candy', game.player.team[0].instanceId, 1, 'kanto')).toThrow(/Lv\.20/);
    expect(game.inventory['rare-candy']).toBe(candyBefore);

    const foreign = createMonster(game, 152, 5, 'johto'); game.player.team.push(foreign);
    game.player.box.push(createMonster(game, 155, 5, 'johto'));
    game.dex.seen = game.dex.caught = [1, 152];
    expect(() => depositMonster(game, 0, 'kanto')).toThrow(/한 마리/);
    expect(() => releaseMonster(game, game.player.team[0].instanceId, 'kanto')).toThrow(/마지막/);
    expect(() => swapTeam(game, 0, 0, 'kanto')).toThrow(/한 마리/);

    while (game.player.team.length < 6) game.player.team.push(createMonster(game, 1, 5, 'kanto'));
    const movedId = game.player.team.at(-1)!.instanceId;
    const johtoStarter = claimRegionalStarter(game, 'johto', 152);
    expect(game.player.team).toHaveLength(6);
    expect(game.player.team).toContain(johtoStarter);
    expect(game.player.box.some(monster => monster.instanceId === movedId)).toBe(true);
  });
});
