import { describe, expect, it } from 'vitest';
import { createGame } from '../src/game/engine';
import { getWorldAtlas } from '../src/openworld/atlas';
import { nextDestinationGuide, regionalItinerary } from '../src/openworld/next-destination';

describe('campaign wayfinder', () => {
  it('points a fresh Johto partner along the next road without changing its game state', () => {
    const game = createGame(152, 'wayfinder'), before = structuredClone(game), atlas = getWorldAtlas('johto');
    const guide = nextDestinationGuide(game, atlas, atlas.surfaceSceneId, atlas.start);
    expect(guide).toMatchObject({ destinationId: 'violet', recommendedLevel: 9, nextName: '29번 도로', status: 'route' });
    expect(guide.points.length).toBeGreaterThan(3);
    for (const point of guide.points) expect(atlas.sample(point.x, point.z).blocked).toBe(false);
    expect(game).toEqual(before);
  });
  it('changes the destination after a badge and stops drawing a route on arrival', () => {
    const game = createGame(152, 'wayfinder-badge'), atlas = getWorldAtlas('johto');
    const violet = atlas.locations.find(item => item.id === 'violet')!;
    expect(nextDestinationGuide(game, atlas, atlas.surfaceSceneId, violet).status).toBe('arrived');
    game.campaign!.johtoBadges = [1];
    expect(nextDestinationGuide(game, atlas, atlas.surfaceSceneId, violet).destinationId).toBe('azalea');
  });
  it('never routes through a badge-locked connection', () => {
    const atlas = getWorldAtlas('kanto');
    expect(regionalItinerary(atlas, 'pallet', 'cinnabar', 0)).toEqual([]);
    expect(regionalItinerary(atlas, 'pallet', 'cinnabar', 6)).toContain('route-21');
  });
  it('uses interior exit coordinates instead of surface coordinates in a cave', () => {
    const game = createGame(152, 'wayfinder-cave'), atlas = getWorldAtlas('johto');
    game.campaign!.johtoBadges = [1];
    const cave = atlas.caves.find(item => item.id === 'union-cave')!;
    const guide = nextDestinationGuide(game, atlas, cave.sceneId, { x: 0, z: 0 });
    expect(guide.destinationId).toBe('azalea');
    expect(guide.nextName).toContain('33번');
    expect(guide.status).toBe('route');
    expect(guide.points.every(point => !cave.sample(point.x, point.z).blocked)).toBe(true);
  });
  it('guides a tunnel crossing to its entrance when the endpoints have separate location IDs', () => {
    const game = createGame(1, 'wayfinder-diglett'), atlas = getWorldAtlas('kanto');
    game.player.badges = 7; game.defeatedGyms = [1, 2, 3, 4, 5, 6, 7];
    const entrance = atlas.caves.find(cave => cave.id === 'diglett-cave')!.portals.find(portal => portal.surfaceLocationId === 'diglett-cave-east')!;
    const guide = nextDestinationGuide(game, atlas, atlas.surfaceSceneId, entrance.surface);
    expect(guide.destinationId).toBe('viridian');
    expect(guide.nextName).toBe('디그다의 굴 입구');
    expect(guide.status).toBe('route');
  });
  it('hands the Hisui temple from its final investigation to the finals, then directs travel to Paldea', () => {
    const game = createGame(152, 'hisui-final-guide'), atlas = getWorldAtlas('hisui');
    const temple = atlas.locations.find(item => item.id === 'temple-of-sinnoh')!;
    const local = { badges: [1, 2, 3, 4, 5, 6, 7], league: 0 };
    game.campaign!.expansion = { hisui: local };
    expect(nextDestinationGuide(game, atlas, atlas.surfaceSceneId, temple).title).toContain('신오신전 조사');
    local.badges.push(8);
    const final = nextDestinationGuide(game, atlas, atlas.surfaceSceneId, temple);
    expect(final.title).toContain('조사대 결승 미도');
    expect(final.detail).toContain('탐험 설정에서 조사대 결승');
    local.league = 4;
    expect(nextDestinationGuide(game, atlas, atlas.surfaceSceneId, temple).title).toContain('신오신전 월로');
    local.league = 5;
    expect(nextDestinationGuide(game, atlas, atlas.surfaceSceneId, temple)).toMatchObject({ status: 'complete', detail: '지도에서 팔데아 여행을 선택하세요.' });
  });
});
