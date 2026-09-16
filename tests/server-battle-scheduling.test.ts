import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Graph } from '../src/core/brain';
import { createGame } from '../src/game/engine';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const remote = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock('../src/game/server-brain', () => ({ usesServerBrain: () => true, chooseServerBrains: remote.choose }));
const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const decision = { action: 4, updates: 0, activity: .2, elapsedMs: 40, graphId: 'fixture', nodes: 166700, edges: 25582938 };
function fixture() {
  const game = createGame(1, 'server-clock'), world = new OpenWorldSimulation(graph, game, 123);
  const wild = world.entities.find(entity => entity.kind === 'wild')!;
  const companion = world.entities.find(entity => entity.kind === 'companion')!;
  world.player = { x: wild.x, z: wild.z, heading: 0 };
  Object.assign(companion, world.player);
  expect(world.startEncounter(wild.id)).toBe(true);
  return world;
}
beforeEach(() => { remote.choose.mockReset().mockImplementation((_controller, choices) => Promise.resolve(choices.map(() => decision))); });
describe('server decisions and the independent world clock', () => {
  it('keeps ticking during network delay without inventing a battle action', async () => {
    const world = fixture();
    let resolve!: (value: typeof decision[]) => void;
    remote.choose.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = world.prepareServerBattle(false), initialTurn = world.game.battle!.turn;
    for (let i = 0; i < 8; i++) {
      const result = world.step({ deltaSeconds: .25 });
      expect(result.events.some(event => event.type === 'battle-turn')).toBe(false);
    }
    expect(world.tick).toBe(8);
    expect(world.game.battle!.turn).toBe(initialTurn);
    resolve([decision, decision]); await pending;
    expect(remote.choose).toHaveBeenCalledTimes(1);
    expect(remote.choose.mock.calls[0][1]).toHaveLength(2);
    expect(remote.choose.mock.calls[0][1].every((choice: { context: { automatic: boolean } }) => choice.context.automatic)).toBe(true);
    expect(world.step({ deltaSeconds: .25 }).events.some(event => event.type === 'battle-turn')).toBe(true);
    expect(world.game.battle!.turn).toBe(initialTurn + 1);
  });
  it('fills a missing partner decision when manual play changes to automatic during a request', async () => {
    const world = fixture(); world.setControlMode('manual');
    expect(world.requestAction({ type: 'wait' })).toBe(true);
    await world.prepareServerBattle(false);
    expect(remote.choose).toHaveBeenCalledTimes(1);
    world.setControlMode('auto');
    expect(world.step({ deltaSeconds: 1 }).events.some(event => event.type === 'battle-turn')).toBe(false);
    await world.prepareServerBattle(false);
    expect(remote.choose).toHaveBeenCalledTimes(2);
    expect(world.step({ deltaSeconds: .25 }).events.some(event => event.type === 'battle-turn')).toBe(true);
  });
});
