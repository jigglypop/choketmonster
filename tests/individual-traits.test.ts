import { describe, expect, it } from 'vitest';
import { getMove, getSpecies } from '../src/data/pokemon';
import { calculateDamage } from '../src/game/battle';
import { abilityForSpecies } from '../src/game/individual-traits';
import { actBattle, challengeGym, createGame, createMonster, evolve, individualValues, mergeDuplicateMonsters, monsterAbility, restoreGame, serializeGame, statsFor, useItem } from '../src/game/engine';

describe('persistent individual values and source abilities', () => {
  it('generates six seeded IVs without consuming the gameplay RNG stream', () => {
    const first = createGame(1, 'trait-seed'), second = createGame(1, 'trait-seed');
    const before = first.rngState;
    const a = createMonster(first, 25, 20), b = createMonster(second, 25, 20);
    expect(first.rngState).toBe(before);
    expect(a.ivs).toEqual(b.ivs); expect(a.ability).toEqual(b.ability);
    expect(Object.values(a.ivs!)).toHaveLength(6);
    expect(Object.values(a.ivs!).every(value => Number.isInteger(value) && value >= 0 && value <= 31)).toBe(true);
    expect(createMonster(first, 25, 20).ivs).not.toEqual(a.ivs);
  });

  it('keeps IV identity and ability slot through candy growth, evolution and save restore', () => {
    const game = createGame(1, 'trait-growth'), monster = game.player.team[0];
    monster.ability = abilityForSpecies(1, 1);
    const ivs = structuredClone(monster.ivs), abilitySlot = monster.ability.slot;
    game.inventory['rare-candy'] = 20;
    useItem(game, 'rare-candy', monster.instanceId, 11);
    expect(monster.stats).toEqual(statsFor(getSpecies(1), 16, monster.ivs));
    evolve(game, monster.instanceId, { targetId: 2 });
    expect(monster.ivs).toEqual(ivs); expect(monster.ability?.slot).toBe(abilitySlot);
    expect(monster.stats).toEqual(statsFor(getSpecies(2), 16, monster.ivs));
    const restored = restoreGame(serializeGame(game)).player.team[0];
    expect(individualValues(restored)).toEqual(ivs); expect(monsterAbility(restored)).toEqual(monster.ability);
  });

  it('migrates legacy monsters once with zero IVs and preserves their exact old stats', () => {
    const game = createGame(4, 'legacy-traits'), legacy = structuredClone(game) as ReturnType<typeof createGame>;
    const monster = legacy.player.team[0], oldStats = statsFor(getSpecies(monster.speciesId), monster.level);
    monster.stats = oldStats; monster.hp = oldStats.hp; delete monster.ivs; delete monster.ability;
    const restored = restoreGame(JSON.stringify(legacy)), migrated = restored.player.team[0];
    expect(migrated.stats).toEqual(oldStats);
    expect(migrated.ivs).toEqual({ hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 });
    expect(restoreGame(serializeGame(restored)).player.team[0].ability).toEqual(migrated.ability);
  });

  it('refreshes derived ability metadata without rejecting an otherwise valid saved source slot', () => {
    const game = createGame(1, 'ability-metadata-migration'), monster = game.player.team[0];
    monster.ability = abilityForSpecies(1, 1);
    monster.ability.name = '이전 번역';
    monster.ability.englishName = 'Previous label';
    monster.ability.effect = 'display-only';
    monster.ability.description = '이전 릴리스에서 저장한 효과 설명';

    const restored = restoreGame(JSON.stringify(game));
    expect(restored.player.team[0].ability).toEqual(abilityForSpecies(1, 1));
  });

  it('refreshes the duplicated active-battle ability metadata with its owned individual', () => {
    const game = createGame(1, 'battle-ability-metadata-migration');
    challengeGym(game, 'safari-meadow');
    game.player.team[0].ability!.description = '이전 릴리스에서 저장한 효과 설명';

    const restored = restoreGame(JSON.stringify(game));
    expect(restored.battle?.player.team[0].ability).toEqual(restored.player.team[0].ability);
    expect(restored.player.team[0].ability).toEqual(abilityForSpecies(1, restored.player.team[0].ability!.slot));
  });

  it('still rejects an ability source identity that does not belong to the species', () => {
    const game = createGame(1, 'ability-source-mismatch');
    game.player.team[0].ability = abilityForSpecies(4, 1);
    expect(() => restoreGame(JSON.stringify(game))).toThrow('특성이 원본 종/슬롯 데이터와 맞지 않습니다.');
  });

  it('keeps the selected individual traits when duplicate XP is merged', () => {
    const game = createGame(7, 'trait-merge'), target = createMonster(game, 25, 10), donor = createMonster(game, 25, 40);
    game.player.box.push(target, donor);
    const ivs = structuredClone(target.ivs), ability = structuredClone(target.ability);
    mergeDuplicateMonsters(game, target.instanceId, [donor.instanceId]);
    expect(target.ivs).toEqual(ivs); expect(target.ability).toEqual(ability);
    expect(target.stats).toEqual(statsFor(getSpecies(25), target.level, target.ivs));
  });

  it('applies starter boosts, Levitate, absorption and Sturdy while marking unsupported traits', () => {
    const stats = { hp: 100, attack: 80, defense: 60, specialAttack: 80, specialDefense: 60, speed: 60 };
    const fireMove = { ...getMove(52), type: 'fire' as const, power: 60, damageClass: 'special' as const };
    const blaze = abilityForSpecies(4, 1);
    const full = calculateDamage({ level: 30, hp: 100, stats, types: ['fire'], ability: blaze }, { level: 30, hp: 100, stats, types: ['normal'] }, fireMove, 1);
    const low = calculateDamage({ level: 30, hp: 33, stats, types: ['fire'], ability: blaze }, { level: 30, hp: 100, stats, types: ['normal'] }, fireMove, 1);
    expect(low.damage).toBeGreaterThan(full.damage); expect(blaze.effect).toBe('implemented');

    const groundMove = { ...getMove(89), type: 'ground' as const, power: 100, damageClass: 'physical' as const };
    expect(calculateDamage({ level: 30, hp: 100, stats, types: ['ground'] }, { level: 30, hp: 100, stats, types: ['poison'], ability: abilityForSpecies(92, 1) }, groundMove, 1))
      .toMatchObject({ damage: 0, multiplier: 0, abilityActivation: 'immunity' });
    const waterMove = { ...getMove(55), type: 'water' as const, power: 65, damageClass: 'special' as const };
    expect(calculateDamage({ level: 30, hp: 100, stats, types: ['water'] }, { level: 30, hp: 50, stats, types: ['water'], ability: abilityForSpecies(134, 1) }, waterMove, 1).abilityActivation).toBe('absorb');
    const sturdy = calculateDamage({ level: 100, hp: 100, stats: { ...stats, attack: 500 }, types: ['fighting'] },
      { level: 5, hp: 100, stats, types: ['rock'], ability: abilityForSpecies(95, 2) }, { ...groundMove, type: 'fighting' }, 1);
    expect(sturdy).toMatchObject({ damage: 99, abilityActivation: 'sturdy' });
    expect(abilityForSpecies(4, 3).effect).toBe('display-only');
  });

  it('heals absorption in battle and blocks secondary effects when an ability makes the move immune', () => {
    const absorbGame = createGame(7, 'ability-absorb'), attacker = absorbGame.player.team[0];
    attacker.moves = [{ moveId: 55, pp: getMove(55).pp }];
    const absorber = createMonster(absorbGame, 134, 20); absorber.ability = abilityForSpecies(134, 1);
    absorber.hp = Math.floor(absorber.stats.hp / 2);
    absorbGame.battle = { kind: 'wild', regionId: absorbGame.regionId, canRun: true, turn: 1,
      player: { team: absorbGame.player.team, activeIndex: 0 }, enemy: { team: [absorber], activeIndex: 0 } };
    const before = absorber.hp, result = actBattle(absorbGame, { type: 'move', index: 0 }, 4);
    expect(absorber.hp).toBe(Math.min(absorber.stats.hp, before + Math.max(1, Math.floor(absorber.stats.hp / 4))));
    expect(result.executedMoves[0]).toMatchObject({ damage: 0, result: 'immune', strategicEffect: true });

    const immuneGame = createGame(1, 'ability-secondary'), groundUser = immuneGame.player.team[0];
    groundUser.moves = [{ moveId: 189, pp: getMove(189).pp }]; // Mud-Slap lowers accuracy on hit.
    const levitating = createMonster(immuneGame, 92, 20); levitating.ability = abilityForSpecies(92, 1);
    immuneGame.battle = { kind: 'wild', regionId: immuneGame.regionId, canRun: true, turn: 1,
      player: { team: immuneGame.player.team, activeIndex: 0 }, enemy: { team: [levitating], activeIndex: 0 } };
    const immune = actBattle(immuneGame, { type: 'move', index: 0 }, 4);
    expect(immune.executedMoves[0]).toMatchObject({ damage: 0, statStageDelta: 0, result: 'immune' });
    expect(immuneGame.battle?.statStages?.[levitating.instanceId]?.accuracy).toBeUndefined();
  });
});
