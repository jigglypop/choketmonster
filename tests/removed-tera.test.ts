import { describe, expect, it } from 'vitest';
import { activateBattleTransformation, assignAlolaForm, assignPreferredTransformation, battleMonsterView, createGame, createMonster, restoreGame, serializeGame } from '../src/game/engine';
import { transformationSettingsHtml } from '../src/ui/transformation-settings';

describe('removed Terastallization', () => {
  it('migrates legacy active Tera and preferences while preserving identity, HP, spent PP and progress', () => {
    const game = createGame(1, 'legacy-tera'), lead = createMonster(game, 26, 30), enemy = createMonster(game, 143, 30);
    game.player.team = [lead]; assignAlolaForm(game, lead.instanceId, true);
    lead.hp = 7; lead.xp += 12;
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 7, canRun: true };
    const save = JSON.parse(serializeGame(game));
    save.player.team[0].preferredTransformation = { kind: 'tera', teraType: 'water' };
    save.battle.player.team[0].preferredTransformation = { kind: 'tera', teraType: 'water' };
    save.battle.playerTeraUsed = true;
    save.battle.transformations = { [lead.instanceId]: { speciesId: 26, kind: 'tera', teraType: 'water', types: ['water'], stats: lead.stats, moves: lead.moves.map(slot => ({ ...slot, pp: 1 })) } };
    const restored = restoreGame(JSON.stringify(save));
    expect(restored.player.team[0]).toMatchObject({ instanceId: lead.instanceId, hp: 7, xp: lead.xp, regionalForm: 'raichu-alola' });
    expect(restored.player.team[0].moves.every(slot => slot.pp === 1)).toBe(true);
    expect(restored.player.team[0].preferredTransformation).toBeUndefined();
    expect(restored.battle!.transformations).toBeUndefined();
    expect(restored.battle!.turn).toBe(7);
    expect(restored.battle!.player.team).toBe(restored.player.team);
    expect(battleMonsterView(restored.battle!, restored.player.team[0]).types).toEqual(['electric', 'psychic']);
    expect(serializeGame(restored)).not.toContain('teraType');
  });
  it('exposes only Mega and rejects legacy Tera activation and setup', () => {
    const game = createGame(4, 'tera-disabled'), lead = createMonster(game, 6, 30);
    game.player.team = [lead];
    expect(transformationSettingsHtml(lead, false)).not.toContain('tera:');
    expect(() => assignPreferredTransformation(game, lead.instanceId, { kind: 'tera', teraType: 'water' } as any)).toThrow();
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, 143, 30)], activeIndex: 0 }, turn: 1, canRun: true };
    expect(() => activateBattleTransformation(game, 'tera' as any)).toThrow();
    expect(game.battle.transformations).toBeUndefined();
  });
});
