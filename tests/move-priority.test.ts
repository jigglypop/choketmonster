import { describe, expect, it } from 'vitest';
import { getMove } from '../src/data/pokemon';
import { actBattle, createGame, createMonster, type BattleState, type GameState, type Monster } from '../src/game/engine';

const TACKLE = 33;
const QUICK_ATTACK = 98;

function battleWithMoves(seed: string, playerMove: number, enemyMove: number): {
  state: GameState;
  battle: BattleState;
  player: Monster;
  enemy: Monster;
} {
  const state = createGame(1, seed);
  const player = createMonster(state, 19, 30);
  const enemy = createMonster(state, 19, 30);
  player.moves = [{ moveId: playerMove, pp: getMove(playerMove).pp }];
  enemy.moves = [{ moveId: enemyMove, pp: getMove(enemyMove).pp }];
  // Keep both combatants alive so executedMoves records the complete order.
  for (const monster of [player, enemy]) {
    monster.stats.hp = 1_000;
    monster.hp = 1_000;
    monster.stats.attack = 20;
    monster.stats.defense = 100;
  }
  state.player.team = [player];
  const battle: BattleState = {
    kind: 'wild', regionId: state.regionId, turn: 1, canRun: true,
    player: { team: state.player.team, activeIndex: 0 },
    enemy: { team: [enemy], activeIndex: 0 },
  };
  state.battle = battle;
  return { state, battle, player, enemy };
}

function actorOrder(fixture: ReturnType<typeof battleWithMoves>): string[] {
  return actBattle(fixture.state, { type: 'move', index: 0 }, 0).executedMoves.map(move => move.actorInstanceId);
}

describe('move priority and speed order', () => {
  it('uses move priority before raw speed in both directions', () => {
    const slowerPriority = battleWithMoves('slower-priority', QUICK_ATTACK, TACKLE);
    slowerPriority.player.stats.speed = 20;
    slowerPriority.enemy.stats.speed = 200;
    expect(actorOrder(slowerPriority)).toEqual([slowerPriority.player.instanceId, slowerPriority.enemy.instanceId]);

    const fasterNormal = battleWithMoves('faster-normal', TACKLE, QUICK_ATTACK);
    fasterNormal.player.stats.speed = 200;
    fasterNormal.enemy.stats.speed = 20;
    expect(actorOrder(fasterNormal)).toEqual([fasterNormal.enemy.instanceId, fasterNormal.player.instanceId]);
  });

  it('applies speed stages and paralysis after equal move priority', () => {
    const staged = battleWithMoves('speed-stage', TACKLE, TACKLE);
    staged.player.stats.speed = 60;
    staged.enemy.stats.speed = 100;
    staged.battle.statStages = { [staged.player.instanceId]: { speed: 2 } };
    expect(actorOrder(staged)[0]).toBe(staged.player.instanceId);

    const paralyzed = battleWithMoves('paralysis-speed', TACKLE, TACKLE);
    paralyzed.player.stats.speed = 60;
    paralyzed.enemy.stats.speed = 100;
    paralyzed.enemy.status = 'paralysis';
    expect(actorOrder(paralyzed)[0]).toBe(paralyzed.player.instanceId);
  });

  it('breaks exact speed ties reproducibly without a fixed side bias', () => {
    const sample = () => Array.from({ length: 200 }, (_, index) => {
      const fixture = battleWithMoves(`speed-tie-${index}`, TACKLE, TACKLE);
      fixture.player.stats.speed = fixture.enemy.stats.speed = 100;
      return actorOrder(fixture)[0] === fixture.player.instanceId ? 'player' : 'enemy';
    });
    const first = sample();
    const playerFirst = first.filter(side => side === 'player').length;
    expect(sample()).toEqual(first);
    expect(playerFirst).toBeGreaterThan(70);
    expect(playerFirst).toBeLessThan(130);
  });

  it('executes the exact selected move slot on that turn', () => {
    const fixture = battleWithMoves('selected-priority-slot', TACKLE, TACKLE);
    fixture.player.moves = [
      { moveId: TACKLE, pp: getMove(TACKLE).pp },
      { moveId: QUICK_ATTACK, pp: getMove(QUICK_ATTACK).pp },
    ];
    fixture.player.stats.speed = 20;
    fixture.enemy.stats.speed = 200;
    const result = actBattle(fixture.state, { type: 'move', index: 1 }, 0);
    expect(result.executedMoves[0]).toEqual(expect.objectContaining({
      actorInstanceId: fixture.player.instanceId,
      moveId: QUICK_ATTACK,
    }));
    expect(fixture.player.moves[1].pp).toBe(getMove(QUICK_ATTACK).pp);
    expect(fixture.player.moves[0].pp).toBe(getMove(TACKLE).pp);
  });
});
