import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { getSpecies } from '../src/data/pokemon';
import { advanceEggProgress, breedingCompatibility, createEgg, hatchEgg } from '../src/game/breeding';
import { actBattle, createGame, createMonster, experienceAtLevel, mergeDuplicateMonsters, previewDuplicateMerge, releaseMonster, restoreGame, serializeGame, statsFor, validateGame } from '../src/game/engine';
import { defaultView, packSave, unpackSave } from '../src/game/storage';
import { evolutionProgress } from '../src/game/evolution-progress';

const graph = JSON.parse(readFileSync(new URL('../public/data/connectome.json', import.meta.url), 'utf8')) as Graph;

describe('교배, 알, 전투 중 컬렉션 규칙', () => {
  it('raises battle XP to 150 percent of the classic base formula', () => {
    const game = createGame(1, 'xp-boost'), enemy = createMonster(game, 19, 20); enemy.hp = 0;
    game.battle = { kind: 'wild', regionId: game.regionId, canRun: true, turn: 1, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 } };
    const result = actBattle(game, { type: 'wait' }, 4);
    expect(result.experienceGains[0].amount).toBe(Math.floor(getSpecies(19).baseExperience * 20 * 1.5 / 7));
  });

  it('uses source egg groups, gender and Ditto rules', () => {
    const game = createGame(1, 'compatibility');
    const female = createMonster(game, 1, 20), male = createMonster(game, 7, 20), ditto = createMonster(game, 132, 20), genderless = createMonster(game, 81, 20), undiscovered = createMonster(game, 150, 20);
    female.gender = 'female'; male.gender = 'male';
    expect(breedingCompatibility(female, male)).toMatchObject({ compatible: true, offspringSpeciesId: 1 });
    expect(breedingCompatibility(genderless, ditto)).toMatchObject({ compatible: true, offspringSpeciesId: 81 });
    expect(breedingCompatibility(genderless, female).compatible).toBe(false);
    expect(breedingCompatibility(undiscovered, ditto).compatible).toBe(false);
    game.player.box.push(ditto);
    const manaphy = createMonster(game, 490, 20); game.player.box.push(manaphy);
    expect(createEgg(game, manaphy.instanceId, ditto.instanceId, graph).speciesId).toBe(489);

    const nidoranFemale = createMonster(game, 29, 20), nidoranMale = createMonster(game, 32, 20);
    nidoranFemale.gender = 'female'; nidoranMale.gender = 'male'; game.player.box.push(nidoranFemale, nidoranMale);
    expect([29, 32]).toContain(createEgg(game, nidoranFemale.instanceId, nidoranMale.instanceId, graph).speciesId);

    const illumise = createMonster(game, 314, 20), volbeat = createMonster(game, 313, 20);
    illumise.gender = 'female'; volbeat.gender = 'male'; game.player.box.push(illumise, volbeat);
    expect([313, 314]).toContain(createEgg(game, illumise.instanceId, volbeat.instanceId, graph).speciesId);
  });

  it('persists an egg, advances only explicit walking steps and hatches a unique level-one brain', () => {
    const game = createGame(1, 'egg-save'), first = game.player.team[0], second = createMonster(game, 1, 20);
    first.gender = 'female'; second.gender = 'male'; game.player.box.push(second);
    const egg = createEgg(game, first.instanceId, second.instanceId, graph), seed = egg.brain.seed;
    expect(egg.requiredSteps).toBe(256 * 21);
    expect(advanceEggProgress(game, egg.requiredSteps - 1)).toEqual([]);
    expect(restoreGame(serializeGame(game)).nursery?.[0].brain.graph.id).toBe(graph.id);
    const packed = packSave(game, graph, defaultView());
    expect((packed.game as typeof game).nursery?.[0].brain.graph).toBeUndefined();
    const restored = unpackSave(packed, graph).game;
    expect(restored.nursery?.[0].steps).toBe(egg.requiredSteps - 1);
    expect(advanceEggProgress(restored, 1).map(item => item.eggId)).toEqual([egg.eggId]);
    restored.versionCaught = { red: [] };
    const child = hatchEgg(restored, egg.eggId);
    expect(child).toMatchObject({ speciesId: 1, level: 1, xp: 0 });
    expect(Object.values(child.ivs!)).toHaveLength(6); expect(child.ability?.slot).toBeGreaterThan(0);
    expect(child.stats).toEqual(statsFor(getSpecies(1), 1, child.ivs));
    expect(evolutionProgress(child).gender).toBe(child.gender);
    expect(child.brain?.seed).toBe(seed); expect(child.brain?.seed).not.toBe(first.brain?.seed);
    expect(restored.nursery).toEqual([]); expect(restored.dex.caught).toContain(1);
    expect(restored.versionCaught.red).toContain(1);
    validateGame(restored);
  });

  it('keeps the active identity and last healthy teammate safe during battle merges and releases', () => {
    const game = createGame(1, 'battle-collection'), target = game.player.team[0], bench = createMonster(game, 4, 20), active = createMonster(game, 7, 20);
    const donorLow = createMonster(game, 1, 20), donorHigh = createMonster(game, 1, 40);
    game.player.team = [target, bench, active]; game.player.box = [donorLow, donorHigh];
    game.battle = { kind: 'wild', regionId: game.regionId, canRun: true, turn: 3, player: { team: game.player.team, activeIndex: 2 }, enemy: { team: [createMonster(game, 19, 10)], activeIndex: 0 } };
    const turn = game.battle.turn, activeId = active.instanceId, targetBrain = target.brain;
    const plan = mergeDuplicateMonsters(game, target.instanceId, [donorLow.instanceId, donorHigh.instanceId]);
    expect(plan).toMatchObject({ highestDonorLevel: 40, baselineLevel: 40, bonusLevels: 2, totalLevels: 37, gainedLevels: 37, toLevel: 42 });
    expect(game.battle.player.team).toBe(game.player.team); expect(game.player.team[game.battle.player.activeIndex].instanceId).toBe(activeId);
    expect(game.battle.turn).toBe(turn); expect(target.brain).toBe(targetBrain);
    releaseMonster(game, bench.instanceId);
    expect(game.player.team[game.battle.player.activeIndex].instanceId).toBe(activeId);
    expect(() => releaseMonster(game, activeId)).toThrow(/출전/);
    active.hp = 0; game.battle.awaitingSwitch = 'player';
    expect(() => releaseMonster(game, target.instanceId)).toThrow(/마지막/);
    validateGame(game);
  });

  it('uses the highest participant baseline once while preserving target brain and fractional XP progress', () => {
    const game = createGame(1, 'merge-highest'), target = createMonster(game, 1, 10), donor = createMonster(game, 1, 80);
    game.player.box.push(target, donor);
    const start = experienceAtLevel(10, 'medium-slow'), next = experienceAtLevel(11, 'medium-slow');
    target.xp = start + Math.floor((next - start) / 2);
    const progress = (target.xp - start) / (next - start);
    const brain = target.brain, plan = previewDuplicateMerge(game, target.instanceId, [donor.instanceId]);
    expect(plan).toMatchObject({ baselineLevel: 80, bonusLevels: 4, toLevel: 84, gainedLevels: 74 });
    mergeDuplicateMonsters(game, target.instanceId, [donor.instanceId]);
    const level84 = experienceAtLevel(84, 'medium-slow'), level85 = experienceAtLevel(85, 'medium-slow');
    expect(target.level).toBe(84);
    expect(target.xp).toBe(level84 + Math.floor(progress * (level85 - level84)));
    expect(target.xp).toBeGreaterThan(level84); expect(target.xp).toBeLessThan(level85);
    expect(target.brain).toBe(brain);
  });
});
