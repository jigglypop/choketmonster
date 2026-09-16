import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { FIELD_TRAINERS } from '../src/data/field-trainers';
import { challengeFieldTrainer, createGame } from '../src/game/engine';
import type { FieldPolicy } from '../src/game/field';
import { OpenWorldSimulation, restoreOpenWorld, serializeOpenWorld } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
const setup = () => {
  const game = createGame(1, 'explore-35212');
  const world = new OpenWorldSimulation(graph, game, 35212, undefined, policy);
  world.setControlMode('auto');
  return { game, world };
};

describe('field exploration without human NPCs', () => {
  it('tracks a nearby wild Pokemon and replays without learning', () => {
    const { game, world } = setup(), origin = { ...world.player };
    const companion = world.entities.find(entity => entity.kind === 'companion')!;
    const memory = structuredClone([companion.brain.inputWeights, companion.brain.readout, companion.brain.updates]);
    for (let i = 0; i < 8; i++) world.step({ deltaSeconds: .25, learning: false, epsilon: 0 });
    expect(companion.target?.kind).toBe('wild');
    expect(world.sampleWorld(companion.target!.x, companion.target!.z).blocked).toBe(false);
    const replay = restoreOpenWorld(graph, serializeOpenWorld(game, world), policy);
    let radius = 0;
    for (let i = 0; i < 40; i++) {
      expect(world.step({ deltaSeconds: .25, learning: false, epsilon: 0 }))
        .toEqual(replay.simulation.step({ deltaSeconds: .25, learning: false, epsilon: 0 }));
      expect(world.sampleWorld(world.player.x, world.player.z).blocked).toBe(false);
      radius = Math.max(radius, Math.hypot(world.player.x - origin.x, world.player.z - origin.z));
    }
    expect(radius).toBeGreaterThan(0);
    expect(world.snapshot()).toEqual(replay.simulation.snapshot());
    expect([companion.brain.inputWeights, companion.brain.readout, companion.brain.updates]).toEqual(memory);
  });

  it('keeps historical trainer records and an existing battle loadable without respawning NPCs', () => {
    const game = createGame(152, 'trainer-compatibility'), world = new OpenWorldSimulation(graph, game, 91234, undefined, policy);
    const trainer = FIELD_TRAINERS[0];
    game.defeatedFieldTrainers = [FIELD_TRAINERS[1].id];
    challengeFieldTrainer(game, trainer);
    world.battleWildId = `trainer:${trainer.id}`;
    const restored = restoreOpenWorld(graph, serializeOpenWorld(game, world), policy);
    expect(restored.game.defeatedFieldTrainers).toEqual(game.defeatedFieldTrainers);
    expect(restored.game.battle?.trainerId).toBe(trainer.id);
    expect(restored.simulation.trainerRenderData()).toEqual([]);
    expect(restored.simulation.localFieldTrainer?.region).toBe('johto');
    expect(restored.simulation.challengeFieldTrainerById(trainer.id)).toBe(false);
  });

  it('keeps full daytime brightness when restoring or advancing any legacy encounter clock', () => {
    const { world } = setup();
    for (const seconds of [0, 200, 300, 600, 1000, 1199]) {
      world.synchronizeWorldClock(seconds * 1000);
      expect(world.daylightIntensity).toBe(1);
    }
  });
});
