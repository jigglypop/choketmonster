import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import type { FieldPolicy } from '../src/game/field';
import { buyTownStock, claimDungeonClear, createGame, restoreGame, serializeGame, townStock } from '../src/game/engine';
import { TOWN_SHOPS } from '../src/data/town-shops';
import { getWorldAtlas } from '../src/openworld/atlas';
import { CAVE_SCENES, dungeonFloors } from '../src/openworld/caves';
import { DUNGEON_PLANS } from '../src/openworld/dungeons';
import { OpenWorldSimulation, PORTAL_WALK_RADIUS } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;

describe('dungeon clear rewards', () => {
  it('gives each dungeon its version reward once and keeps the record through a save', () => {
    const game = createGame(1, 'dungeon-rewards'), money = game.player.money;
    const moon = claimDungeonClear(game, 'kanto', 'mt-moon', 12)!;
    expect(moon.items).toEqual(['moon-stone']);
    expect(game.inventory['moon-stone']).toBe(1);
    expect(claimDungeonClear(game, 'kanto', 'mt-moon', 12)).toBeUndefined();
    // The Ice Path holds Waterfall in Crystal, and NeverMeltIce.
    const ice = claimDungeonClear(game, 'johto', 'ice-path', 30)!;
    expect(ice.machines).toContain(127);
    expect(game.technicalMachines?.['127']).toBe(1);
    // A dungeon with neither pays prize money by its levels.
    const tunnel = claimDungeonClear(game, 'hoenn', 'rusturf-tunnel', 20)!;
    expect(tunnel).toMatchObject({ machines: [], items: [], money: 2400 });
    expect(game.player.money).toBe(money + 2400);
    expect(claimDungeonClear(game, 'kanto', 'nowhere', 10)).toBeUndefined();
    const restored = restoreGame(serializeGame(game));
    expect(restored.clearedDungeons).toEqual(['kanto:mt-moon', 'johto:ice-path', 'hoenn:rusturf-tunnel']);
    const damaged = JSON.parse(serializeGame(game)); damaged.clearedDungeons = ['kanto:mt-moon', 'kanto:mt-moon'];
    expect(() => restoreGame(JSON.stringify(damaged))).toThrow(/던전 클리어/);
  });

  it('marks the far end of each dungeon with one way in, and none on a through dungeon', () => {
    for (const plan of DUNGEON_PLANS) {
      const goals = CAVE_SCENES.filter(scene => scene.regionId === plan.regionId && scene.dungeonId === plan.id && scene.goal);
      expect(goals, `${plan.regionId}:${plan.id}`).toHaveLength(plan.surfaceLocations.length === 1 ? 1 : 0);
      for (const scene of goals) expect(scene.sample(scene.goal!.x, scene.goal!.z).blocked, scene.sceneId).toBe(false);
    }
  });

  it('pays out Mt. Moon once the partner walks out at the far end, not at the mouth it came in by', () => {
    const game = createGame(1, 'mt-moon-clear'); game.player.badges = 1; game.defeatedGyms = [1];
    const world = new OpenWorldSimulation(graph, game, 7186, undefined, policy);
    const floors = dungeonFloors({ regionId: 'kanto', dungeonId: 'mt-moon' }), entrance = floors[0].portals[0];
    const step = (point: { x: number; z: number }) => { world.player = { ...point, heading: 0 }; return world.portalUnderfoot() && world.traverseCavePortal(PORTAL_WALK_RADIUS); };
    expect(step(entrance.surface)).toBe(true);
    // Back out the same way: no reward.
    expect(step(entrance.interior)).toBe(true);
    expect(world.claimDungeonClear()).toBeUndefined();
    expect(step(entrance.surface)).toBe(true);
    for (const [index, floor] of floors.slice(0, -1).entries()) expect(step(floor.stairs.find(stairs => stairs.targetSceneId === floors[index + 1].sceneId)!.interior)).toBe(true);
    expect(step(floors.at(-1)!.portals[0].interior)).toBe(true);
    expect(world.claimDungeonClear()).toMatchObject({ name: '달맞이산 동굴', reward: { items: ['moon-stone'] } });
    expect(world.claimDungeonClear()).toBeUndefined();
  });
});

describe('town shops', () => {
  it('lists only machines and items the game has, in towns the maps have', () => {
    for (const [regionId, towns] of Object.entries(TOWN_SHOPS)) {
      const ids = new Set(getWorldAtlas(regionId).locations.filter(location => location.kind === 'town').map(location => location.id));
      for (const [townId, shops] of Object.entries(towns)) {
        expect(ids.has(townId), `${regionId}:${townId}`).toBe(true);
        const stock = townStock(regionId, townId);
        expect(stock.length, `${regionId}:${townId}`).toBe(shops.reduce((sum, shop) => sum + Object.keys(shop.machines ?? {}).length + (shop.items ?? []).length, 0));
        for (const entry of stock) expect(entry.price, `${regionId}:${townId}:${entry.id}`).toBeGreaterThan(0);
      }
    }
  });

  it('sells a town its own machines once the badges allow, and nothing a town does not sell', () => {
    const game = createGame(1, 'celadon-shop'); game.player.money = 100_000;
    buyTownStock(game, 'kanto', 'celadon', 'machine', 280);
    expect(game.technicalMachines?.['280']).toBe(1);
    expect(game.player.money).toBe(97_000);
    // Ice Beam from the Game Corner waits for two badges.
    expect(() => buyTownStock(game, 'kanto', 'celadon', 'machine', 58)).toThrow(/배지 2개/);
    game.player.badges = 2; game.defeatedGyms = [1, 2];
    buyTownStock(game, 'kanto', 'celadon', 'machine', 58);
    expect(game.technicalMachines?.['58']).toBe(1);
    expect(() => buyTownStock(game, 'kanto', 'pewter', 'machine', 280)).toThrow(/팔지 않는/);
    // Held items go to the bag; Azalea's charcoal needs no badge.
    buyTownStock(game, 'johto', 'azalea', 'item', 'charcoal', 2);
    expect(game.inventory.charcoal).toBe(2);
    expect(() => buyTownStock(game, 'unova', 'nimbasa-city', 'item', 'focus-band')).toThrow(/배지 2개/);
  });
});
