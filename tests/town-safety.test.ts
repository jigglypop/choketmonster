import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/game/engine';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));

describe('town safety', () => {
  for (const starter of [1, 152] as const) it(`keeps town zones empty during spawning, walking and restoration (${starter})`, () => {
    const game = createGame(starter, `town-safety-${starter}`);
    const world = new OpenWorldSimulation(graph, game, 9341, undefined, policy);
    world.setControlMode('manual');
    const wilds = () => world.entities.filter(entity => entity.kind === 'wild');
    const safe = () => wilds().every(entity => !world.isSafeTown(entity.x, entity.z));
    expect(world.isSafeTown(world.player.x, world.player.z)).toBe(true);
    expect(safe()).toBe(true); expect(wilds()).toHaveLength(15);
    expect(world.startEncounter(wilds()[0].id)).toBe(false);
    for (let tick = 0; tick < 80; tick++) {
      world.step({ deltaSeconds: .25, learning: false });
      expect(safe()).toBe(true);
    }
    const checkpoint = world.snapshot();
    const legacyWild = checkpoint.entities.find(entity => entity.kind === 'wild')!;
    Object.assign(legacyWild, { x: world.player.x, z: world.player.z });
    const restored = new OpenWorldSimulation(graph, structuredClone(game), world.seed, checkpoint, policy);
    expect(restored.entities.filter(entity => entity.kind === 'wild').every(entity => !restored.isSafeTown(entity.x, entity.z))).toBe(true);
    expect(restored.rosterStatus().total).toBe(15);
    expect(restored.snapshot().entities.find(entity => entity.id === legacyWild.id)?.brain).toEqual(legacyWild.brain);
    const target = restored.entities.find(entity => entity.kind === 'wild')!;
    restored.movePlayer({ x: target.x, z: target.z, heading: 0 });
    expect(restored.startEncounter(target.id)).toBe(true);
  });
});
