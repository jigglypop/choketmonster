import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createGame } from '../src/game/engine';
import { OpenWorldSimulation } from '../src/openworld/simulation';
const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
for (const seed of [41005, 41015, 41025]) {
  const game = createGame(1, `tracking-${seed}`), world = new OpenWorldSimulation(graph, game, seed, undefined, policy);
  world.setAutoHunt(false);
  const wild = world.visibleEntities(12).filter(entity => entity.kind === 'wild')[2];
  world.selectWild(wild.id, true); world.trackSelected();
  const start = { x: world.player.x, z: world.player.z, target: { x: wild.x, z: wild.z } };
  for (let tick = 0; tick < 240 && !game.battle && !game.captureOffer; tick++) world.step({ deltaSeconds: .25, learning: false });
  assert.equal(world.battleWildId, wild.id, `Tracking did not reach the selected individual at seed ${seed}`);
  console.log(JSON.stringify({ seed, start, player: world.player, target: { x: wild.x, z: wild.z }, expected: wild.id, encountered: world.battleWildId, collisions: world.entities.find(entity => entity.kind === 'companion')!.collisions }));
}
