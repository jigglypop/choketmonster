import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { createGame, type InventoryItem } from '../src/game/engine';
import { getWorldAtlas } from '../src/openworld/atlas';
import { PLAYABLE_WORLDS } from '../src/openworld/availability';
import { activeFieldItemPickups, allFieldItemSources, FIELD_PICKUP_RESPAWN_SECONDS, validateFieldItemPickupStates } from '../src/openworld/item-sources';
import { OpenWorldSimulation, regionalEncounters, restoreOpenWorld, serializeOpenWorld } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
describe('roadside equipment and documented acquisition', () => {
  it('gives all 111 items real playable roadside locations and matching capture sources', () => {
    const sources = allFieldItemSources(); expect(sources).toHaveLength(111);
    for (const source of sources) {
      expect(source.roadside.length, source.item.id).toBeGreaterThan(0);
      for (const capture of source.captures) {
        expect(capture.chance).toBeGreaterThan(0);
        expect(capture.locations.some(place => capture.speciesIds.every(id => regionalEncounters(place.locationId, 8, place.regionId).includes(id))), source.item.id).toBe(true);
      }
      for (const place of source.roadside) {
        expect(PLAYABLE_WORLDS.some(region => region.id === place.regionId)).toBe(true);
        expect(getWorldAtlas(place.regionId).locations.find(location => location.id === place.locationId)?.name).toBe(place.name);
      }
    }
  });
  it('keeps sparse, deterministic pickup positions on the walkable road edge in every region', () => {
    for (const region of PLAYABLE_WORLDS) {
      const atlas = getWorldAtlas(region.id), pickups = activeFieldItemPickups(region.id, 517, {}, 8);
      expect(pickups.length).toBeGreaterThan(0); expect(pickups.length).toBeLessThanOrEqual(3);
      expect(pickups).toEqual(activeFieldItemPickups(region.id, 517, {}, 8));
      for (const item of pickups) {
        expect(atlas.sample(item.x, item.z).blocked).toBe(false);
        expect(atlas.locationAt(item.x, item.z).id).toBe(item.locationId);
        expect(atlas.distanceToPath(item.x, item.z)).toBeGreaterThanOrEqual(2.6);
      }
    }
  });
  it('requires proximity and persists empty slots without replacing them or refilling on reload', () => {
    const game = createGame(1, 'pickup-test'), world = new OpenWorldSimulation(graph, game, 517);
    world.setControlMode('manual'); world.setAutoHunt(false);
    const pickup = world.fieldPickups[0], before = world.fieldPickups.length;
    world.player = { x: pickup.x + 20, z: pickup.z, heading: 0 };
    expect(world.collectFieldItem(pickup.id)).toBeUndefined();
    world.player = { x: pickup.x, z: pickup.z, heading: 0 };
    Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
    expect(world.collectFieldItem(pickup.id)?.id).toBe(pickup.itemId);
    expect(world.fieldPickups).toHaveLength(before - 1);
    expect(world.collectFieldItem(pickup.id)).toBeUndefined();
    const restored = restoreOpenWorld(graph, serializeOpenWorld(game, world));
    expect(restored.game.inventory[pickup.itemId as InventoryItem]).toBe(1);
    expect(restored.simulation.fieldPickups.some(item => item.id === pickup.id)).toBe(false);
    const states = restored.simulation.snapshot().fieldItemPickupStates!;
    expect(states[pickup.id].remainingSeconds).toBe(FIELD_PICKUP_RESPAWN_SECONDS);
    states[pickup.id].remainingSeconds = 0;
    expect(activeFieldItemPickups(world.regionId, 517, states, 8).some(item => item.id === pickup.id)).toBe(true);
    expect(() => validateFieldItemPickupStates({ [pickup.id]: { remainingSeconds: -1, collectedCount: 1 } })).toThrow();
  });
});
