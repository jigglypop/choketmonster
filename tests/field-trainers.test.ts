import { describe, expect, it } from 'vitest';
import { FIELD_TRAINERS, availableFieldTrainer } from '../src/data/field-trainers';
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
    expect(availableFieldTrainer('johto', trainer.locationId, [])?.id).toBe(trainer.id);
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
    expect(FIELD_TRAINERS.filter(trainer => trainer.locationId === 'route-30')).toHaveLength(3);
  });
});
