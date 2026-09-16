import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { getMove, getSpecies } from '../src/data/pokemon';
import { actBattle, createGame, createMonster, evolve, experienceAtLevel, restoreGame, serializeGame, validateGame } from '../src/game/engine';
import { evolutionProgress } from '../src/game/evolution-progress';
import { OpenWorldSimulation } from '../src/openworld/simulation';

describe('evolution growth from real engine events', () => {
  it('records executed moves, skips sleep, and restores the independent records', () => {
    const game = createGame(1, 'evolution-actions'), mon = createMonster(game, 57, 50), foe = createMonster(game, 143, 100);
    mon.moves = [{ moveId: 889, pp: getMove(889).pp }]; mon.status = 'sleep'; mon.statusTurns = 2;
    game.player.team = [mon]; game.dex.seen = [1, 57, 143]; game.dex.caught = [1, 57];
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [foe], activeIndex: 0 }, turn: 1, canRun: true };
    actBattle(game, { type: 'move', index: 0 }, 4);
    expect(evolutionProgress(mon).moveUses['889']).toBeUndefined();
    const turn = actBattle(game, { type: 'move', index: 0 }, 4);
    expect(turn.executedMoves.some(move => move.actorInstanceId === mon.instanceId && move.moveId === 889)).toBe(true);
    expect(evolutionProgress(mon).moveUses['889']).toBe(1);
    expect(evolutionProgress(foe).moveUses['889']).toBeUndefined();
    const restored = restoreGame(serializeGame(game));
    expect(restored.player.team[0].evolutionProgress).toEqual(mon.evolutionProgress);
  });

  it('counts successful partner travel, excludes teleport attempts, and preserves the game RNG', () => {
    const game = createGame(1, 'evolution-walk');
    const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
    const world = new OpenWorldSimulation(graph, game, 500);
    world.controlMode = 'manual';
    const start = { ...world.player }, rng = game.rngState;
    expect(world.movePartner({ ...start, x: start.x + 100 })).toBe(false);
    expect(evolutionProgress(game.player.team[0]).steps).toBe(0);
    for (let i = 0; i < 8; i++) expect(world.movePartner({ ...start, x: start.x + (i % 2 ? 0 : .5) })).toBe(true);
    expect(evolutionProgress(game.player.team[0]).steps).toBe(4);
    expect(game.rngState).toBe(rng);
  });

  it('preserves level progress across a change in experience growth rate', () => {
    const game = createGame(1, 'evolution-growth-rate'), mon = createMonster(game, 840, 35);
    game.player.team = [mon]; game.dex.seen = [1, 840]; game.dex.caught = [1, 840];
    const oldRate = getSpecies(840).growthRate, rate = getSpecies(1011).growthRate;
    mon.xp += Math.floor((experienceAtLevel(36, oldRate) - mon.xp) / 2);
    game.inventory['syrupy-apple'] = 1;
    evolve(game, mon.instanceId, { targetId: 1011, item: 'syrupy-apple' });
    const ratio = (mon.xp - experienceAtLevel(35, rate)) / (experienceAtLevel(36, rate) - experienceAtLevel(35, rate));
    expect(mon.level).toBe(35); expect(ratio).toBeCloseTo(.5, 2);
    expect(restoreGame(serializeGame(game)).player.team[0].speciesId).toBe(1011);
  });

  it('rejects corrupt growth records without replacing explicit invalid values', () => {
    const state = createGame(1, 'bad-evolution-growth');
    for (const changed of [null, { ...state.player.team[0].evolutionProgress, friendship: 256 },
      { ...state.player.team[0].evolutionProgress, moveUses: { '01': 2 } },
      { ...state.player.team[0].evolutionProgress, extra: true }]) {
      const value = structuredClone(state); value.player.team[0].evolutionProgress = changed as never;
      expect(() => validateGame(value)).toThrow(/진화 성장 기록/);
    }
  });

  it('migrates missing monster gender from valid legacy progress and keeps saved battle copies canonical', () => {
    const state = createGame(1, 'legacy-gender'), owned = state.player.team[0], enemy = createMonster(state, 19, 5);
    const preserved = owned.gender === 'male' ? 'female' : 'male';
    evolutionProgress(owned).gender = preserved;
    delete owned.gender;
    state.battle = { kind: 'wild', regionId: state.regionId, player: { team: structuredClone(state.player.team), activeIndex: 0 },
      enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
    const migrated = validateGame(structuredClone(state));
    expect(migrated.player.team[0].gender).toBe(preserved);
    expect(migrated.player.team[0].evolutionProgress?.gender).toBe(preserved);
    expect(migrated.battle?.player.team).toBe(migrated.player.team);

    const fixed = createGame(1, 'legacy-fixed-gender'), gallade = createMonster(fixed, 475, 30);
    fixed.player.team = [gallade]; gallade.gender = undefined; evolutionProgress(gallade).gender = 'female';
    validateGame(fixed);
    expect(gallade.gender).toBe('male'); expect(evolutionProgress(gallade).gender).toBe('male');
  });
});
