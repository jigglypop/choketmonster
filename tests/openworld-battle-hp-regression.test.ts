import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain.ts';
import { getMove } from '../src/data/pokemon.ts';
import { createGame, createMonster, type GameState } from '../src/game/engine.ts';
import type { FieldPolicy } from '../src/game/field.ts';
import { defaultView, packSave, unpackSave } from '../src/game/storage.ts';
import { OpenWorldSimulation } from '../src/openworld/simulation.ts';

const loadGraph = async () => JSON.parse(await readFile(new URL('../public/data/connectome.json', import.meta.url), 'utf8')) as Graph;
const loadPolicy = async () => JSON.parse(await readFile(new URL('../public/data/openworld-policy.json', import.meta.url), 'utf8')) as FieldPolicy;

describe('open-world battle HP persistence', () => {
  it('keeps automatic attack damage on the active enemy through save packing and restore', async () => {
    const graph = await loadGraph(), policy = await loadPolicy();
    const game = createGame(1, 'open-world-enemy-hp-regression');
    const lead = createMonster(game, 54, 39);
    lead.moves = [{ moveId: 401, pp: getMove(401).pp }]; // One slot makes the automatic choice deterministic.
    game.player.team = [lead];

    const world = new OpenWorldSimulation(graph, game, 7013, undefined, policy);
    world.setControlMode('auto');
    const target = world.entities.find(entity => entity.kind === 'wild')!;
    target.level = 100;
    expect(world.startEncounter(target.id)).toBe(true);

    const enemy = game.battle!.enemy.team[0];
    enemy.status = 'sleep'; enemy.statusTurns = 3;
    const hpBefore = enemy.hp;
    let recordedDamage = 0;
    for (let turn = 0; turn < 4 && recordedDamage === 0; turn++) {
      const event = world.step({ deltaSeconds: 1 }).events.find(entry => entry.type === 'battle-turn');
      if (event?.type === 'battle-turn') recordedDamage = event.result.executedMoves.find(move => move.actorInstanceId === lead.instanceId)?.damage ?? 0;
    }

    expect(recordedDamage).toBeGreaterThan(0);
    expect(game.battle!.enemy.team[0]).toBe(enemy);
    expect(enemy.hp).toBe(hpBefore - recordedDamage);

    const packed = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
    expect((packed.game as GameState).battle!.enemy.team[0].hp).toBe(enemy.hp);
    expect(unpackSave(packed, graph).game.battle!.enemy.team[0].hp).toBe(enemy.hp);
  });
});
