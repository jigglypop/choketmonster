import { describe, expect, it } from 'vitest';
import { Brain } from '../src/core/brain';
import { getMove } from '../src/data/pokemon';
import { createGame, createMonster, evolve, recoverableAttackMoveIds, recoverAttackMove, reorderMonsterMoves, restoreGame, serializeGame, useItem } from '../src/game/engine';
import { getMoveLayout } from '../src/game/move-layout';

const engineDamageIds = new Set([12, 32, 49, 69, 82, 90, 101, 149, 162]);
const canDealDamage = (moveId: number) => {
  const move = getMove(moveId);
  return move.damageClass !== 'status' && (move.power > 0 || engineDamageIds.has(moveId));
};

describe('move presentation layout', () => {
  it('validates optional order as unique safe IDs from current move slots', () => {
    const game = createGame(1, 'layout-validation');
    const moveId = game.player.team[0].moves[0].moveId;
    game.player.team[0].moveOrder = [moveId];
    expect(() => restoreGame(serializeGame(game))).not.toThrow();

    for (const invalid of [[moveId, moveId], [999_999], [moveId, 1.5], [1, 2, 3, 4, 5]]) {
      const edited = structuredClone(game);
      edited.player.team[0].moveOrder = invalid;
      expect(() => restoreGame(JSON.stringify(edited))).toThrow(/기술 배치/);
    }
  });

  it('groups attacks first and retains source indexes, PP and preference within each group', () => {
    const game = createGame(1, 'layout');
    const monster = game.player.team[0];
    monster.moves = [
      { moveId: 45, pp: 17 },
      { moveId: 33, pp: 11 },
      { moveId: 73, pp: 8 },
      { moveId: 22, pp: 6 },
    ];
    monster.moveOrder = [22, 33, 73, 45];

    expect(getMoveLayout(monster)).toEqual([
      { moveId: 22, pp: 6, sourceIndex: 3 },
      { moveId: 33, pp: 11, sourceIndex: 1 },
      { moveId: 73, pp: 8, sourceIndex: 2 },
      { moveId: 45, pp: 17, sourceIndex: 0 },
    ]);
  });

  it('reorders adjacent entries inside a group without mutating engine slots or memory', () => {
    const game = createGame(1, 'reorder');
    const monster = game.player.team[0];
    monster.moves = [
      { moveId: 45, pp: 17 },
      { moveId: 33, pp: 11 },
      { moveId: 73, pp: 8 },
      { moveId: 22, pp: 6 },
    ];
    monster.brain = { marker: 'unchanged' } as never;
    monster.moveLearning = { '33': { choices: 2, executed: 1, effective: 1, reward: 0.5 } };
    const slots = structuredClone(monster.moves);
    const brain = structuredClone(monster.brain);
    const learning = structuredClone(monster.moveLearning);

    reorderMonsterMoves(game, monster.instanceId, 0, 1);

    expect(monster.moveOrder).toEqual([22, 33, 45, 73]);
    expect(monster.moves).toEqual(slots);
    expect(monster.brain).toEqual(brain);
    expect(monster.moveLearning).toEqual(learning);
  });

  it('rejects invalid, cross-group, battle-time and non-owned changes', () => {
    const game = createGame(1, 'guards');
    const monster = game.player.team[0];
    monster.moves = [
      { moveId: 33, pp: 35 },
      { moveId: 22, pp: 25 },
      { moveId: 45, pp: 40 },
      { moveId: 73, pp: 10 },
    ];
    expect(() => reorderMonsterMoves(game, monster.instanceId, 1, 2)).toThrow(/경계/);
    expect(() => reorderMonsterMoves(game, monster.instanceId, 0, 2)).toThrow(/인접/);
    expect(() => reorderMonsterMoves(game, monster.instanceId, -1, 0)).toThrow(/위치/);
    expect(() => reorderMonsterMoves(game, 'mon-99999', 0, 1)).toThrow(/보유하지 않은/);

    const enemy = createMonster(game, 4, 5);
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
    expect(() => reorderMonsterMoves(game, monster.instanceId, 0, 1)).toThrow(/전투 중/);
    expect(() => reorderMonsterMoves(game, enemy.instanceId, 0, 1)).toThrow(/전투 중/);
  });

  it('keeps an engine-damaging move on generated sets that used to end with four status moves', () => {
    const game = createGame(1, 'damage-floor');
    for (const [speciesId, level] of [[26, 1], [54, 39], [151, 70]] as const) {
      const monster = createMonster(game, speciesId, level);
      expect(monster.moves.some((slot) => canDealDamage(slot.moveId)), `${speciesId} at ${level}`).toBe(true);
    }
  });

  it('does not silently replace a legacy owned set of four status moves during restore', () => {
    const game = createGame(1, 'legacy-status');
    const monster = createMonster(game, 26, 1);
    monster.moves = [45, 39, 104, 113].map((moveId) => ({ moveId, pp: getMove(moveId).pp }));
    monster.moveOrder = [113, 104, 39, 45];
    game.player.team = [monster];
    game.dex = { seen: [26], caught: [26] };
    game.versionCaught = { red: [26] };

    const restored = restoreGame(serializeGame(game)).player.team[0];

    expect(restored.moves).toEqual(monster.moves);
    expect(restored.moveOrder).toEqual(monster.moveOrder);
    expect(restored.moves.every((slot) => getMove(slot.moveId).damageClass === 'status')).toBe(true);
  });

  it('offers latest learned attacks and explicitly recovers a legacy four-status set', () => {
    const game = createGame(1, 'recover-attack');
    const monster = createMonster(game, 54, 39);
    monster.moves = [487, 244, 133, 472].map((moveId, index) => ({ moveId, pp: getMove(moveId).pp - index - 1 }));
    monster.brain = new Brain(17).state;
    monster.brain.previous = Array(monster.brain.activity.length + 12).fill(0.25);
    monster.moveLearning = { '401': { choices: 7, executed: 6, effective: 4, reward: 2 } };
    game.player.box.push(monster);
    const untouchedSlots = structuredClone(monster.moves.slice(1));
    const brainBefore = structuredClone(monster.brain);
    const learningBefore = structuredClone(monster.moveLearning);

    expect(recoverableAttackMoveIds(monster).slice(0, 3)).toEqual([401, 428, 352]);
    recoverAttackMove(game, monster.instanceId, 401);

    expect(monster.moves).toEqual([{ moveId: 401, pp: getMove(401).pp }, ...untouchedSlots]);
    expect(getMoveLayout(monster)[0]).toMatchObject({ moveId: 401, sourceIndex: 0 });
    expect(monster.moveOrder?.[0]).toBe(401);
    expect(monster.brain).toEqual({ ...brainBefore, previous: null });
    expect(monster.moveLearning).toEqual(learningBefore);
    expect(recoverableAttackMoveIds(monster)).toEqual([]);
    expect(() => recoverAttackMove(game, monster.instanceId, 401)).toThrow(/배치할 수 있는/);

    const restored = restoreGame(serializeGame(game)).player.box.find((item) => item.instanceId === monster.instanceId)!;
    expect(restored.moves).toEqual(monster.moves);
    expect(restored.moveOrder).toEqual(monster.moveOrder);
    restored.moves.find((slot) => slot.moveId === 401)!.pp = 0;
    expect(recoverableAttackMoveIds(restored)).toEqual([]);
  });

  it('appends recovery to an open slot without changing existing PP', () => {
    const game = createGame(1, 'recover-open-slot');
    const monster = createMonster(game, 54, 39);
    monster.moves = [487, 244, 133].map((moveId, index) => ({ moveId, pp: getMove(moveId).pp - index - 1 }));
    game.player.box.push(monster);
    const before = structuredClone(monster.moves);

    recoverAttackMove(game, monster.instanceId, 401);

    expect(monster.moves).toEqual([...before, { moveId: 401, pp: getMove(401).pp }]);
    expect(getMoveLayout(monster)[0].moveId).toBe(401);
  });

  it('blocks explicit attack recovery during battle or a capture decision', () => {
    const game = createGame(1, 'recover-guards');
    const monster = createMonster(game, 54, 39);
    monster.moves = [487, 244, 133, 472].map((moveId) => ({ moveId, pp: getMove(moveId).pp }));
    game.player.box.push(monster);
    game.captureOffer = createMonster(game, 19, 3);
    game.captureOffer.hp = 0;
    expect(() => recoverAttackMove(game, monster.instanceId, 401)).toThrow(/포획 선택/);

    game.captureOffer = undefined;
    const enemy = createMonster(game, 4, 5);
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
    expect(() => recoverAttackMove(game, monster.instanceId, 401)).toThrow(/전투/);
    expect(() => recoverAttackMove(game, enemy.instanceId, 401)).toThrow(/보유하지 않은/);
  });

  it('preserves surviving custom order and appends newly learned moves without dropping the sole attack', () => {
    const game = createGame(1, 'level-order');
    const monster = createMonster(game, 54, 38);
    game.player.box.push(monster);
    expect(monster.moves.map((slot) => slot.moveId)).toEqual([401, 487, 244, 133]);
    monster.moveOrder = [401, 133, 487, 244];
    game.inventory['rare-candy'] = 1;

    useItem(game, 'rare-candy', monster.instanceId);

    expect(monster.moves.map((slot) => slot.moveId)).toEqual([401, 244, 133, 472]);
    expect(monster.moveOrder).toEqual([401, 133, 244, 472]);
    expect(monster.moves.some((slot) => canDealDamage(slot.moveId))).toBe(true);
  });

  it('cleans stale preferences after evolution while keeping every current move represented', () => {
    const game = createGame(1, 'evolution-order');
    const monster = game.player.team[0];
    monster.moveOrder = monster.moves.map((slot) => slot.moveId).reverse();
    game.inventory['rare-candy'] = 20;
    while (monster.level < 16) useItem(game, 'rare-candy', monster.instanceId);
    const removedCandidate = monster.moveOrder[0];

    evolve(game, monster.instanceId, { targetId: 2 });

    expect(monster.moveOrder).toHaveLength(monster.moves.length);
    expect(new Set(monster.moveOrder)).toEqual(new Set(monster.moves.map((slot) => slot.moveId)));
    if (!monster.moves.some((slot) => slot.moveId === removedCandidate)) expect(monster.moveOrder).not.toContain(removedCandidate);
  });
});
