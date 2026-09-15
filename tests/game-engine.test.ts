import { describe, expect, it } from 'vitest';
import { getMove, getSpecies, POKEMON } from '../src/data/pokemon';
import { Brain } from '../src/core/brain';
import { calculateDamage } from '../src/game/battle';
import {
  actBattle, availableEvolutions, availableMonsterMoveIds, challengeChampion, challengeGym, createGame, createMonster, evolve, experienceAtLevel, recoverTeamPpOutsideBattle, restoreGame,
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

describe('전체 포켓몬 로컬 게임 엔진', () => {
  it('전체 종 각각에 반복 가능한 출현 지역을 제공한다', () => {
    expect(POKEMON.map((species) => species.id)).toEqual(Array.from({ length: 1025 }, (_, i) => i + 1));
    expect(assertAllSpeciesReachable()).toBe(true);
    for (let id = 1; id <= POKEMON.length; id++) expect(speciesEncounterSources(id).length).toBeGreaterThan(0);
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
    expect(result.executedMoves).toContainEqual(expect.objectContaining({
      actorInstanceId: player.instanceId,
      targetInstanceId: battle.enemy.team[0].instanceId,
      moveId: player.moves[waterIndex].moveId,
      moveType: 'water',
      damageClass: expect.any(String),
      damagingMove: true,
      executed: true,
      hit: true,
      typeMultiplier: 2,
      result: 'hit',
    }));
    expect(result.executedMoves.find((entry) => entry.actorInstanceId === player.instanceId)!.damage).toBe(beforeHp - battle.enemy.team[0].hp);

    const move = getMove(player.moves[waterIndex].moveId);
    const attacker = { level: player.level, hp: player.hp, stats: player.stats, types: getSpecies(player.speciesId).types };
    const fire = battle.enemy.team[0];
    const neutralSpecies = getSpecies(7); const neutralStats = fire.stats;
    const fireDamage = calculateDamage(attacker, { level: fire.level, hp: fire.hp, stats: fire.stats, types: getSpecies(4).types }, move, 1);
    const neutralDamage = calculateDamage(attacker, { level: 20, hp: neutralStats.hp, stats: neutralStats, types: neutralSpecies.types }, move, 1);
    expect(fireDamage.multiplier).toBe(2);
    expect(fireDamage.damage).toBeGreaterThan(neutralDamage.damage);
  });

  it('전투 중 PP는 소모하고 전투가 끝난 뒤 장착·미장착 PP만 회복한다', () => {
    const state = createGame(1, 'outside-battle-pp');
    state.player.team[0] = createMonster(state, 1, 100);
    const player = state.player.team[0];
    player.moves = [{ moveId: 33, pp: 2 }];
    const reserveMove = availableMonsterMoveIds(player).find(moveId => moveId !== 33)!;
    player.movePpReserve = { [reserveMove]: 0 };
    const battle = wildBattle(state, 7, 100);
    const hpBefore = player.hp;
    const brain = new Brain(303).snapshot(); player.brain = brain;
    player.moveLearning = { 33: { choices: 2, executed: 1, effective: 1, reward: .25 } };
    const learningBefore = structuredClone(player.moveLearning);

    const active = actBattle(state, { type: 'move', index: 0 }, 4);
    expect(active.battleEnded).toBe(false);
    expect(player.moves[0].pp).toBe(1);
    expect(recoverTeamPpOutsideBattle(state)).toBe(false);
    expect(player.moves[0].pp).toBe(1);
    expect(player.movePpReserve[reserveMove]).toBe(0);

    battle.enemy.team[0].hp = 0;
    const ended = actBattle(state, { type: 'wait' }, 4);
    expect(ended).toMatchObject({ battleEnded: true, outcome: 'won' });
    expect(player.moves[0].pp).toBe(getMove(33).pp);
    expect(player.movePpReserve[reserveMove]).toBe(getMove(reserveMove).pp);
    expect(player.hp).toBe(hpBefore);
    expect(player.brain).toBe(brain);
    expect(player.moveLearning).toEqual(learningBefore);
  });

  it('전투 밖 저장의 0 PP를 복원하고 포획 선택 중에도 HP와 기억은 유지한다', () => {
    const state = createGame(1, 'restored-outside-pp');
    state.player.team[0] = createMonster(state, 1, 20);
    const player = state.player.team[0];
    const reserveMove = availableMonsterMoveIds(player).find(moveId => !player.moves.some(slot => slot.moveId === moveId))!;
    player.moves[0].pp = 0; player.movePpReserve = { [reserveMove]: 0 };
    player.hp -= 3; player.brain = new Brain(404).snapshot();
    const restored = restoreGame(serializeGame(state)), restoredPlayer = restored.player.team[0];
    expect(restoredPlayer.moves[0].pp).toBe(getMove(restoredPlayer.moves[0].moveId).pp);
    expect(restoredPlayer.movePpReserve![reserveMove]).toBe(getMove(reserveMove).pp);
    expect(restoredPlayer.hp).toBe(player.hp);
    expect(restoredPlayer.brain).toEqual(player.brain);

    restored.captureOffer = createMonster(restored, 4, 5);
    restored.captureOffer.hp = 0;
    restored.dex.seen = [...new Set([...restored.dex.seen, 4])];
    restoredPlayer.moves[0].pp = 0;
    const hpBefore = restoredPlayer.hp, brainBefore = restoredPlayer.brain;
    expect(recoverTeamPpOutsideBattle(restored)).toBe(true);
    expect(restoredPlayer.moves[0].pp).toBe(getMove(restoredPlayer.moves[0].moveId).pp);
    expect(restoredPlayer.hp).toBe(hpBefore);
    expect(restoredPlayer.brain).toBe(brainBefore);

    restoredPlayer.moves[0].pp = 0;
    restored.captureOffer = undefined;
    wildBattle(restored, 7, 5);
    const resumedBattle = restoreGame(serializeGame(restored));
    expect(resumedBattle.player.team[0].moves[0].pp).toBe(0);
  });

  it('실행된 기술 텔레메트리는 면역과 행동 차단을 로그 추론 없이 구분한다', () => {
    const immuneState = createGame(1, 'move-telemetry-immune');
    immuneState.player.team[0] = createMonster(immuneState, 25, 30);
    immuneState.player.team[0].moves = [{ moveId: 85, pp: getMove(85).pp }]; // Thunderbolt
    const immuneBattle = wildBattle(immuneState, 50, 30); // Diglett, ground
    const immune = actBattle(immuneState, { type: 'move', index: 0 }, 4);
    expect(immune.executedMoves).toEqual([expect.objectContaining({
      actorInstanceId: immuneState.player.team[0].instanceId,
      targetInstanceId: immuneBattle.enemy.team[0].instanceId,
      moveId: 85,
      moveType: 'electric',
      damagingMove: true,
      executed: true,
      hit: true,
      typeMultiplier: 0,
      damage: 0,
      result: 'immune',
    })]);

    const blockedState = createGame(1, 'move-telemetry-sleep');
    blockedState.player.team[0] = createMonster(blockedState, 25, 30);
    blockedState.player.team[0].moves = [{ moveId: 85, pp: getMove(85).pp }];
    blockedState.player.team[0].status = 'sleep';
    blockedState.player.team[0].statusTurns = 2;
    wildBattle(blockedState, 7, 30);
    const beforePp = blockedState.player.team[0].moves[0].pp;
    const blocked = actBattle(blockedState, { type: 'move', index: 0 }, 4);
    expect(blocked.executedMoves).toEqual([]);
    expect(blockedState.player.team[0].moves[0].pp).toBe(beforePp);

    const paralyzedState = createGame(1, 'move-telemetry-paralysis');
    paralyzedState.player.team[0] = createMonster(paralyzedState, 25, 30);
    paralyzedState.player.team[0].moves = [{ moveId: 85, pp: getMove(85).pp }];
    paralyzedState.player.team[0].status = 'paralysis';
    paralyzedState.rngState = 1; // second xorshift draw is below the 25% full-paralysis threshold
    wildBattle(paralyzedState, 7, 30);
    expect(actBattle(paralyzedState, { type: 'move', index: 0 }, 4).executedMoves).toEqual([]);

    const faintedState = createGame(1, 'move-telemetry-fainted');
    faintedState.player.team[0] = createMonster(faintedState, 25, 30);
    faintedState.player.team[0].moves = [{ moveId: 85, pp: getMove(85).pp }];
    faintedState.player.team[0].hp = 0;
    wildBattle(faintedState, 7, 30);
    expect(actBattle(faintedState, { type: 'move', index: 0 }, 4).executedMoves).toEqual([]);

    const missedState = createGame(1, 'move-telemetry-missed');
    missedState.player.team[0] = createMonster(missedState, 25, 30);
    missedState.player.team[0].moves = [{ moveId: 12, pp: getMove(12).pp }]; // Guillotine, 30 accuracy
    missedState.rngState = 58; // second xorshift draw is above the accuracy threshold
    wildBattle(missedState, 7, 30);
    expect(actBattle(missedState, { type: 'move', index: 0 }, 4).executedMoves).toEqual([
      expect.objectContaining({ moveId: 12, executed: true, hit: false, damage: 0, result: 'missed' }),
    ]);
  });

  it('승리 경험치를 활성 개체와 살아 있는 벤치에 개체별로 기록한다', () => {
    const state = createGame(1, 'experience-share');
    const active = state.player.team[0];
    const bench = createMonster(state, 7, 5);
    const fainted = createMonster(state, 4, 5);
    const boxed = createMonster(state, 25, 5);
    state.player.team.push(bench, fainted);
    state.player.box.push(boxed);
    fainted.hp = 0;
    const activeBrain = new Brain(101).snapshot();
    const benchBrain = new Brain(202).snapshot();
    active.brain = activeBrain;
    bench.brain = benchBrain;

    const battle = wildBattle(state, 4, 5);
    const defeated = battle.enemy.team[0];
    const fullAmount = Math.max(1, Math.floor(getSpecies(defeated.speciesId).baseExperience * defeated.level / 7));
    const sharedAmount = Math.max(1, Math.floor(fullAmount * .8));
    bench.xp = experienceAtLevel(bench.level + 1, getSpecies(bench.speciesId).growthRate) - sharedAmount;
    const before = { active: active.xp, activeLevel: active.level, bench: bench.xp, fainted: fainted.xp, boxed: boxed.xp };
    defeated.hp = 0;
    const result = actBattle(state, { type: 'wait' }, 4);

    expect(result.experienceGains).toEqual([
      { instanceId: active.instanceId, amount: fullAmount, levelsGained: active.level - before.activeLevel, shared: false },
      { instanceId: bench.instanceId, amount: sharedAmount, levelsGained: 1, shared: true },
    ]);
    expect(active.xp).toBe(before.active + fullAmount);
    expect(bench.level).toBe(6);
    expect(fainted.xp).toBe(before.fainted);
    expect(boxed.xp).toBe(before.boxed);
    expect(active.brain).toBe(activeBrain);
    expect(bench.brain).toBe(benchBrain);
    expect(active.brain).not.toBe(bench.brain);
  });

  it('경험치 공유를 끄면 활성 개체만 기존 전체 경험치를 받는다', () => {
    const state = createGame(1, 'experience-share-disabled');
    state.experienceShare = false;
    const bench = createMonster(state, 7, 5);
    state.player.team.push(bench);
    const battle = wildBattle(state, 4, 5);
    const active = state.player.team[0];
    const beforeBenchXp = bench.xp;
    battle.enemy.team[0].hp = 0;
    const result = actBattle(state, { type: 'wait' }, 4);
    expect(result.experienceGains).toHaveLength(1);
    expect(result.experienceGains[0]).toMatchObject({ instanceId: active.instanceId, shared: false });
    expect(bench.xp).toBe(beforeBenchXp);
  });

  it('다중 상대의 첫 승리 뒤 저장 복원해도 같은 상대 경험치를 다시 주지 않는다', () => {
    const state = createGame(1, 'experience-no-replay');
    state.player.team[0] = createMonster(state, 1, 50);
    state.defeatedGyms = Array.from({ length: 8 }, (_, index) => index + 1);
    state.player.badges = 8;
    challengeChampion(state);
    state.battle!.enemy.team[0].hp = 0;
    const first = actBattle(state, { type: 'wait' }, 4);
    expect(first.experienceGains.length).toBe(1);
    const restored = restoreGame(serializeGame(state));
    const xpAfterFirst = restored.player.team[0].xp;
    const nextTurn = actBattle(restored, { type: 'wait' }, 4);
    expect(nextTurn.experienceGains).toEqual([]);
    expect(restored.player.team[0].xp).toBe(xpAfterFirst);
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

  it('회복·버프·상태 기술의 실제 효과를 기술 선택 학습용 텔레메트리로 반환한다', () => {
    const state = createGame(1, 'strategic-move-telemetry');
    const player = state.player.team[0];
    player.moves = [105, 14, 50, 33].map(moveId => ({ moveId, pp: getMove(moveId).pp }));
    player.hp = Math.floor(player.stats.hp / 2);
    const battle = wildBattle(state, 4, 5);

    const recovery = actBattle(state, { type: 'move', index: 0 }, 4).executedMoves[0];
    expect(recovery).toMatchObject({ moveId: 105, category: 'healing', strategicEffect: true });
    expect(recovery.hpRecovered).toBeGreaterThan(0);

    const buff = actBattle(state, { type: 'move', index: 1 }, 4).executedMoves[0];
    expect(buff).toMatchObject({ moveId: 14, category: 'buff', statStageDelta: 2, strategicEffect: true });
    expect(battle.statStages?.[player.instanceId]?.attack).toBe(2);

    const status = actBattle(state, { type: 'move', index: 2 }, 4).executedMoves[0];
    expect(status).toMatchObject({ moveId: 50, category: 'status', ailmentApplied: true, strategicEffect: true });
  });

  it('기술별 학습 통계를 개체 저장과 함께 검증하고 복원한다', () => {
    const state = createGame(1, 'move-learning-save');
    const moveId = state.player.team[0].moves[0].moveId;
    state.player.team[0].moveLearning = { [moveId]: { choices: 4, executed: 3, effective: 2, reward: .75 } };
    expect(restoreGame(serializeGame(state)).player.team[0].moveLearning?.[moveId]).toEqual({ choices: 4, executed: 3, effective: 2, reward: .75 });
    state.player.team[0].moveLearning[moveId].effective = 4;
    expect(() => restoreGame(serializeGame(state))).toThrow('기술 학습 통계');
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
    for (let stage = 0; stage < 5; stage++) {
      challengeChampion(state);
      while (state.battle) {
        state.battle.enemy.team[state.battle.enemy.activeIndex].hp = 0;
        actBattle(state, { type: 'wait' }, 4);
      }
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

    const legacy = JSON.parse(serializeGame(state)); delete legacy.experienceShare;
    expect(restoreGame(JSON.stringify(legacy)).experienceShare).toBe(true);
    const invalidShare = JSON.parse(serializeGame(state)); invalidShare.experienceShare = 'yes';
    expect(() => restoreGame(JSON.stringify(invalidShare))).toThrow(/경험치 공유/);
  });
});
