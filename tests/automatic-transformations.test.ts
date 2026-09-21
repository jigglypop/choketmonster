import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { actBattle, applyPreferredBattleTransformation, assignPreferredTransformation, challengeGym, createGame, createMonster, restoreGame, serializeGame } from '../src/game/engine';
import { OpenWorldSimulation } from '../src/openworld/simulation';
import { transformationSettingsHtml } from '../src/ui/transformation-settings';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
function setup() {
  const game = createGame(4, 'automatic-forms'), lead = createMonster(game, 6, 5), reserve = createMonster(game, 9, 5);
  game.player.team = [lead, reserve];
  game.inventory['mega-stone:charizard-mega-x'] = 1;
  assignPreferredTransformation(game, lead.instanceId, { kind: 'mega', formIdentifier: 'charizard-mega-x' });
  game.inventory['mega-stone:blastoise-mega'] = 1;
  assignPreferredTransformation(game, reserve.instanceId, { kind: 'mega', formIdentifier: 'blastoise-mega' });
  return { game, lead, reserve };
}

describe('saved automatic transformations', () => {
  it('applies at a real wild encounter before any turn or decision', () => {
    const { game, lead } = setup(), world = new OpenWorldSimulation(graph, game, 421);
    const wild = world.entities.find(entity => entity.kind === 'wild')!;
    world.player = { x: wild.x, z: wild.z, heading: 0 };
    expect(world.startEncounter(wild.id)).toBe(true);
    expect(game.battle!.turn).toBe(1);
    expect(game.battle!.transformations?.[lead.instanceId]).toMatchObject({ kind: 'mega', formIdentifier: 'charizard-mega-x' });
    expect(game.battle!.playerMegaUsed).toBe(true);
  });

  it('applies on gym entry and switching, persists on reload and does not stack', () => {
    const { game, lead, reserve } = setup();
    challengeGym(game, 'safari-meadow');
    expect(game.battle!.transformations?.[lead.instanceId]?.kind).toBe('mega');
    actBattle(game, { type: 'switch', index: 1 }, 4);
    expect(game.battle!.transformations?.[reserve.instanceId]).toBeUndefined();
    const loaded = restoreGame(serializeGame(game));
    expect(loaded.player.team[1].preferredTransformation).toEqual({ kind: 'mega', formIdentifier: 'blastoise-mega' });
    const previous = structuredClone(loaded.battle!.transformations);
    actBattle(loaded, { type: 'switch', index: 0 }, 4);
    expect(loaded.battle!.transformations).toEqual(previous);
    expect(loaded.battle!.turn).toBe(3);
  });

  it('applies after a faint switch while enforcing one use of each kind per battle', () => {
    const { game, lead, reserve } = setup(), other = createMonster(game, 6, 5);
    game.player.team.push(other);
    game.inventory['mega-stone:charizard-mega-y'] = 1;
    assignPreferredTransformation(game, other.instanceId, { kind: 'mega', formIdentifier: 'charizard-mega-y' });
    challengeGym(game, 'safari-meadow');
    lead.hp = 0; game.battle!.awaitingSwitch = 'player';
    actBattle(game, { type: 'switch', index: 1 }, 4);
    expect(game.battle!.transformations?.[reserve.instanceId]).toBeUndefined();
    actBattle(game, { type: 'switch', index: 2 }, 4);
    expect(game.battle!.transformations?.[other.instanceId]).toBeUndefined();
  });

  it('restores a configured active battle without charging a turn', () => {
    const { game, lead } = setup();
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, 19, 5)], activeIndex: 0 }, turn: 1, canRun: true };
    const loaded = restoreGame(serializeGame(game));
    expect(loaded.battle!.transformations?.[lead.instanceId]?.kind).toBe('mega');
    expect(loaded.battle!.turn).toBe(1);
    applyPreferredBattleTransformation(loaded);
    expect(loaded.battle!.turn).toBe(1);
    expect(() => assignPreferredTransformation(loaded, lead.instanceId)).toThrow();
  });

  it('rejects missing 3D forms and malformed preferences, and keeps legacy saves off', () => {
    const game = createGame(4, 'invalid-preferences'), clefable = createMonster(game, 36, 5);
    game.player.box.push(clefable);
    expect(() => assignPreferredTransformation(game, clefable.instanceId, { kind: 'mega', formIdentifier: 'clefable-mega' })).toThrow();
    expect(transformationSettingsHtml(clefable, false)).not.toContain('mega:');
    expect(() => assignPreferredTransformation(game, clefable.instanceId, { kind: 'tera', teraType: 'water', extra: true } as any)).toThrow();
    expect(restoreGame(serializeGame(game)).player.team[0].preferredTransformation).toBeUndefined();
    expect(() => assignPreferredTransformation(game, clefable.instanceId, { kind: 'tera', teraType: 'water' } as any)).toThrow();
    assignPreferredTransformation(game, clefable.instanceId);
    expect(clefable.preferredTransformation).toBeUndefined();
  });
});
