import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Graph } from '../src/core/brain';
import { Random } from '../src/core/random';
import { createGame, createMonster, type InventoryItem } from '../src/game/engine';
import { OpenWorldSimulation, restoreOpenWorld, serializeOpenWorld } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
function encounter() {
  const game = createGame(1, 'field-item-integration'), world = new OpenWorldSimulation(graph, game, 9);
  world.setControlMode('manual'); world.setAutoHunt(false);
  world.autoCapture = false;
  const target = world.entities.find(entity => entity.kind === 'wild')!;
  world.player = { x: target.x, z: target.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  expect(world.startEncounter(target.id)).toBe(true);
  return { game, world };
}

describe('field battle rewards', () => {
  it('awards only after a successful capture, once, and preserves inventory across restore', () => {
    const { game, world } = encounter();
    game.battle!.enemy.team[0] = createMonster(game, 94, 5);
    game.battle!.enemy.team[0].hp = 0;
    world.requestAction({ type: 'wait' });
    const step = world.step({ deltaSeconds: 1 });
    expect(step.events.some(event => event.type === 'item-drop')).toBe(false);
    expect(game.captureOffer).toBeDefined();
    const random = vi.spyOn(Random.prototype, 'next').mockReturnValue(0);
    try { expect(world.captureVictory()).toBe(true); } finally { random.mockRestore(); }
    const drop = world.drainItemDropEvents()[0];
    expect(drop.itemId).toBe('mega-stone:gengar-mega');
    expect(game.inventory[drop.itemId as InventoryItem]).toBe(1);
    expect(world.captureVictory()).toBe(false);
    const restored = restoreOpenWorld(graph, serializeOpenWorld(game, world));
    expect(restored.game.inventory[drop.itemId as InventoryItem]).toBe(1);
    expect(restored.simulation.drainItemDropEvents()).toEqual([]);
  });

  it('does not award field items on defeat', () => {
    const { game, world } = encounter(), inventory = structuredClone(game.inventory);
    game.player.team[0].hp = 0;
    world.requestAction({ type: 'wait' });
    const random = vi.spyOn(Random.prototype, 'next').mockReturnValue(0);
    let step;
    try { step = world.step({ deltaSeconds: 1 }); } finally { random.mockRestore(); }
    expect(step.events.some(event => event.type === 'item-drop')).toBe(false);
    expect(game.inventory).toEqual(inventory);
  });
});
