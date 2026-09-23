import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  SceneMusicDirector,
  selectMusicCue,
  sceneMusicTrack,
} from '../src/audio/scene-music';
import sources from '../public/audio/pokemon-rg/sources.json';

describe('scene soundtrack', () => {
  it('keeps the surrounding area cue during every battle and capture state', () => {
    const cave = { started: true, sceneId: 'cave:johto:union-cave', location: { id: 'union-cave', kind: 'cave' as const } };
    expect(selectMusicCue(cave)).toBe('cave');
    expect(selectMusicCue({ ...cave, battle: { kind: 'wild' } })).toBe('cave');
    expect(selectMusicCue({ ...cave, captureOffer: true })).toBe('cave');
    expect(selectMusicCue({ ...cave, battle: { kind: 'gym' } })).toBe('gym-battle');
    expect(selectMusicCue({ started: true, sceneId: 'gym:kanto:pewter', location: { id: 'pewter', kind: 'town' } })).toBe('gym');
    expect(selectMusicCue({ started: true, sceneId: 'gym:kanto:pewter', location: { id: 'pewter', kind: 'town' }, battle: { kind: 'gym' } })).toBe('gym-battle');
    expect(selectMusicCue({ started: true, sceneId: 'league:kanto:indigo-plateau', location: { id: 'indigo-plateau', kind: 'special' } })).toBe('gym');
    expect(selectMusicCue({ started: true, sceneId: 'league:kanto:indigo-plateau', location: { id: 'indigo-plateau', kind: 'special' }, battle: { kind: 'trainer' } })).toBe('champion-battle');
    expect(selectMusicCue({ ...cave, battle: { kind: 'trainer' }, champion: true })).toBe('cave');
    expect(selectMusicCue({ started: true, location: { id: 'new-bark', kind: 'town' } })).toBe('pallet');
    expect(selectMusicCue({ started: true, location: { id: 'route-29', kind: 'route' } })).toBe('route1');
    expect(selectMusicCue({ started: true, location: { id: 'ilex-forest', kind: 'forest' } })).toBe('forest');
    expect(selectMusicCue({ started: true, location: { id: 'route-19', kind: 'sea' } })).toBe('surf');
    expect(sceneMusicTrack(selectMusicCue({ started: false })).url).toBe('/audio/pokemon-rg/opening.mp3');
  });

  it('ships the unmodified soundtrack bytes recorded in the source receipt', () => {
    expect(sources.tracks.length).toBe(33);
    for (const track of sources.tracks) {
      const bytes = readFileSync(`public${track.url}`);
      expect(bytes.length, track.cue).toBe(track.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), track.cue).toBe(track.sha256);
    }
  });

  it('does not schedule or switch music across battles and capture decisions', () => {
    const director = new SceneMusicDirector();
    const route = { started: true, location: { id: 'route-24', kind: 'route' as const } };
    expect(director.update(route)).toEqual({ cue: 'route24' });
    expect(director.update({ ...route, battle: { kind: 'wild' } })).toEqual({ cue: 'route24' });
    expect(director.resolve()).toEqual({ cue: 'route24' });
    expect(director.update({ ...route, captureOffer: true })).toEqual({ cue: 'route24' });
    expect(director.update({ ...route, battle: { kind: 'gym' } })).toEqual({ cue: 'gym-battle' });
    expect(director.update({ ...route, battle: { kind: 'trainer' }, champion: true })).toEqual({ cue: 'route24' });
    expect(director.update(route)).toEqual({ cue: 'route24' });
  });
});
