import { describe, expect, it } from 'vitest';
import {
  EQUIPPABLE_ITEMS,
  FIELD_ITEMS,
  HELD_TOOLS,
  MEGA_STONES,
  SHOP_ITEMS,
  activateBattleTransformation,
  applyPreferredBattleTransformation,
  assignHeldTool,
  assignPreferredTransformation,
  buyItem,
  createGame,
  createMonster,
  evolve,
  megaStoneId,
  mergeDuplicateMonsters,
  releaseMonster,
  restoreGame,
  serializeGame,
} from '../src/game/engine';

describe('Mega stone inventory and equipment', () => {
  it('derives all equippable items from the shared field catalog and keeps them out of NPC shops', () => {
    expect(FIELD_ITEMS).toHaveLength(70);
    expect(HELD_TOOLS).toHaveLength(6);
    expect(MEGA_STONES).toHaveLength(64);
    expect(EQUIPPABLE_ITEMS).toHaveLength(70);
    expect(SHOP_ITEMS).not.toEqual(expect.arrayContaining([...HELD_TOOLS, ...MEGA_STONES.map(item => item.id)]));
    const game = createGame(4, 'stone-catalog');
    for (const stone of MEGA_STONES) expect(game.inventory[stone.id]).toBe(0);
    expect(() => buyItem(game, 'leftovers')).toThrow(/판매하지/);
    expect(() => buyItem(game, megaStoneId('charizard-mega-x'))).toThrow(/판매하지/);
  });

  it('auto-equips the exact stone for a Mega preference and returns displaced equipment', () => {
    const game = createGame(4, 'stone-preference'), monster = createMonster(game, 6, 50);
    game.player.team = [monster]; monster.heldTool = 'leftovers';
    const stone = megaStoneId('charizard-mega-x'); game.inventory[stone] = 1;
    assignPreferredTransformation(game, monster.instanceId, { kind: 'mega', formIdentifier: 'charizard-mega-x' });
    expect(monster.heldTool).toBe(stone); expect(game.inventory[stone]).toBe(0); expect(game.inventory.leftovers).toBe(1);
    const unchanged = serializeGame(game);
    assignPreferredTransformation(game, monster.instanceId, { kind: 'mega', formIdentifier: 'charizard-mega-x' });
    expect(serializeGame(game)).toBe(unchanged);

    assignPreferredTransformation(game, monster.instanceId);
    expect(monster.heldTool).toBeUndefined(); expect(game.inventory[stone]).toBe(1);
    expect(monster.preferredTransformation).toBeUndefined();
    assignPreferredTransformation(game, monster.instanceId, { kind: 'mega', formIdentifier: 'charizard-mega-x' });
    assignPreferredTransformation(game, monster.instanceId);
    expect(monster.heldTool).toBeUndefined(); expect(game.inventory[stone]).toBe(1);
  });

  it('keeps failed equipment changes atomic and clears Mega preference for another tool', () => {
    const game = createGame(4, 'stone-atomic'), monster = createMonster(game, 6, 50);
    game.player.team = [monster]; monster.heldTool = 'focus-sash';
    const stone = megaStoneId('charizard-mega-x'), preference = { kind: 'mega', formIdentifier: 'charizard-mega-x' } as const;
    let before = JSON.stringify(game);
    expect(() => assignPreferredTransformation(game, monster.instanceId, preference)).toThrow(/재고/);
    expect(JSON.stringify(game)).toBe(before);
    game.inventory[stone] = 1; game.inventory['focus-sash'] = 1_000_000_000; before = JSON.stringify(game);
    expect(() => assignPreferredTransformation(game, monster.instanceId, preference)).toThrow(/너무 많습니다/);
    expect(JSON.stringify(game)).toBe(before);

    game.inventory['focus-sash'] = 0;
    assignPreferredTransformation(game, monster.instanceId, preference);
    game.inventory['life-orb'] = 1;
    assignHeldTool(game, monster.instanceId, 'life-orb');
    expect(monster.preferredTransformation).toBeUndefined();
    expect(game.inventory[stone]).toBe(1);
    const bulbasaur = createMonster(game, 1, 20); game.player.box.push(bulbasaur);
    expect(() => assignHeldTool(game, bulbasaur.instanceId, stone)).toThrow(/맞지 않는/);
  });

  it('requires the exact held stone for manual and automatic Mega activation', () => {
    const game = createGame(4, 'stone-activation'), monster = createMonster(game, 6, 50), enemy = createMonster(game, 7, 50);
    game.player.team = [monster];
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
    expect(() => activateBattleTransformation(game, 'mega', { formIdentifier: 'charizard-mega-x' })).toThrow(/메가진화석/);
    monster.preferredTransformation = { kind: 'mega', formIdentifier: 'charizard-mega-x' };
    applyPreferredBattleTransformation(game);
    expect(game.battle.transformations).toBeUndefined(); expect(game.battle.playerMegaUsed).toBeUndefined();
    monster.heldTool = megaStoneId('charizard-mega-y');
    expect(() => activateBattleTransformation(game, 'mega', { formIdentifier: 'charizard-mega-x' })).toThrow(/메가진화석/);
    monster.heldTool = megaStoneId('charizard-mega-x');
    expect(activateBattleTransformation(game, 'mega', { formIdentifier: 'charizard-mega-x' }).kind).toBe('mega');
  });

  it('clears a legacy stone-less preference while preserving the monster and an active Mega', () => {
    const game = createGame(4, 'legacy-stone'), monster = createMonster(game, 6, 50), enemy = createMonster(game, 7, 50);
    game.player.team = [monster]; monster.nickname = '기억 보존';
    monster.moveLearning = { '33': { choices: 1, executed: 1, effective: 1, reward: 1 } };
    monster.preferredTransformation = { kind: 'mega', formIdentifier: 'charizard-mega-x' };
    const legacy = restoreGame(JSON.stringify(game));
    expect(legacy.player.team[0]).toMatchObject({ instanceId: monster.instanceId, nickname: '기억 보존', moveLearning: monster.moveLearning });
    expect(legacy.player.team[0].preferredTransformation).toBeUndefined();

    const stone = megaStoneId('charizard-mega-x'); game.inventory[stone] = 1;
    assignPreferredTransformation(game, monster.instanceId, { kind: 'mega', formIdentifier: 'charizard-mega-x' });
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
    activateBattleTransformation(game, 'mega', { formIdentifier: 'charizard-mega-x' });
    delete monster.heldTool;
    const active = restoreGame(JSON.stringify(game));
    expect(active.player.team[0].preferredTransformation).toBeUndefined();
    expect(active.battle!.transformations![monster.instanceId]).toMatchObject({ kind: 'mega', formIdentifier: 'charizard-mega-x' });
  });

  it('returns Mega stones on release and merge and rejects overflow before mutation', () => {
    const stone = megaStoneId('zygarde-mega');
    const release = createGame(1, 'release-stone'), released = createMonster(release, 718, 50);
    released.heldTool = stone; release.player.box.push(released);
    releaseMonster(release, released.instanceId); expect(release.inventory[stone]).toBe(1);

    const overflow = createGame(1, 'release-stone-overflow'), blocked = createMonster(overflow, 718, 50);
    blocked.heldTool = stone; overflow.player.box.push(blocked); overflow.inventory[stone] = 1_000_000_000;
    const before = JSON.stringify(overflow);
    expect(() => releaseMonster(overflow, blocked.instanceId)).toThrow(/너무 많습니다/);
    expect(JSON.stringify(overflow)).toBe(before);

    const merge = createGame(1, 'merge-stone'), target = createMonster(merge, 718, 40), donor = createMonster(merge, 718, 40);
    donor.heldTool = stone; merge.player.box.push(target, donor);
    mergeDuplicateMonsters(merge, target.instanceId, [donor.instanceId]);
    expect(merge.inventory[stone]).toBe(1);
  });

  it('returns Floette\'s stone before evolving and rejects overflow atomically', () => {
    const stone = megaStoneId('floette-mega');
    const game = createGame(1, 'floette-evolution'), floette = createMonster(game, 670, 50);
    game.player.box.push(floette); floette.heldTool = stone;
    floette.preferredTransformation = { kind: 'mega', formIdentifier: 'floette-mega' };
    game.inventory['shiny-stone'] = 1;
    evolve(game, floette.instanceId, { targetId: 671, item: 'shiny-stone' });
    expect(floette.speciesId).toBe(671); expect(floette.heldTool).toBeUndefined();
    expect(floette.preferredTransformation).toBeUndefined(); expect(game.inventory[stone]).toBe(1);

    const blocked = createGame(1, 'floette-evolution-overflow'), other = createMonster(blocked, 670, 50);
    blocked.player.box.push(other); other.heldTool = stone; blocked.inventory[stone] = 1_000_000_000; blocked.inventory['shiny-stone'] = 1;
    const before = JSON.stringify(blocked);
    expect(() => evolve(blocked, other.instanceId, { targetId: 671, item: 'shiny-stone' })).toThrow(/너무 많습니다/);
    expect(JSON.stringify(blocked)).toBe(before);
  });
});
