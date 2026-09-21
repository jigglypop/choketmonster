import { describe, expect, it } from 'vitest';
import { Brain } from '../src/core/brain';
import { calculateDamage } from '../src/game/battle';
import { getMove, getSpecies } from '../src/data/pokemon';
import {
  activateBattleTransformation, assignAlolaForm, assignHeldTool, assignMonsterAbility, captureDefeatedWild, createGame, createMonster, evolve,
  evolutionPurchaseQuote, ITEM_PRICES, mergeCollectionDuplicates,
  previewCollectionMerge, restoreGame, serializeGame, setAutoMergeDuplicates, statsFor,
} from '../src/game/engine';

describe('collection merge options', () => {
  it('freezes and merges every duplicate species while retaining each survivor identity and brain', () => {
    const game = createGame(1, 'collection-merge');
    const bulbasaur = game.player.team[0], bulbasaurBrain = new Brain(1).snapshot();
    bulbasaur.brain = bulbasaurBrain;
    const secondBulbasaur = createMonster(game, 1, 30), pikachu = createMonster(game, 25, 8), secondPikachu = createMonster(game, 25, 12);
    game.player.box.push(secondBulbasaur, pikachu, secondPikachu);
    const plan = previewCollectionMerge(game, undefined, pikachu.instanceId);
    expect(plan.totalDonors).toBe(2);
    expect(plan.groups.map(group => group.targetId)).toContain(pikachu.instanceId);
    mergeCollectionDuplicates(game, plan);
    expect([...game.player.team, ...game.player.box].filter(monster => monster.speciesId === 1)).toHaveLength(1);
    expect([...game.player.team, ...game.player.box].filter(monster => monster.speciesId === 25)).toHaveLength(1);
    expect(game.player.team[0].instanceId).toBe(bulbasaur.instanceId);
    expect(game.player.team[0].brain).toBe(bulbasaurBrain);
  });

  it('automatically merges a captured duplicate into the stable owned survivor and persists the option', () => {
    const game = createGame(1, 'auto-merge'), survivor = game.player.team[0];
    survivor.brain = new Brain(1).snapshot();
    const captured = createMonster(game, 1, 20); captured.hp = 0;
    game.captureOffer = captured; setAutoMergeDuplicates(game, true);
    expect(captureDefeatedWild(game, 'poke-ball')).toBe(true);
    expect([...game.player.team, ...game.player.box].filter(monster => monster.speciesId === 1)).toEqual([survivor]);
    expect(survivor.brain).toEqual(new Brain(1).snapshot());
    expect(restoreGame(serializeGame(game)).autoMergeDuplicates).toBe(true);
  });

  it('removes duplicate donors even when the stable survivor is already level 100', () => {
    const game = createGame(1, 'max-level-merge'), survivor = createMonster(game, 25, 100), donor = createMonster(game, 25, 40);
    game.player.box.push(survivor, donor);
    const plan = previewCollectionMerge(game, undefined, survivor.instanceId);
    expect(plan.groups.find(group => group.speciesId === 25)).toMatchObject({ targetId: survivor.instanceId, toLevel: 100, gainedXp: 0 });
    mergeCollectionDuplicates(game, plan);
    expect(game.player.box.filter(monster => monster.speciesId === 25)).toEqual([survivor]);
  });
});

describe('transactional evolution purchases', () => {
  it('quotes and buys a missing item in the same evolution transaction', () => {
    const game = createGame(1, 'auto-buy'), onix = createMonster(game, 95, 30);
    game.player.team = [onix]; game.player.money = ITEM_PRICES['metal-coat'];
    const steelix = getSpecies(95).evolutions.find(item => item.target === 208)!;
    expect(evolutionPurchaseQuote(game, onix, steelix, 'metal-coat')).toMatchObject({ ready: false, requiredItem: 'metal-coat', missing: 1, affordable: true });
    evolve(game, onix.instanceId, { targetId: 208, item: 'metal-coat', autoBuyMissing: true });
    expect(onix.speciesId).toBe(208); expect(game.player.money).toBe(0); expect(game.inventory['metal-coat']).toBe(0);
  });

  it('does not mutate money, stock, or identity when the automatic purchase is unaffordable', () => {
    const game = createGame(1, 'auto-buy-fail'), onix = createMonster(game, 95, 30);
    game.player.team = [onix]; game.player.money = ITEM_PRICES['metal-coat'] - 1;
    const before = serializeGame(game);
    expect(() => evolve(game, onix.instanceId, { targetId: 208, item: 'metal-coat', autoBuyMissing: true })).toThrow();
    expect(serializeGame(game)).toBe(before);
  });
});

describe('held tools', () => {
  it('assigns one tool to one owned individual and applies battle damage effects', () => {
    const game = createGame(1, 'held-tools'), attacker = game.player.team[0], other = createMonster(game, 4, 5);
    game.player.box.push(other); assignHeldTool(game, attacker.instanceId, 'focus-sash');
    assignHeldTool(game, other.instanceId, 'focus-sash');
    const move = { ...getMove(33), power: 1000 };
    const stats = { hp: 100, attack: 100, defense: 100, specialAttack: 100, specialDefense: 100, speed: 100 };
    expect(calculateDamage({ level: 100, hp: 100, stats, types: ['normal'] }, { level: 5, hp: 100, stats, types: ['normal'], heldTool: 'focus-sash' }, move, 1).damage).toBe(99);
    expect(restoreGame(serializeGame(game)).player.team[0].heldTool).toBe('focus-sash');
  });

  it('assigns only a canonical ability slot and persists its identity', () => {
    const game = createGame(1, 'ability-assignment'), monster = game.player.team[0];
    const assigned = assignMonsterAbility(game, monster.instanceId, 3);
    expect(assigned.slot).toBe(3);
    expect(restoreGame(serializeGame(game)).player.team[0].ability).toEqual(assigned);
    expect(() => assignMonsterAbility(game, monster.instanceId, 2)).toThrow();
  });
});

describe('battle forms', () => {
  it('uses canonical Mega stats and limits Mega evolution to once per battle', () => {
    const game = createGame(4, 'mega-battle'), charizard = createMonster(game, 6, 50), enemy = createMonster(game, 7, 50);
    game.player.team = [charizard];
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
    const mega = activateBattleTransformation(game, 'mega', { formIdentifier: 'charizard-mega-x' });
    expect(mega).toMatchObject({ kind: 'mega', formIdentifier: 'charizard-mega-x', types: ['fire', 'dragon'] });
    expect(mega.stats.attack).toBeGreaterThan(charizard.stats.attack);
    expect(() => activateBattleTransformation(game, 'mega')).toThrow();
    expect(() => restoreGame(serializeGame(game))).not.toThrow();
  });

  it('applies real tera typing and same-type 2x STAB', () => {
    const stats = { hp: 100, attack: 100, defense: 100, specialAttack: 100, specialDefense: 100, speed: 100 };
    const move = { ...getMove(33), power: 80, type: 'normal' as const };
    const ordinary = calculateDamage({ level: 50, hp: 100, stats, types: ['normal'] }, { level: 50, hp: 100, stats, types: ['normal'] }, move, 1).damage;
    const tera = calculateDamage({ level: 50, hp: 100, stats, types: ['normal'], originalTypes: ['normal'], teraType: 'normal' }, { level: 50, hp: 100, stats, types: ['normal'] }, move, 1).damage;
    expect(tera).toBeGreaterThan(ordinary);
    const electricMove = { ...move, type: 'electric' as const };
    const originalStabAfterWaterTera = calculateDamage({ level: 50, hp: 100, stats, types: ['water'], originalTypes: ['electric'], teraType: 'water' }, { level: 50, hp: 100, stats, types: ['normal'] }, electricMove, 1).damage;
    const noStab = calculateDamage({ level: 50, hp: 100, stats, types: ['water'], originalTypes: ['normal'], teraType: 'water' }, { level: 50, hp: 100, stats, types: ['normal'] }, electricMove, 1).damage;
    expect(originalStabAfterWaterTera).toBeGreaterThan(noStab);
  });

  it('persists a canonical Alola form and rejects it on the wrong species', () => {
    const game = createGame(1, 'alola-form'), raichu = createMonster(game, 26, 30), bulbasaur = game.player.team[0];
    game.player.box.push(raichu);
    expect(assignAlolaForm(game, raichu.instanceId, true)).toBe('raichu-alola');
    expect(raichu.stats.specialAttack).not.toBe(statsFor(getSpecies(26), raichu.level, raichu.ivs).specialAttack);
    expect(raichu.ability?.slug).toBe('surge-surfer');
    expect(restoreGame(serializeGame(game)).player.box[0].regionalForm).toBe('raichu-alola');
    expect(() => assignAlolaForm(game, bulbasaur.instanceId, true)).toThrow();
  });
});
