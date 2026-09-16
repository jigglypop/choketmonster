import { describe, expect, it } from 'vitest';
import { FIELD_TRAINERS, availableFieldTrainer, fieldTrainersAt } from '../src/data/field-trainers';
import { readFileSync } from 'node:fs';
import { OpenWorldSimulation, restoreOpenWorld, serializeOpenWorld } from '../src/openworld/simulation';
import { actBattle, challengeFieldTrainer, createGame, validateGame } from '../src/game/engine';

describe('Johto field trainers', () => {
  it('starts a sourced ordinary trainer battle and validates its saved state', () => {
    const game = createGame(152, 'field-trainer');
    const trainer = FIELD_TRAINERS[0];
    const battle = challengeFieldTrainer(game, trainer);
    expect(battle.kind).toBe('trainer');
    expect(battle.canRun).toBe(false);
    expect(battle.enemy.team.map(monster => [monster.speciesId, monster.level])).toEqual(trainer.team);
    expect(validateGame(structuredClone(game)).battle?.trainerId).toBe(trainer.id);
  });

  it('does not offer defeated trainers again', () => {
    const trainer = FIELD_TRAINERS[0];
    expect(availableFieldTrainer('johto', trainer.locationId, [])).toBeDefined();
    expect(availableFieldTrainer('johto', trainer.locationId, [trainer.id])?.id).not.toBe(trainer.id);
  });

  it('persists an ordinary trainer victory separately from league progress', () => {
    const game = createGame(152, 'field-trainer-win');
    const trainer = FIELD_TRAINERS.find(item => item.locationId === 'route-30')!;
    const battle = challengeFieldTrainer(game, trainer);
    for (const enemy of battle.enemy.team) enemy.hp = 0;
    expect(actBattle(game, { type: 'wait' }).outcome).toBe('won');
    expect(validateGame(structuredClone(game)).defeatedFieldTrainers).toContain(trainer.id);
    expect(game.campaign?.johtoLeague).toBe(0);
  });

  it('contains the generated Johto map roster instead of a hand-picked sample', () => {
    expect(FIELD_TRAINERS.length).toBeGreaterThan(150);
    expect(new Set(FIELD_TRAINERS.map(trainer => trainer.locationId)).size).toBeGreaterThan(30);
    expect(FIELD_TRAINERS.filter(trainer => trainer.locationId === 'route-30' && trainer.trainerOrigin === 'source')).toHaveLength(3);
  });

  it('starts a local menu challenge without NPCs, restores it, and rejects a remote trainer', () => {
    const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
    const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
    const game = createGame(152, 'trainer-menu'), world = new OpenWorldSimulation(graph, game, 91234, undefined, policy);
    const local = world.locationAt(world.player.x, world.player.z);
    const trainer = fieldTrainersAt(world.regionId, local.id).find(item => item.trainerOrigin === 'authored')!;
    const remote = FIELD_TRAINERS.find(item => item.region !== world.regionId)!;
    expect(world.challengeFieldTrainerById(remote.id)).toBe(false);
    world.setControlMode('manual');
    expect(world.challengeFieldTrainerById(trainer.id)).toBe(true);
    expect(world.controlMode).toBe('auto');
    expect(world.trainerRenderData()).toEqual([]);
    const restored = restoreOpenWorld(graph, serializeOpenWorld(game, world), policy);
    expect(restored.game.battle?.trainerId).toBe(trainer.id);
    const invalid = structuredClone(game);
    invalid.battle!.enemy.team[0].speciesId = 1;
    expect(() => validateGame(invalid)).toThrow();
  });
});
