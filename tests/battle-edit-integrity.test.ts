import { describe, expect, it } from 'vitest';
import { getMove, getSpecies } from '../src/data/pokemon';
import {
  actBattle, activateBattleTransformation, assignPreferredTransformation, availableEvolutions, availableMonsterMoveIds, battleMonsterView, createGame, createMonster,
  depositMonster, evolutionRoute, evolve, experienceAtLevel, grantTechnicalMachine, mergeDuplicateMonsters, recoverableAttackMoveIds, recoverAttackMove, releaseMonster,
  replaceMonsterMove, restoreGame, serializeGame, teachTechnicalMachine, useItem, type GameState,
} from '../src/game/engine';
import { evolutionProgress } from '../src/game/evolution-progress';

const moves = (...ids: number[]) => ids.map(moveId => ({ moveId, pp: getMove(moveId).pp }));
const damaging = (moveId: number) => getMove(moveId).damageClass !== 'status' && getMove(moveId).power > 0;

function megaBattle(speciesId: number, formIdentifier: string, seed: string) {
  const game = createGame(1, seed), mega = createMonster(game, speciesId, 50), reserve = createMonster(game, 9, 50), enemy = createMonster(game, 143, 100);
  game.player.team = [mega, reserve];
  game.inventory[`mega-stone:${formIdentifier}`] = 1;
  assignPreferredTransformation(game, mega.instanceId, { kind: 'mega', formIdentifier });
  game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
  const form = activateBattleTransformation(game, 'mega', { formIdentifier });
  return { game, mega, reserve, enemy, form };
}
const reload = (game: GameState) => restoreGame(serializeGame(game));

describe('in-battle edits keep the save loadable', () => {
  it('mirrors move replacement, attack recovery and machines into an active Mega', () => {
    const { game, mega, form } = megaBattle(6, 'charizard-mega-x', 'mega-move-edit');
    const spare = availableMonsterMoveIds(mega).find(id => !mega.moves.some(slot => slot.moveId === id) && damaging(id))!;
    replaceMonsterMove(game, mega.instanceId, 0, spare);
    expect(form.moves).toEqual(mega.moves);
    expect(reload(game).battle!.transformations![mega.instanceId].moves).toEqual(mega.moves);

    mega.moves = moves(184, 45, 108); delete mega.moveOrder; form.moves = structuredClone(mega.moves);
    recoverAttackMove(game, mega.instanceId, recoverableAttackMoveIds(mega)[0]);
    expect(form.moves).toEqual(mega.moves); expect(() => reload(game)).not.toThrow();

    expect(grantTechnicalMachine(game, 89)).toBe(true);
    expect(teachTechnicalMachine(game, mega.instanceId, 89)).toEqual({ equipped: false });
    mega.moves.pop(); delete mega.moveOrder; form.moves = structuredClone(mega.moves);
    grantTechnicalMachine(game, 126); teachTechnicalMachine(game, mega.instanceId, 126);
    expect(mega.moves.map(slot => slot.moveId)).toContain(126);
    expect(form.moves).toEqual(mega.moves); expect(() => reload(game)).not.toThrow();
  });

  it('grows an active Mega through a mid-battle merge with its form stats and moves', () => {
    const { game, mega, form } = megaBattle(6, 'charizard-mega-x', 'mega-merge');
    const donor = createMonster(game, 6, 50); game.player.box.push(donor);
    const before = form.stats.attack;
    const plan = mergeDuplicateMonsters(game, mega.instanceId, [donor.instanceId]);
    expect(mega.level).toBe(plan.toLevel); expect(plan.toLevel).toBeGreaterThan(50);
    expect(game.battle!.transformations![mega.instanceId].stats.attack).toBeGreaterThan(before);
    expect(game.battle!.transformations![mega.instanceId].moves).toEqual(mega.moves);
    expect(() => reload(game)).not.toThrow();
  });

  it('converts a benched Mega back to its own HP when it is deposited mid-battle', () => {
    const { game, mega, form } = megaBattle(718, 'zygarde-mega', 'mega-deposit');
    expect(mega.hp).toBe(form.stats.hp);
    actBattle(game, { type: 'switch', index: 1 }, 4);
    depositMonster(game, 0);
    expect(game.player.box[0]).toBe(mega);
    expect(mega.hp).toBe(mega.stats.hp);
    expect(game.battle!.transformations?.[mega.instanceId]).toBeUndefined();
    expect(() => reload(game)).not.toThrow();
  });

  it('never revives a fainted member through level-ups, candies, merges or evolution', () => {
    const game = createGame(1, 'fainted-growth'), lead = game.player.team[0], reserve = createMonster(game, 7, 5), twin = createMonster(game, 1, 20);
    game.player.team.push(reserve); game.player.box.push(twin);
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, 19, 5)], activeIndex: 0 }, turn: 2, canRun: true };
    lead.hp = 0; game.battle.awaitingSwitch = 'player';
    mergeDuplicateMonsters(game, lead.instanceId, [twin.instanceId]);
    expect(lead.level).toBe(21); expect(lead.hp).toBe(0);
    expect(reload(game).battle!.awaitingSwitch).toBe('player');

    game.battle = undefined; game.inventory['rare-candy'] = 1;
    useItem(game, 'rare-candy', lead.instanceId);
    expect(lead.level).toBe(22); expect(lead.hp).toBe(0);
    lead.xp = experienceAtLevel(22, getSpecies(1).growthRate);
    evolve(game, lead.instanceId, { targetId: 2 });
    expect(lead.speciesId).toBe(2); expect(lead.hp).toBe(0);
    expect(() => reload(game)).not.toThrow();
  });
});

describe('legacy mid-battle saves', () => {
  it('fills a missing origin region on both team copies', () => {
    const game = createGame(4, 'legacy-origin');
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, 19, 5)], activeIndex: 0 }, turn: 3, canRun: true };
    const legacy = JSON.parse(serializeGame(game));
    delete legacy.player.team[0].originRegion; delete legacy.battle.player.team[0].originRegion;
    const loaded = restoreGame(JSON.stringify(legacy));
    expect(loaded.player.team[0].originRegion).toBe('kanto');
    expect(loaded.battle!.player.team).toBe(loaded.player.team);
  });

  it('repairs the stale Mega copy, a revived pending battler and boxed Mega HP left by older edits', () => {
    const { game, mega, form } = megaBattle(718, 'zygarde-mega', 'legacy-mega-repair');
    const stale = JSON.parse(serializeGame(game));
    stale.battle.transformations[mega.instanceId].moves = [];
    stale.battle.transformations[mega.instanceId].stats.attack -= 1;
    expect(reload(restoreGame(JSON.stringify(stale))).battle!.transformations![mega.instanceId]).toMatchObject({ moves: mega.moves, stats: form.stats });

    const revived = JSON.parse(serializeGame(game));
    revived.battle.awaitingSwitch = 'player';
    expect(restoreGame(JSON.stringify(revived)).battle!.awaitingSwitch).toBeUndefined();

    actBattle(game, { type: 'switch', index: 1 }, 4);
    const boxed = JSON.parse(serializeGame(game));
    const [benched] = boxed.player.team.splice(0, 1); boxed.battle.player.team.splice(0, 1);
    boxed.player.box.push(benched); boxed.battle.player.activeIndex = 0;
    delete boxed.battle.transformations[mega.instanceId];
    const loaded = restoreGame(JSON.stringify(boxed));
    expect(loaded.player.box[0].hp).toBe(loaded.player.box[0].stats.hp);
  });
});

describe('choice locks follow the current move set', () => {
  it('releases a lock whose move was replaced mid-battle instead of forcing Struggle', () => {
    const game = createGame(1, 'choice-replace'), lead = game.player.team[0];
    lead.moves = moves(33, 45); lead.heldTool = 'choice-band';
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, 143, 100)], activeIndex: 0 }, turn: 1, canRun: true };
    actBattle(game, { type: 'move', index: 0 }, 4);
    expect(game.battle!.choiceLocks?.[lead.instanceId]).toBe(33);
    replaceMonsterMove(game, lead.instanceId, 0, 22);
    expect(game.battle!.choiceLocks?.[lead.instanceId]).toBeUndefined();
    const next = actBattle(game, { type: 'move', index: 0 }, 4).executedMoves[0];
    expect(next).toMatchObject({ moveId: 22 }); expect(next.result).not.toBe('struggle');
  });

  it('releases a lock on a move a mid-battle level-up replaced', () => {
    const game = createGame(1, 'choice-level-up'), lead = createMonster(game, 1, 11), twin = createMonster(game, 1, 11);
    lead.moves = moves(33, 22, 36, 402); lead.heldTool = 'choice-specs';
    game.player.team = [lead]; game.player.box = [twin];
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, 143, 100)], activeIndex: 0 }, turn: 1, canRun: true };
    actBattle(game, { type: 'move', index: 0 }, 4);
    mergeDuplicateMonsters(game, lead.instanceId, [twin.instanceId]);
    expect(lead.moves.map(slot => slot.moveId)).not.toContain(33);
    expect(game.battle!.choiceLocks?.[lead.instanceId]).toBeUndefined();
    expect(actBattle(game, { type: 'move', index: 0 }, 4).executedMoves[0].result).not.toBe('struggle');
  });

  it('lets a Choice holder use a copied move after Transform', () => {
    const game = createGame(1, 'choice-transform'), ditto = createMonster(game, 132, 30), foe = createMonster(game, 7, 30);
    ditto.heldTool = 'choice-scarf'; game.player.team = [ditto];
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [foe], activeIndex: 0 }, turn: 1, canRun: true };
    actBattle(game, { type: 'move', index: 0 }, 4);
    expect(game.battle!.transformations?.[ditto.instanceId]?.speciesId).toBe(7);
    expect(battleMonsterView(game.battle!, ditto).lockedMoveId).toBeUndefined();
    const copied = actBattle(game, { type: 'move', index: 1 }, 4).executedMoves[0];
    expect(copied.moveId).toBe(foe.moves[1].moveId); expect(copied.result).not.toBe('struggle');
    expect(game.battle!.choiceLocks?.[ditto.instanceId]).toBe(foe.moves[1].moveId);
  });
});

describe('forced replacements', () => {
  function pendingReplacement() {
    const game = createGame(1, 'forced-guard'), lead = game.player.team[0];
    const foreign = createMonster(game, 4, 5, 'johto'), local = createMonster(game, 7, 5);
    game.player.team.push(foreign, local);
    const enemy = createMonster(game, 19, 5);
    game.battle = { kind: 'wild', regionId: game.regionId, policyRegion: 'kanto', player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 2, canRun: true };
    lead.hp = 0; game.battle.awaitingSwitch = 'player';
    return { game, lead, foreign, local, enemy };
  }

  it('keeps one healthy member usable in this region through deposits, releases and merges', () => {
    const { game, local } = pendingReplacement();
    const twin = createMonster(game, 7, 5), veteran = createMonster(game, 7, 40); game.player.box.push(twin, veteran);
    expect(() => depositMonster(game, 2)).toThrow(/싸울 수 있는/);
    expect(() => releaseMonster(game, local.instanceId)).toThrow(/마지막/);
    expect(() => mergeDuplicateMonsters(game, twin.instanceId, [local.instanceId])).toThrow(/마지막/);
    // Growing the only usable member past the level cap would leave no replacement either.
    expect(() => mergeDuplicateMonsters(game, local.instanceId, [veteran.instanceId])).toThrow(/마지막/);
    depositMonster(game, 1);
    expect(game.player.team).toHaveLength(2);
  });

  it('sends the replacement without giving the opponent a move or end-of-turn effect', () => {
    const { game, local, enemy } = pendingReplacement();
    enemy.moves = moves(33); enemy.heldTool = 'leftovers'; enemy.hp -= 5;
    local.status = 'poison';
    const hp = { local: local.hp, enemy: enemy.hp }, turn = game.battle!.turn;
    const result = actBattle(game, { type: 'switch', index: 2 }, 0);
    expect(result.executedMoves).toEqual([]); expect(result.enemyAction).toBeUndefined();
    expect(local.hp).toBe(hp.local); expect(enemy.hp).toBe(hp.enemy);
    expect(game.battle!.player.activeIndex).toBe(2); expect(game.battle!.turn).toBe(turn + 1);
    expect(actBattle(game, { type: 'wait' }, 0).executedMoves).toHaveLength(1);
  });

  it('ends a pending replacement nobody can fill as a defeat instead of refusing every action', () => {
    const { game, local } = pendingReplacement();
    local.hp = 0;
    const loaded = reload(game);
    expect(loaded.battle!.awaitingSwitch).toBe('player');
    const result = actBattle(loaded, { type: 'switch', index: 1 }, 4);
    expect(result).toMatchObject({ battleEnded: true, outcome: 'lost' });
    expect(loaded.battle).toBeUndefined();
    expect(loaded.player.team.every(monster => monster.hp === monster.stats.hp)).toBe(true);
  });
});

describe('capture and evolution limits', () => {
  it('refuses an in-battle catch when the team and box are full', () => {
    const game = createGame(1, 'full-box-catch'), filler = createMonster(game, 10, 5);
    while (game.player.team.length < 6) game.player.team.push(createMonster(game, 10, 5));
    game.player.box = Array(10_000).fill(filler);
    const wild = createMonster(game, 19, 5); wild.hp = 1;
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [wild], activeIndex: 0 }, turn: 1, canRun: true };
    expect(() => actBattle(game, { type: 'catch', ball: 'poke-ball' }, 4)).toThrow(/빈자리/);
    expect(game.player.box).toHaveLength(10_000); expect(game.battle).toBeDefined();
  });

  it('evolves Alolan Meowth only into Alolan Persian and only with the evolution capsule', () => {
    const game = createGame(1, 'alolan-meowth'), meowth = createMonster(game, 52, 30, 'alola');
    game.player.box.push(meowth); evolutionProgress(meowth).friendship = 255;
    expect(meowth.regionalForm).toBe('meowth-alola');
    expect(availableEvolutions(game, meowth.instanceId)).toEqual([]);
    game.inventory['evolution-catalyst'] = 1;
    const perrserker = getSpecies(52).evolutions.find(evolution => evolution.target === 863)!;
    expect(evolutionRoute(game, meowth, perrserker, 'evolution-catalyst')).toBeUndefined();
    expect(() => evolve(game, meowth.instanceId, { targetId: 863, item: 'evolution-catalyst' })).toThrow();
    evolve(game, meowth.instanceId, { targetId: 53, item: 'evolution-catalyst' });
    expect(meowth).toMatchObject({ speciesId: 53, regionalForm: 'persian-alola' });
    expect(game.inventory['evolution-catalyst']).toBe(0);
    expect(() => reload(game)).not.toThrow();
  });
});
