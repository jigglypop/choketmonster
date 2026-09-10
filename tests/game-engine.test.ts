import { describe, expect, it } from 'vitest';
import { getMove, getSpecies, POKEMON } from '../src/data/pokemon';
import { calculateDamage } from '../src/game/battle';
import {
  actBattle, availableEvolutions, challengeChampion, challengeGym, createGame, createMonster, evolve, restoreGame,
  serializeGame, useItem, type BattleState,
} from '../src/game/engine';
import { assertAllSpeciesReachable, REGIONS, speciesEncounterSources } from '../src/game/regions';

function wildBattle(state: ReturnType<typeof createGame>, speciesId: number, level = 5): BattleState {
  const wild = createMonster(state, speciesId, level);
  const battle: BattleState = {
    kind: 'wild', regionId: state.regionId,
    player: { team: state.player.team, activeIndex: 0 },
    enemy: { team: [wild], activeIndex: 0 }, turn: 1, canRun: true,
  };
  state.battle = battle;
  return battle;
}

describe('151종 로컬 게임 엔진', () => {
  it('151종 각각에 반복 가능한 출현 지역을 제공한다', () => {
    expect(POKEMON.map((species) => species.id)).toEqual(Array.from({ length: 151 }, (_, i) => i + 1));
    expect(assertAllSpeciesReachable()).toBe(true);
    for (let id = 1; id <= 151; id++) expect(speciesEncounterSources(id).length).toBeGreaterThan(0);
    expect(REGIONS.filter((region) => region.gym)).toHaveLength(8);
    expect(speciesEncounterSources(150)[0].minBadges).toBe(8);
  });

  it('포획, 성장, 레벨 진화, 저장 복원을 한 흐름으로 유지한다', () => {
    const state = createGame(7, 'capture-growth-save');
    const battle = wildBattle(state, 1, 5);
    battle.enemy.team[0].hp = 1;
    state.inventory['ultra-ball'] = 100;
    while (state.battle) actBattle(state, { type: 'catch', ball: 'ultra-ball' }, 4);
    const bulbasaur = state.player.team.find((monster) => monster.speciesId === 1)!;
    expect(bulbasaur).toBeDefined();
    state.inventory['rare-candy'] = 20;
    while (bulbasaur.level < 16) useItem(state, 'rare-candy', bulbasaur.instanceId);
    expect(availableEvolutions(state, bulbasaur.instanceId).map((entry) => entry.target)).toContain(2);
    evolve(state, bulbasaur.instanceId, { targetId: 2 });
    expect(state.dex.caught).toContain(2);

    wildBattle(state, 4, 7);
    const restored = restoreGame(serializeGame(state));
    expect(restored.player.team.some((monster) => monster.speciesId === 2)).toBe(true);
    expect(restored.battle!.player.team).toBe(restored.player.team);
    actBattle(restored, { type: 'wait' }, 4);
    expect(restored.battle!.turn).toBe(2);
  });

  it('상성 피해, 외부 대기 행동, PP 소비를 전투 상태에 반영한다', () => {
    const state = createGame(7, 'battle-rules');
    state.player.team[0] = createMonster(state, 7, 20);
    const battle = wildBattle(state, 4, 20);
    const player = state.player.team[0];
    const waterIndex = player.moves.findIndex((slot) => getMove(slot.moveId).type === 'water' && getMove(slot.moveId).power > 0);
    expect(waterIndex).toBeGreaterThanOrEqual(0);
    const beforePp = player.moves[waterIndex].pp;
    const beforeHp = battle.enemy.team[0].hp;
    const result = actBattle(state, { type: 'move', index: waterIndex }, 4);
    expect(result.decisionSource).toBe('external-brain');
    expect(result.enemyAction).toEqual({ type: 'wait' });
    expect(player.moves[waterIndex].pp).toBe(beforePp - 1);
    expect(battle.enemy.team[0].hp).toBeLessThan(beforeHp);

    const move = getMove(player.moves[waterIndex].moveId);
    const attacker = { level: player.level, hp: player.hp, stats: player.stats, types: getSpecies(player.speciesId).types };
    const fire = battle.enemy.team[0];
    const neutralSpecies = getSpecies(7); const neutralStats = fire.stats;
    const fireDamage = calculateDamage(attacker, { level: fire.level, hp: fire.hp, stats: fire.stats, types: getSpecies(4).types }, move, 1);
    const neutralDamage = calculateDamage(attacker, { level: 20, hp: neutralStats.hp, stats: neutralStats, types: neutralSpecies.types }, move, 1);
    expect(fireDamage.multiplier).toBe(2);
    expect(fireDamage.damage).toBeGreaterThan(neutralDamage.damage);
  });

  it('능력 단계 변화와 메타몽 변신을 전투 중 실제 계산 상태로 보존한다', () => {
    const state = createGame(7, 'status-moves');
    const battle = wildBattle(state, 4, 5);
    const tailWhip = state.player.team[0].moves.findIndex((slot) => slot.moveId === 39);
    actBattle(state, { type: 'move', index: tailWhip }, 4);
    expect(battle.statStages?.[battle.enemy.team[0].instanceId]?.defense).toBe(-1);

    state.battle = undefined;
    state.player.team[0] = createMonster(state, 132, 20);
    const transformedBattle = wildBattle(state, 7, 20);
    actBattle(state, { type: 'move', index: 0 }, 4);
    const form = transformedBattle.transformations?.[state.player.team[0].instanceId];
    expect(form?.speciesId).toBe(7);
    expect(form?.moves.length).toBeGreaterThan(0);
    expect(form?.moves.every((slot) => slot.pp <= 5)).toBe(true);
    const restored = restoreGame(serializeGame(state));
    expect(restored.battle?.transformations?.[restored.player.team[0].instanceId]?.speciesId).toBe(7);
  });

  it('이브이의 세 진화 분기를 아이템으로 구분한다', () => {
    for (const [item, targetId] of [['water-stone', 134], ['thunder-stone', 135], ['fire-stone', 136]] as const) {
      const state = createGame(1, `eevee-${item}`);
      const eevee = createMonster(state, 133, 25);
      state.player.box.push(eevee); state.inventory[item] = 1;
      expect(availableEvolutions(state, eevee.instanceId).map((entry) => entry.target)).toEqual([targetId]);
      evolve(state, eevee.instanceId, { targetId, item });
      expect(eevee.speciesId).toBe(targetId);
      expect(state.inventory[item]).toBe(0);
    }
  });

  it('8개 체육관을 순서대로 진행한 뒤 챔피언에 도전한다', () => {
    const state = createGame(1, 'league');
    for (const region of REGIONS.filter((candidate) => candidate.gym)) {
      challengeGym(state, region.id);
      state.battle!.enemy.team[0].hp = 0;
      expect(actBattle(state, { type: 'wait' }, 4).outcome).toBe('won');
    }
    expect(state.player.badges).toBe(8);
    challengeChampion(state);
    while (state.battle) {
      state.battle.enemy.team[state.battle.enemy.activeIndex].hp = 0;
      actBattle(state, { type: 'wait' }, 4);
    }
    expect(state.championDefeated).toBe(true);
  });

  it('손상된 저장과 분리된 전투 팀을 거부한다', () => {
    const state = createGame(1, 'invalid-save'); wildBattle(state, 4);
    const raw = JSON.parse(serializeGame(state));
    raw.battle.player.team[0].hp--;
    expect(() => restoreGame(JSON.stringify(raw))).toThrow(/전투 팀/);
    const invalid = JSON.parse(serializeGame(state)); invalid.player.team[0].stats.attack++;
    invalid.battle.player.team[0].stats.attack++;
    expect(() => restoreGame(JSON.stringify(invalid))).toThrow(/능력치/);
  });
});
