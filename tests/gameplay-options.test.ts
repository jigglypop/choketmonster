import { describe, expect, it } from 'vitest';
import { Brain } from '../src/core/brain';
import { calculateDamage } from '../src/game/battle';
import { getMove, getSpecies } from '../src/data/pokemon';
import { COMBAT_FORMS } from '../src/data/pokemon-combat-forms';
import { getPokemonFormModelSource } from '../src/data/pokemon-form-models';
import { battleTransformationsHtml } from '../src/ui/pokemon-presentation';
import { FIELD_TRAINERS } from '../src/data/field-trainers';
import { automatedMoveMask, battleMoveSenses } from '../src/game/connectome';
import { getMoveLayout } from '../src/game/move-layout';
import {
  actBattle, battleMonsterView, challengeFieldTrainer, experienceAtLevel, useItem, activateBattleTransformation, assignAlolaForm, assignHeldTool, assignMonsterAbility, captureDefeatedWild, createGame, createMonster, evolve,
  evolutionPurchaseQuote, HEALING_ITEM_HP, HELD_TOOL_DESCRIPTIONS, HELD_TOOL_LABELS, HELD_TOOL_PRICES, HELD_TOOLS, ITEM_PRICES, mergeCollectionDuplicates, mergeDuplicateMonsters,
  previewCollectionMerge, releaseMonster, restoreGame, serializeGame, setAutoMergeDuplicates, statsFor, availableMonsterMoveIds, replaceMonsterMove,
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

  it('returns only removed individuals held tools and keeps the survivor equipment', () => {
    const game = createGame(1, 'collection-tools'), target = game.player.team[0];
    const first = createMonster(game, 1, 8), second = createMonster(game, 1, 10), released = createMonster(game, 4, 8);
    target.heldTool = 'leftovers'; first.heldTool = 'focus-sash'; second.heldTool = 'life-orb'; released.heldTool = 'choice-band';
    game.player.box.push(first, second, released);
    mergeDuplicateMonsters(game, target.instanceId, [first.instanceId, second.instanceId]);
    expect(target.heldTool).toBe('leftovers'); expect(game.inventory.leftovers).toBe(0);
    expect(game.inventory['focus-sash']).toBe(1); expect(game.inventory['life-orb']).toBe(1);
    releaseMonster(game, released.instanceId);
    expect(game.inventory['choice-band']).toBe(1);
  });

  it('rejects an overflowing bulk tool return before changing any collection or stock', () => {
    const game = createGame(1, 'collection-tool-overflow');
    const first = createMonster(game, 1, 8), second = createMonster(game, 1, 10);
    first.heldTool = 'focus-sash'; second.heldTool = 'focus-sash'; game.player.box.push(first, second);
    game.inventory['focus-sash'] = 999_999_999;
    const plan = previewCollectionMerge(game), before = serializeGame(game);
    expect(() => mergeCollectionDuplicates(game, plan)).toThrow(/재고가 너무 많습니다/);
    expect(serializeGame(game)).toBe(before);
  });

  it('rejects an overflowing released tool return without removing the individual', () => {
    const game = createGame(1, 'release-tool-overflow'), released = createMonster(game, 4, 8);
    released.heldTool = 'focus-sash'; game.player.box.push(released); game.inventory['focus-sash'] = 1_000_000_000;
    const before = serializeGame(game);
    expect(() => releaseMonster(game, released.instanceId)).toThrow(/재고가 너무 많습니다/);
    expect(serializeGame(game)).toBe(before);
  });
});

describe('transactional evolution purchases', () => {
  it('does not buy an unusable catalyst or evolve ordinary Vulpix with an Ice Stone', () => {
    const game = createGame(1, 'invalid-form-purchase'), vulpix = createMonster(game, 37, 30);
    game.player.box.push(vulpix); game.player.money = 99999;
    expect(() => evolve(game, vulpix.instanceId, { item: 'ice-stone', autoBuyMissing: true })).toThrow();
    assignAlolaForm(game, vulpix.instanceId, true);
    const evolution = getSpecies(37).evolutions.find(e => e.target === 38)!;
    expect(evolutionPurchaseQuote(game, vulpix, evolution, 'evolution-catalyst').affordable).toBe(false);
    expect(() => evolve(game, vulpix.instanceId, { item: 'evolution-catalyst', autoBuyMissing: true })).toThrow();
    expect(game.player.money).toBe(99999); expect(vulpix.speciesId).toBe(37);
  });

  it('requires night for Alola Marowak and keeps ordinary form families ordinary in Alola', () => {
    const game = createGame(1, 'regional-evolution'), cubone = createMonster(game, 104, 28), vulpix = createMonster(game, 37, 30);
    game.player.box.push(cubone, vulpix); game.player.money = 99999;
    game.evolutionContext = { regionId: 'alola', period: 'day', locationId: '', raining: false, multiplayer: false };
    expect(() => evolve(game, cubone.instanceId)).toThrow();
    game.evolutionContext.period = 'night'; evolve(game, cubone.instanceId);
    expect(cubone.regionalForm).toBe('marowak-alola');
    evolve(game, vulpix.instanceId, { item: 'fire-stone', autoBuyMissing: true });
    expect(vulpix.regionalForm).toBeUndefined();
  });

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
  it('publishes the complete balanced shop catalog for held tools', () => {
    expect(HELD_TOOLS).toHaveLength(47);
    expect(HELD_TOOL_PRICES).toMatchObject({
      leftovers: 6000, 'choice-band': 6000, 'choice-specs': 6000,
      'choice-scarf': 6000, 'life-orb': 8000, 'focus-sash': 6000,
      charcoal: 2000, 'oran-berry': 2000, 'expert-belt': 4000, 'assault-vest': 6000, 'lucky-egg': 6000,
    });
    for (const tool of HELD_TOOLS) {
      expect(ITEM_PRICES[tool]).toBe(HELD_TOOL_PRICES[tool]);
      expect(HELD_TOOL_LABELS[tool]).not.toBe('');
      expect(HELD_TOOL_DESCRIPTIONS[tool]).not.toBe('');
    }
  });

  it('moves finite tools transactionally between individuals and preserves them across saves', () => {
    const game = createGame(1, 'held-tools'), attacker = game.player.team[0], other = createMonster(game, 4, 5);
    game.player.box.push(other); game.inventory['focus-sash'] = 2; game.inventory.leftovers = 1;
    assignHeldTool(game, attacker.instanceId, 'focus-sash');
    expect(game.inventory['focus-sash']).toBe(1);
    const unchanged = serializeGame(game); assignHeldTool(game, attacker.instanceId, 'focus-sash');
    expect(serializeGame(game)).toBe(unchanged);
    assignHeldTool(game, other.instanceId, 'focus-sash');
    expect(game.inventory['focus-sash']).toBe(0);
    assignHeldTool(game, attacker.instanceId, 'leftovers');
    expect(game.inventory.leftovers).toBe(0); expect(game.inventory['focus-sash']).toBe(1);
    const beforeFailure = serializeGame(game);
    expect(() => assignHeldTool(game, attacker.instanceId, 'life-orb')).toThrow(/재고/);
    expect(serializeGame(game)).toBe(beforeFailure);
    const restored = restoreGame(serializeGame(game));
    expect(restored.player.team[0].heldTool).toBe('leftovers');
    expect(restored.player.box[0].heldTool).toBe('focus-sash');
    expect(restored.inventory['focus-sash']).toBe(1); expect(restored.inventory.leftovers).toBe(0);
    const move = { ...getMove(33), power: 1000 };
    const stats = { hp: 100, attack: 100, defense: 100, specialAttack: 100, specialDefense: 100, speed: 100 };
    expect(calculateDamage({ level: 100, hp: 100, stats, types: ['normal'] }, { level: 5, hp: 100, stats, types: ['normal'], heldTool: 'focus-sash' }, move, 1).damage).toBe(99);
  });

  it('migrates absent tool stock to zero without removing a legacy equipped tool', () => {
    const game = createGame(1, 'legacy-held-tool'); game.player.team[0].heldTool = 'choice-scarf';
    const legacy = JSON.parse(serializeGame(game));
    for (const tool of HELD_TOOLS) delete legacy.inventory[tool];
    const restored = restoreGame(JSON.stringify(legacy));
    expect(restored.player.team[0].heldTool).toBe('choice-scarf');
    for (const tool of HELD_TOOLS) expect(restored.inventory[tool]).toBe(0);
  });

  it('uses the exported healing amounts for both medicines', () => {
    const game = createGame(1, 'healing-items'), monster = createMonster(game, 1, 50);
    game.player.team = [monster]; monster.hp = 1;
    game.inventory.potion = 1; useItem(game, 'potion', monster.instanceId);
    expect(monster.hp).toBe(1 + HEALING_ITEM_HP.potion);
    monster.hp = 1; game.inventory['super-potion'] = 1; useItem(game, 'super-potion', monster.instanceId);
    expect(monster.hp).toBe(1 + HEALING_ITEM_HP['super-potion']);
    expect(HEALING_ITEM_HP['super-potion']).toBe(60);
  });

  it('assigns only a canonical ability slot and persists its identity', () => {
    const game = createGame(1, 'ability-assignment'), monster = game.player.team[0];
    const assigned = assignMonsterAbility(game, monster.instanceId, 3);
    expect(assigned.slot).toBe(3);
    expect(restoreGame(serializeGame(game)).player.team[0].ability).toEqual(assigned);
    expect(() => assignMonsterAbility(game, monster.instanceId, 2)).toThrow();
  });
});

describe('unavailable Mega models', () => {
  it('hides and rejects every Mega form without verified 3D geometry', () => {
    const missing = COMBAT_FORMS.filter(form => form.kind === 'mega' && !getPokemonFormModelSource(form.identifier));
    expect(missing).toHaveLength(32);
    for (const form of missing) {
      const game = createGame(4, form.identifier), monster = createMonster(game, form.speciesId, 50);
      game.player.team = [monster];
      game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, 7, 50)], activeIndex: 0 }, turn: 1, canRun: true };
      expect(battleTransformationsHtml(game)).not.toContain(`value="${form.identifier}"`);
      expect(() => activateBattleTransformation(game, 'mega', { formIdentifier: form.identifier })).toThrow();
      expect(game.battle.playerMegaUsed).toBeUndefined();
      expect(game.battle.transformations).toBeUndefined();
    }
  });
  it('includes every regional move referenced by the move editor', () => {
    for (const form of COMBAT_FORMS.filter(form => form.kind === 'alola')) {
      for (const entry of form.levelUpMoves) expect(getMove(entry.moveId).id).toBe(entry.moveId);
    }
  });
});

describe('battle forms', () => {
  it('uses canonical Mega stats and limits Mega evolution to once per battle', () => {
    const game = createGame(4, 'mega-battle'), charizard = createMonster(game, 6, 50), enemy = createMonster(game, 7, 50);
    game.player.team = [charizard];
    charizard.heldTool = 'mega-stone:charizard-mega-x';
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
    const mega = activateBattleTransformation(game, 'mega', { formIdentifier: 'charizard-mega-x' });
    expect(mega).toMatchObject({ kind: 'mega', formIdentifier: 'charizard-mega-x', types: ['fire', 'dragon'] });
    expect(mega.stats.attack).toBeGreaterThan(charizard.stats.attack);
    expect(() => activateBattleTransformation(game, 'mega')).toThrow();
    expect(() => restoreGame(serializeGame(game))).not.toThrow();
  });

  it('loads Tera Blast from the generated catalog and equips it through the move layout flow', () => {
    const game = createGame(1, 'tera-blast-machine'), raichu = createMonster(game, 26, 30);
    game.player.box.push(raichu); assignAlolaForm(game, raichu.instanceId, true);
    expect(getMove(851)).toMatchObject({ englishName: 'Tera Blast', type: 'normal', power: 80, damageClass: 'special' });
    expect(getSpecies(26).machineMoves).toContain(851);
    expect(availableMonsterMoveIds(raichu)).toContain(851);
    replaceMonsterMove(game, raichu.instanceId, 0, 851);
    expect(getMoveLayout(raichu)[0]).toMatchObject({ moveId: 851, pp: 10 });
    expect(getMoveLayout(restoreGame(serializeGame(game)).player.box[0])[0]).toMatchObject({ moveId: 851, pp: 10 });
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


describe('form and equipment continuity', () => {
  it('keeps a Choice tool locked through reload and clears the lock on switching', () => {
    const game = createGame(1, 'choice-persistence'), player = game.player.team[0];
    player.moves = [33, 45].map(moveId => ({ moveId, pp: getMove(moveId).pp })); player.heldTool = 'choice-band';
    game.player.team.push(createMonster(game, 7, 5));
    const enemy = createMonster(game, 143, 100);
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
    actBattle(game, { type: 'move', index: 0 }, 4);
    const loaded = restoreGame(serializeGame(game));
    const result = actBattle(loaded, { type: 'move', index: 1 }, 4);
    expect(result.executedMoves[0].moveId).toBe(33);
    expect(automatedMoveMask(battleMonsterView(loaded.battle!, loaded.player.team[0]), enemy, 2).slice(0, 4)).toEqual([true, false, false, false]);
    actBattle(loaded, { type: 'switch', index: 1 }, 4);
    expect(loaded.battle!.choiceLocks?.[player.instanceId]).toBeUndefined();
  });

  it('consumes Focus Sash once per battle even when HP is restored after reloading', () => {
    const game = createGame(1, 'sash-persistence'), player = game.player.team[0], enemy = createMonster(game, 150, 100);
    player.heldTool = 'focus-sash'; enemy.moves = [{ moveId: 94, pp: getMove(94).pp }];
    game.player.team.push(createMonster(game, 7, 5));
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
    actBattle(game, { type: 'wait' }, 0); expect(player.hp).toBe(1);
    const loaded = restoreGame(serializeGame(game)); loaded.player.team[0].hp = loaded.player.team[0].stats.hp;
    actBattle(loaded, { type: 'wait' }, 0);
    expect(loaded.player.team[0].hp).toBe(0); expect(loaded.battle!.awaitingSwitch).toBe('player');
    expect(loaded.player.team[0].heldTool).toBe('focus-sash');
  });

  it.each(['mega'] as const)('refreshes %s stats and moves after an in-battle level-up before saving', kind => {
    const game = createGame(4, `form-growth-${kind}`), player = createMonster(game, 6, 10);
    player.xp = experienceAtLevel(11, getSpecies(6).growthRate) - 1; game.player.team = [player];
    if (kind === 'mega') player.heldTool = 'mega-stone:charizard-mega-x';
    const trainer = FIELD_TRAINERS.find(trainer => trainer.region === 'kanto' && trainer.team.length > 1)!;
    expect(trainer).toBeDefined(); challengeFieldTrainer(game, trainer);
    activateBattleTransformation(game, kind, { formIdentifier: 'charizard-mega-x' });
    game.battle!.enemy.team[0].hp = 0; actBattle(game, { type: 'wait' }, 4);
    expect(player.level).toBeGreaterThan(10); expect(game.battle).toBeDefined();
    expect(restoreGame(serializeGame(game)).battle!.transformations![player.instanceId].moves).toEqual(player.moves);
  });

  it('separates original and Alola duplicates and preserves Alola growth and ability slots', () => {
    const game = createGame(1, 'alola-growth'), original = createMonster(game, 37, 10), alola = createMonster(game, 37, 10);
    game.player.box.push(original, alola); assignAlolaForm(game, alola.instanceId, true); assignMonsterAbility(game, alola.instanceId, 3);
    expect(previewCollectionMerge(game).totalDonors).toBe(0);
    game.inventory['rare-candy'] = 1; useItem(game, 'rare-candy', alola.instanceId);
    const loaded = restoreGame(serializeGame(game)).player.box[1];
    expect(loaded.level).toBe(11); expect(loaded.ability!.slot).toBe(3);
    game.player.money = ITEM_PRICES['ice-stone'];
    expect(() => evolve(game, alola.instanceId, { targetId: 38, item: 'fire-stone', autoBuyMissing: true })).toThrow();
    evolve(game, alola.instanceId, { targetId: 38, item: 'ice-stone', autoBuyMissing: true });
    expect(alola.regionalForm).toBe('ninetales-alola'); expect(alola.ability!.slot).toBe(3);
    expect(game.player.money).toBe(0);
  });

  it('senses the effective Alola and effective type instead of the base species type', () => {
    const game = createGame(1, 'form-senses'), self = createMonster(game, 63, 30), foe = createMonster(game, 19, 30);
    self.moves = [94, 33].map(moveId => ({ moveId, pp: getMove(moveId).pp }));
    game.player.box.push(foe); assignAlolaForm(game, foe.instanceId, true);
    expect(automatedMoveMask(self, foe, 1)[0]).toBe(false);
    expect(battleMoveSenses(self, foe)[0]).toBeLessThan(battleMoveSenses(self, { ...foe, regionalForm: undefined })[0]);
    expect(automatedMoveMask(self, { ...foe, types: ['water'] }, 1)[0]).toBe(true);
  });
});
