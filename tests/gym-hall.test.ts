import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Graph } from '../src/core/brain';
import type { FieldPolicy } from '../src/game/field';
import { createGame } from '../src/game/engine';
import { gymTeam } from '../src/game/gym-teams';
import { getGymScene, gymSceneId, HALL_BATTLE_GAP, leagueSceneId, onGymCourt } from '../src/openworld/gym-scenes';
import { OpenWorldSimulation } from '../src/openworld/simulation';
import { getWorldAtlas } from '../src/openworld/atlas';
import { findWorldPath } from '../src/openworld/navigation';

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

  it('never leaves a wild Pokémon on the hall floor, and recovers a save that did', () => {
    const { game, world, hall } = atPewterDoor(52_004);
    expect(world.enterGym('pewter')).toBe(true);
    // A wild that ends up on the hall floor while the player is inside is moved off it on the way out.
    const wild = world.entities.find(entity => entity.kind === 'wild')!;
    Object.assign(wild, hall.leader);
    expect(world.exitGym()).toBe(true);
    const onBlockedGround = () => world.entities.filter(entity => entity.kind === 'wild' && (world.sampleWorld(entity.x, entity.z).blocked || hall.contains(entity.x, entity.z)));
    expect(onBlockedGround()).toEqual([]);
    // Older saves may hold one on ground that is blocked now: it steps to open ground instead of voiding the save.
    const snapshot = world.snapshot(), atlas = world.atlas;
    let blocked = { x: hall.door.x, z: hall.door.z };
    for (let reach = 1; reach < 80 && !atlas.sample(blocked.x, blocked.z).blocked; reach++) blocked = { x: hall.door.x, z: hall.door.z + reach };
    expect(atlas.sample(blocked.x, blocked.z).blocked).toBe(true);
    Object.assign(snapshot.entities.find(entity => entity.kind === 'wild')!, blocked);
    const restored = new OpenWorldSimulation(graph, game, world.seed, snapshot, policy);
    expect(restored.entities.filter(entity => restored.sampleWorld(entity.x, entity.z).blocked)).toEqual([]);
  });

  it('keeps 24 berries for the wild Pokémon however often the hall is visited', () => {
    const { world } = atPewterDoor(52_005);
    for (let visit = 0; visit < 4; visit++) {
      expect(world.enterGym('pewter')).toBe(true);
      expect(world.exitGym()).toBe(true);
      expect(world.foods).toHaveLength(24);
      expect(world.foods.every(food => !world.sampleWorld(food.x, food.z).blocked)).toBe(true);
    }
  });

  it('leaves the partner where it stood when a challenge cannot start', () => {
    const { world, hall } = atPewterDoor(52_006);
    expect(world.enterGym('pewter')).toBe(true);
    const standing = { ...world.player };
    vi.spyOn(world, 'challengeLocalGym').mockImplementationOnce(() => { throw new Error('이 지방에서 사용할 수 있는 포켓몬이 없습니다.'); });
    expect(() => world.challengeGymHall()).toThrow('사용할 수 있는 포켓몬');
    expect(world.player).toEqual(standing);
    expect(world.game.battle).toBeUndefined();
    vi.spyOn(world, 'challengeLocalGym').mockReturnValueOnce(false);
    expect(world.challengeGymHall()).toBe(false);
    expect(world.player).toEqual(standing);
    expect(world.challengeGymHall()).toBe(true);
    expect(world.player).toMatchObject(hall.battleSpot);
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
    expect(hall.sample(hall.challenger.x, hall.challenger.z).blocked).toBe(false);
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

describe('gyms away from towns', () => {
  it('give every trial site, arena and mountain gym a hall whose door is walked to from its place', () => {
    for (const region of ['alola', 'hisui', 'paldea']) {
      const atlas = getWorldAtlas(region);
      for (const gym of atlas.gyms) {
        const place = atlas.locations.find(item => item.id === gym.locationId)!, hall = getGymScene(gymSceneId(region, gym.locationId));
        expect(hall, `${region}:${gym.locationId}`).toBeDefined();
        expect(atlas.sample(hall!.door.x, hall!.door.z).blocked, gym.locationId).toBe(false);
        if (place.kind !== 'town') expect(findWorldPath(atlas.nearestWalkable(place.x, place.z, 8)!, hall!.door, atlas.sample).length, gym.locationId).toBeGreaterThan(0);
      }
    }
  });
});
