import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import type { FieldPolicy } from '../src/game/field';
import { createGame, createMonster } from '../src/game/engine';
import { KANTO_START } from '../src/openworld/kanto';
import { movementSpeed, OpenWorldSimulation, sampleWorld } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;

function setup(seed: number) {
  const game = createGame(1, `kanto-navigation-${seed}`);
  const world = new OpenWorldSimulation(graph, game, seed, undefined, policy);
  return { game, world };
}

describe('Kanto navigation state', () => {
  it('migrates a v1 blocked position without mutating the checkpoint or replacing individual memories', () => {
    const { game, world } = setup(41_001);
    const checkpoint = world.snapshot();
    checkpoint.mapVersion = 'kanto-v1';
    checkpoint.player = { x: 0, z: 0, heading: 3 };
    const companion = checkpoint.entities.find(entity => entity.kind === 'companion')!;
    companion.x = 0; companion.z = 0;
    const input = structuredClone(checkpoint);
    const identities = checkpoint.entities.map(entity => ({ id: entity.id, brain: structuredClone(entity.brain) }));

    const migrated = new OpenWorldSimulation(graph, game, world.seed, checkpoint, policy);

    expect(checkpoint).toEqual(input);
    expect(sampleWorld(migrated.player.x, migrated.player.z).blocked).toBe(false);
    expect(migrated.entities.map(entity => entity.id)).toEqual(identities.map(entity => entity.id));
    const saved = migrated.snapshot();
    for (const identity of identities) {
      const after = saved.entities.find(entity => entity.id === identity.id)!;
      expect(after.brain, identity.id).toEqual(identity.brain);
    }
    expect(saved.mapVersion).toBe('kanto-v2');
  });

  it('teleports only to visited towns and persists safe arrivals and the v2 map head', () => {
    const { game, world } = setup(41_002);
    expect(world.teleportToTown('viridian')).toBe(false);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(world.teleportToTown('pallet')).toBe(true);
      expect(world.player).toEqual({ ...KANTO_START, heading: 0 });
      expect(sampleWorld(world.player.x, world.player.z).blocked).toBe(false);
      expect(world.entities.find(entity => entity.kind === 'companion')).toMatchObject(world.player);
    }

    world.visitedTownIds.push('viridian');
    expect(world.teleportToTown('viridian')).toBe(true);
    const checkpoint = world.snapshot();
    expect(checkpoint.mapVersion).toBe('kanto-v2');
    expect(checkpoint.visitedTownIds).toEqual(['pallet', 'viridian']);
    const restored = new OpenWorldSimulation(graph, game, world.seed, checkpoint, policy);
    expect(restored.visitedTownIds).toEqual(['pallet', 'viridian']);
    expect(sampleWorld(restored.player.x, restored.player.z).blocked).toBe(false);
  });

  it('rejects teleport while a battle or capture decision is active', () => {
    const battling = setup(41_003);
    const target = battling.world.entities.find(entity => entity.kind === 'wild')!;
    expect(battling.world.startEncounter(target.id)).toBe(true);
    const battlePosition = structuredClone(battling.world.player);
    expect(battling.world.teleportToTown('pallet')).toBe(false);
    expect(battling.world.player).toEqual(battlePosition);

    const deciding = setup(41_004);
    deciding.game.captureOffer = createMonster(deciding.game, 19, 3);
    const offerPosition = structuredClone(deciding.world.player);
    expect(deciding.world.teleportToTown('pallet')).toBe(false);
    expect(deciding.world.player).toEqual(offerPosition);
  });

  it('keeps an inspected wild pinned until tracking follows that exact individual', () => {
    const { world } = setup(41_005);
    world.densityRemaining = 3;
    const wilds = world.entities.filter(entity => entity.kind === 'wild');
    const chosen = wilds[0], nearer = wilds[1];
    Object.assign(chosen, { x: -68, z: 70 });
    Object.assign(nearer, { x: -68, z: 80 });

    world.selectWild(chosen.id, true);
    expect(world.controlMode).toBe('manual');
    expect(world.selectionPinned).toBe(true);
    expect(world.trackingSelected).toBe(false);
    world.step({ deltaSeconds: 0, learning: false });
    expect(world.selectedWildId).toBe(chosen.id);
    expect(world.entities.find(entity => entity.kind === 'companion')!.target?.kind).toBe('player');

    expect(world.trackSelected()).toBe(true);
    world.step({ deltaSeconds: 0, learning: false });
    expect(world.selectedWildId).toBe(chosen.id);
    expect(world.entities.find(entity => entity.kind === 'companion')!.target).toMatchObject({ kind: 'wild', id: chosen.id });
  });

  it('uses species base Speed with modest level growth and rejects a locked corridor crossing', () => {
    expect(movementSpeed(150, 5)).toBeGreaterThan(movementSpeed(1, 5));
    const levelGrowth = movementSpeed(1, 50) - movementSpeed(1, 5);
    expect(levelGrowth).toBeGreaterThan(0);
    expect(levelGrowth).toBeLessThan(1.3);

    const { game, world } = setup(41_006);
    const companion = world.entities.find(entity => entity.kind === 'companion')!;
    for (const wild of world.entities.filter(entity => entity.kind === 'wild')) Object.assign(wild, { x: 8, z: -15 });
    Object.assign(companion, { x: -68, z: 85.7, heading: 2 });
    world.player = { x: -68, z: 85.7, heading: 2 };
    const crossing = { x: -68, z: 86.3, heading: 2 as const };
    expect(world.movePartner(crossing)).toBe(false);
    expect(world.lastMovementBlock).toContain('핑크배지');
    expect({ x: companion.x, z: companion.z }).toEqual({ x: -68, z: 85.7 });

    game.player.badges = 5;
    expect(world.movePartner(crossing)).toBe(true);
    expect(world.player).toEqual(crossing);
  });
});
