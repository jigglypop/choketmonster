import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGame, explore, actBattle, heal, type GameState } from '../src/game/engine';
import { ConnectomeController } from '../src/game/connectome';
import { packSave, unpackSave, defaultView } from '../src/game/storage';
import type { Graph } from '../src/core/brain';
import { FieldSimulation } from '../src/game/field';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
function battleGame(): GameState {
  const game = createGame(1, 4312);
  while (!game.battle) explore(game, game.regionId);
  const brain = new ConnectomeController(graph);
  for (const mon of [...game.player.team, ...game.battle!.enemy.team]) brain.ensure(mon);
  return game;
}

describe('full game checkpoint integration', () => {
  it('writes a bounded trade epoch and rejects malformed trade versions', () => {
    const save = packSave(createGame(1, 'trade-epoch'), graph, defaultView());
    expect(save.tradeEpoch).toBe(0);
    save.tradeEpoch = -1;
    expect(() => unpackSave(save, graph)).toThrow(/거래 버전/);
  });
  it('preserves the original collection version for backup before migrating a decoded world', () => {
    const game = createGame(1, 'backup-before-map-migration');
    const world = new OpenWorldSimulation(graph, game, 412);
    game.adventureVersion = 'gold'; game.versionCaught ??= {}; game.versionCaught.gold = [1];
    const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot() });
    const loaded = unpackSave(save, graph);
    expect(loaded.game.adventureVersion).toBe('gold');
    expect(loaded.game.versionCaught?.gold).toEqual([1]);
    expect(loaded.view.openWorld).toEqual(save.view.openWorld);
    const backup = packSave(loaded.game, graph, loaded.view);
    new OpenWorldSimulation(graph, loaded.game, world.seed, loaded.view.openWorld);
    expect(loaded.game.adventureVersion).toBe('gold');
    expect((backup.game as GameState).adventureVersion).toBe('gold');
    expect((backup.game as GameState).versionCaught?.gold).toEqual([1]);
    expect(backup.view.openWorld).toEqual(save.view.openWorld);
  });
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
  it('restores server JSON whose object keys were reordered without accepting changed edges', () => {
    const save = packSave(createGame(4, 2026), graph, defaultView());
    const sorted = JSON.parse(JSON.stringify(save, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => b.localeCompare(a))) : value));
    expect(unpackSave(sorted, graph).game.player.team[0].speciesId).toBe(4);
    sorted.graph.edges[0].weight += .001;
    expect(() => unpackSave(sorted, graph)).toThrow(/커넥톰/);
  });
  it('restores healing on the same monster after a saved battle', () => {
    const original = battleGame();
    original.battle!.player.team[0].hp = 2;
    const restored = unpackSave(packSave(original, graph, defaultView()), graph).game;
    delete restored.battle; heal(restored);
    expect(restored.player.team[0].hp).toBe(restored.player.team[0].stats.hp);
  });
  it('enables technique learning once for legacy views and preserves a later opt-out', () => {
    expect(defaultView()).toMatchObject({ learning: true, learningDefaultsVersion: 1 });
    const legacy = packSave(createGame(1, 991), graph, defaultView());
    legacy.view.learning = false; delete legacy.view.learningDefaultsVersion;
    expect(unpackSave(legacy, graph).view).toMatchObject({ learning: true, learningDefaultsVersion: 1 });

    const optedOut = packSave(createGame(1, 992), graph, { ...defaultView(), learning: false });
    expect(unpackSave(optedOut, graph).view).toMatchObject({ learning: false, learningDefaultsVersion: 1 });
    (optedOut.view as { learningDefaultsVersion?: number }).learningDefaultsVersion = 2;
    expect(() => unpackSave(optedOut, graph)).toThrow(/위치/);
  });
});
