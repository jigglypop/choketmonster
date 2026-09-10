import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGame, explore, actBattle, heal, type GameState } from '../src/game/engine';
import { ConnectomeController } from '../src/game/connectome';
import { packSave, unpackSave, defaultView } from '../src/game/storage';
import type { Graph } from '../src/core/brain';
import { FieldSimulation } from '../src/game/field';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
function battleGame(): GameState {
  const game = createGame(1, 4312);
  while (!game.battle) explore(game, game.regionId);
  const brain = new ConnectomeController(graph);
  for (const mon of [...game.player.team, ...game.battle!.enemy.team]) brain.ensure(mon);
  return game;
}

describe('full game checkpoint integration', () => {
  it('saves field and battle memories independently with exact field continuation', () => {
    const game = battleGame(), view = defaultView(), members = game.player.team.map(mon => ({ id: mon.instanceId, speciesId: mon.speciesId }));
    const battleMemory = structuredClone(game.player.team[0].brain);
    const field = new FieldSimulation(graph, 3245, members);
    for (let i = 0; i < 8; i++) field.step(true);
    field.setRecurrentEnabled(false);
    view.field = field.snapshot(); view.fieldPreferences = { paused: true, learning: false, selectedId: members[0].id };
    const text = JSON.stringify(packSave(game, graph, view));
    expect(text.match(/"edges":/g)).toHaveLength(1);
    const saved = unpackSave(text, graph);
    expect(saved.game.player.team[0].brain).toEqual(battleMemory);
    expect(saved.view.fieldPreferences).toEqual(view.fieldPreferences);
    const restored = new FieldSimulation(graph, 3245, members, saved.view.field);
    for (let i = 0; i < 6; i++) expect(restored.step(false)).toEqual(field.step(false));
    expect(restored.snapshot()).toEqual(field.snapshot());
    const tampered = JSON.parse(text); tampered.view.field.entities[0].brain.sensoryBypass = true;
    expect(() => unpackSave(tampered, graph)).toThrow();
  });
  it('deduplicates the graph and restores shared battle ownership and independent memories', () => {
    const game = battleGame(), packed = packSave(game, graph, defaultView());
    const text = JSON.stringify(packed);
    expect(text.match(/"edges":/g)).toHaveLength(1);
    const restored = unpackSave(text, graph).game;
    expect(restored.battle!.player.team).toBe(restored.player.team);
    expect(restored.player.team[0].brain!.graph).toEqual(graph);
    expect(restored.battle!.enemy.team[0].brain).not.toBe(restored.player.team[0].brain);
    actBattle(restored, { type: 'move', index: 0 }, 4);
    expect(restored.battle?.player.team[0]?.moves ?? restored.player.team[0].moves).toEqual(restored.player.team[0].moves);
    expect(game.player.team[0].moves).not.toEqual(restored.player.team[0].moves);
  });
  it('replays the exact game and neural trajectory after a mid-battle JSON roundtrip', () => {
    const game = battleGame(), controller = new ConnectomeController(graph), view = defaultView();
    view.rewards = { [game.player.team[0].instanceId]: .2 };
    const restored = unpackSave(JSON.stringify(packSave(game, graph, view)), graph);
    expect(restored.view.rewards).toEqual(view.rewards);
    const step = (state: GameState) => {
      const b = state.battle!, self = b.player.team[b.player.activeIndex], enemy = b.enemy.team[b.enemy.activeIndex];
      const decision = controller.choose(enemy, self, b.turn);
      return actBattle(state, { type: 'move', index: 0 }, decision.action);
    };
    for (let turn = 0; turn < 5 && game.battle; turn++) {
      expect(step(restored.game)).toEqual(step(game));
      expect(restored.game).toEqual(game);
    }
  });
  it('rejects changed edges, invalid memory, and invalid position without mutating the original', () => {
    const game = battleGame(), before = JSON.stringify(game);
    const altered = packSave(game, graph, defaultView()); altered.graph.edges[0].weight += .01;
    expect(() => unpackSave(altered, graph)).toThrow(/커넥톰/);
    const malformed = packSave(game, graph, defaultView());
    (malformed.game as GameState).player.team[0].brain!.readout[0][0] = Infinity;
    expect(() => unpackSave(malformed, graph)).toThrow();
    const badView = packSave(game, graph, defaultView()); badView.view.position.x = 18;
    expect(() => unpackSave(badView, graph)).toThrow(/위치/);
    expect(JSON.stringify(game)).toBe(before);
  });
  it('keeps source text corrections compatible while preserving the installed graph', () => {
    const save = packSave(createGame(7, 6), graph, defaultView());
    save.graph.provenance.note = 'Older documentation text';
    expect(unpackSave(save, graph).graph).toEqual(graph);
  });
  it('restores healing on the same monster after a saved battle', () => {
    const original = battleGame();
    original.battle!.player.team[0].hp = 2;
    const restored = unpackSave(packSave(original, graph, defaultView()), graph).game;
    delete restored.battle; heal(restored);
    expect(restored.player.team[0].hp).toBe(restored.player.team[0].stats.hp);
  });
});
