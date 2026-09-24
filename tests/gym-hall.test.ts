import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import type { FieldPolicy } from '../src/game/field';
import { createGame } from '../src/game/engine';
import { gymTeam } from '../src/game/gym-teams';
import { getGymScene, gymSceneId, HALL_BATTLE_GAP, leagueSceneId, onGymCourt } from '../src/openworld/gym-scenes';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;

function atPewterDoor(seed: number) {
  const game = createGame(1, `gym-hall-${seed}`);
  const world = new OpenWorldSimulation(graph, game, seed, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  world.visitedTownIds.push('pewter');
  expect(world.teleportToTown('pewter')).toBe(true);
  const hall = getGymScene(gymSceneId('kanto', 'pewter'))!;
  world.player = { ...hall.door, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  return { game, world, hall };
}

describe('gym hall', () => {
  it('walks in from the door, keeps wild Pokémon outside and restores from a save', () => {
    const { game, world, hall } = atPewterDoor(52_001);
    const wilds = world.entities.filter(entity => entity.kind === 'wild').map(entity => entity.id);
    expect(world.enterGym('pewter')).toBe(true);
    expect(world.sceneId).toBe(hall.sceneId);
    expect(world.player).toMatchObject(hall.entrance);
    expect(world.sampleWorld(hall.entrance.x, hall.entrance.z).blocked).toBe(false);
    expect(world.sampleWorld(hall.minX, hall.entrance.z).blocked).toBe(true);
    expect(world.locationAt(hall.leader.x, hall.leader.z).id).toBe('pewter');
    expect(world.entities.filter(entity => entity.kind === 'wild').map(entity => entity.id)).toEqual(wilds);
    expect(world.entities.some(entity => entity.kind === 'wild' && hall.contains(entity.x, entity.z))).toBe(false);

    const restored = new OpenWorldSimulation(graph, game, world.seed, world.snapshot(), policy);
    expect(restored.sceneId).toBe(hall.sceneId);
    expect(restored.exitGym()).toBe(true);
    expect(restored.player).toMatchObject(hall.door);
    expect(restored.sceneId).toBe('surface:kanto');
  });

  it('refuses the door from across town', () => {
    const { world, hall } = atPewterDoor(52_002);
    world.player = { x: hall.door.x + 20, z: hall.door.z, heading: 0 };
    expect(world.enterGym('pewter')).toBe(false);
  });

  it('fights the leader with the full party at the centre of the court', () => {
    const { game, world, hall } = atPewterDoor(52_003);
    expect(world.enterGym('pewter')).toBe(true);
    expect(onGymCourt(hall, hall.challenger.x, hall.challenger.z)).toBe(false);
    expect(onGymCourt(hall, hall.challenger.x, hall.court.minZ + 1)).toBe(true);
    expect(world.challengeGymHall()).toBe(true);
    expect(world.player).toMatchObject(hall.battleSpot);
    expect(hall.battleSpot.z + HALL_BATTLE_GAP / 2).toBeCloseTo((hall.court.minZ + hall.court.maxZ) / 2);
    expect(world.controlMode).toBe('auto');
    expect(game.battle?.kind).toBe('gym');
    expect(game.battle?.enemy.team.map(monster => [monster.speciesId, monster.level])).toEqual(gymTeam('kanto', 1)!.map(entry => [...entry]));
    expect(world.exitGym()).toBe(false);
  });

  it('opens the league hall to eight badges and fights its next trainer by hand', () => {
    const game = createGame(1, 'league-hall');
    game.player.badges = 8; game.defeatedGyms = [1, 2, 3, 4, 5, 6, 7, 8];
    const world = new OpenWorldSimulation(graph, game, 52_004, undefined, policy);
    world.setControlMode('manual'); world.setAutoHunt(false);
    const hall = getGymScene(leagueSceneId('kanto', 'indigo-plateau'))!;
    expect(hall.kind).toBe('league');
    expect(world.sampleWorld(hall.challenger.x, hall.challenger.z).blocked).toBe(false);
    expect(onGymCourt(hall, hall.leader.x, hall.leader.z - 4)).toBe(true);
    world.player = { ...hall.door, heading: 0 };
    Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
    expect(world.enterLeague()).toBe(true);
    expect(world.sceneId).toBe(hall.sceneId);
    expect(world.locationAt(hall.leader.x, hall.leader.z).id).toBe('indigo-plateau');
    expect(world.hallTrainer?.id).toBe('kanto-lorelei');
    const restored = new OpenWorldSimulation(graph, game, world.seed, world.snapshot(), policy);
    expect(restored.sceneId).toBe(hall.sceneId);
    expect(world.challengeGymHall()).toBe(true);
    // League trainers are fought by hand, one at a time.
    expect(world.controlMode).toBe('manual');
    expect(world.player.heading).toBe(2);
    expect(game.battle).toMatchObject({ kind: 'elite', trainerId: 'kanto-lorelei' });
  });

  it('keeps the league hall closed before the eighth badge', () => {
    const game = createGame(1, 'league-hall-closed');
    const world = new OpenWorldSimulation(graph, game, 52_005, undefined, policy);
    const hall = getGymScene(leagueSceneId('kanto', 'indigo-plateau'))!;
    world.player = { ...hall.door, heading: 0 };
    Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
    expect(world.enterLeague()).toBe(false);
  });
});
