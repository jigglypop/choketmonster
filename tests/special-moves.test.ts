import { describe, expect, it } from 'vitest';
import { actBattle, createGame, createMonster, restoreGame, serializeGame, type BattleState } from '../src/game/engine';

function setup(moveId: number, enemySpecies = 143) {
  const state = createGame(1, `special-${moveId}`);
  const actor = createMonster(state, 143, 50);
  actor.moves = [{ moveId, pp: 0 }];
  state.player.team = [actor];
  const foe = createMonster(state, enemySpecies, 50);
  const battle: BattleState = { kind: 'wild', regionId: state.regionId, turn: 1, canRun: true,
    player: { team: state.player.team, activeIndex: 0 }, enemy: { team: [foe], activeIndex: 0 } };
  state.battle = battle;
  const use = () => actBattle(state, { type: 'move', index: 0 }, 4);
  return { state, battle, actor, foe, use };
}

describe('explicit special move effects', () => {
  it('Haze clears both active stage sets, not HP, status or reserve stages', () => {
    const { state, battle, actor, foe, use } = setup(114);
    const reserve = createMonster(state, 7, 50); state.player.team.push(reserve);
    battle.statStages = { [actor.instanceId]: { attack: 3, accuracy: -2 }, [foe.instanceId]: { evasion: 6 }, [reserve.instanceId]: { defense: 1 } };
    foe.status = 'sleep'; const hp = foe.hp;
    expect(use().executedMoves[0]).toMatchObject({ statStageDelta: 11, strategicEffect: true, damage: 0 });
    expect(battle.statStages).toEqual({ [reserve.instanceId]: { defense: 1 } });
    expect(foe.status).toBe('sleep'); expect(foe.hp).toBe(hp);
    expect(use().executedMoves[0].strategicEffect).toBe(false);
  });

  it('Rest heals and replaces poison, survives save/restore, then sleeps exactly two actions', () => {
    const { state, actor, use } = setup(156);
    actor.hp -= 30; actor.status = 'poison';
    expect(use().executedMoves[0]).toMatchObject({ hpRecovered: 30, strategicEffect: true });
    expect(actor.hp).toBe(actor.stats.hp); expect(actor.statusTurns).toBe(3);
    actor.moves = [{ moveId: 33, pp: 0 }];
    const restored = restoreGame(serializeGame(state));
    for (let i = 0; i < 2; i++) expect(actBattle(restored, { type: 'move', index: 0 }, 4).executedMoves).toEqual([]);
    expect(actBattle(restored, { type: 'move', index: 0 }, 4).executedMoves[0].moveId).toBe(33);
    expect(restored.player.team[0].status).toBeUndefined();
  });

  it('Rest fails at full HP or with a sleep-preventing ability', () => {
    const { actor, use } = setup(156);
    expect(use().executedMoves[0]).toMatchObject({ result: 'failed', strategicEffect: false });
    expect(actor.status).toBeUndefined();
    actor.hp -= 10; actor.ability = { ...actor.ability!, slug: 'insomnia' };
    expect(use().executedMoves[0]).toMatchObject({ result: 'failed', hpRecovered: 0 });
    expect(actor.hp).toBe(actor.stats.hp - 10); expect(actor.status).toBeUndefined();
  });

  it.each([215, 312])('team cure %s heals active and reserve ailments, not opponents or binding', moveId => {
    const { state, actor, foe, use } = setup(moveId);
    const reserve = createMonster(state, 7, 50), bound = createMonster(state, 4, 50);
    state.player.team.push(reserve, bound);
    actor.status = 'burn'; reserve.status = 'sleep'; reserve.statusTurns = 3; bound.status = 'trap'; foe.status = 'sleep';
    expect(use().executedMoves[0]).toMatchObject({ strategicEffect: true, result: 'status' });
    expect(actor.status).toBeUndefined(); expect(reserve.status).toBeUndefined(); expect(reserve.statusTurns).toBeUndefined();
    expect(bound.status).toBe('trap'); expect(foe.status).toBe('sleep');
    expect(use().executedMoves[0]).toMatchObject({ strategicEffect: false, result: 'failed' });
  });

  it('Heal Bell respects a reserve Soundproof ability; Aromatherapy does not', () => {
    const { state, actor, use } = setup(215);
    const reserve = createMonster(state, 100, 50); reserve.ability = { ...reserve.ability!, slug: 'soundproof' };
    reserve.status = 'poison'; state.player.team.push(reserve);
    expect(use().executedMoves[0].strategicEffect).toBe(false); expect(reserve.status).toBe('poison');
    actor.moves[0].moveId = 312; expect(use().executedMoves[0].strategicEffect).toBe(true);
    expect(reserve.status).toBeUndefined();
  });

  it.each([143, 208])('Clear Smog resets stages only after damaging a nonimmune target %s', species => {
    const { battle, foe, use } = setup(499, species);
    battle.statStages = { [foe.instanceId]: { attack: 4, defense: -1 } };
    const result = use().executedMoves[0];
    if (species === 208) {
      expect(result).toMatchObject({ damage: 0, result: 'immune', statStageDelta: 0 });
      expect(battle.statStages[foe.instanceId].attack).toBe(4);
    } else {
      expect(result).toMatchObject({ category: 'mixed', statStageDelta: 5, strategicEffect: true });
      expect(battle.statStages[foe.instanceId]).toBeUndefined();
    }
  });

  it.each([143, 94])('Rapid Spin raises its user speed and clears binding only on a hit %s', species => {
    const { battle, actor, foe, use } = setup(229, species);
    actor.status = 'leech-seed';
    use();
    expect(battle.statStages?.[foe.instanceId]?.speed).toBeUndefined();
    expect(battle.statStages?.[actor.instanceId]?.speed).toBe(species === 94 ? undefined : 1);
    expect(actor.status).toBe(species === 94 ? 'leech-seed' : undefined);
  });
});
