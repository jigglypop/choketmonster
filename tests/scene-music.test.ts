import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  BATTLE_MUSIC_HOLD_MS,
  SceneMusicDirector,
  WILD_BATTLE_MUSIC_DELAY_MS,
  selectMusicCue,
  sceneMusicTrack,
} from '../src/audio/scene-music';
import sources from '../public/audio/pokemon-rg/sources.json';

describe('scene soundtrack', () => {
  it('prioritizes battle and victory over terrain and returns to exploration', () => {
    const cave = { started: true, sceneId: 'cave:johto:union-cave', location: { id: 'union-cave', kind: 'cave' as const } };
    expect(selectMusicCue(cave)).toBe('cave');
    expect(selectMusicCue({ ...cave, battle: { kind: 'wild' } })).toBe('wild-battle');
    expect(selectMusicCue({ ...cave, captureOffer: true })).toBe('wild-victory');
    expect(selectMusicCue({ ...cave, battle: { kind: 'gym' } })).toBe('gym-battle');
    expect(selectMusicCue({ ...cave, battle: { kind: 'trainer' }, champion: true })).toBe('champion-battle');
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

  it('keeps exploration music through short wild battles and absorbs chained encounters', () => {
    let now = 10_000;
    const director = new SceneMusicDirector(() => now);
    const route = { started: true, location: { id: 'route-24', kind: 'route' as const } };
    expect(director.update(route)).toEqual({ cue: 'route24' });
    expect(director.update({ ...route, battle: { kind: 'wild' } })).toEqual({ cue: 'route24', nextUpdateAt: now + WILD_BATTLE_MUSIC_DELAY_MS });
    now += WILD_BATTLE_MUSIC_DELAY_MS - 1;
    expect(director.update({ ...route, battle: { kind: 'wild' } }).cue).toBe('route24');
    now += 1;
    expect(director.resolve()).toEqual({ cue: 'wild-battle' });

    expect(director.update({ ...route, captureOffer: true })).toEqual({ cue: 'wild-battle', nextUpdateAt: now + BATTLE_MUSIC_HOLD_MS });
    now += 2_000;
    expect(director.update({ ...route, battle: { kind: 'wild' } })).toEqual({ cue: 'wild-battle' });
    now += 500;
    expect(director.update(route)).toEqual({ cue: 'wild-battle', nextUpdateAt: now + BATTLE_MUSIC_HOLD_MS });
    now += BATTLE_MUSIC_HOLD_MS;
    expect(director.resolve()).toEqual({ cue: 'route24' });
  });

  it('switches important battles immediately without a victory-track interruption', () => {
    let now = 20_000;
    const director = new SceneMusicDirector(() => now);
    const town = { started: true, location: { id: 'pallet', kind: 'town' as const } };
    expect(director.update(town).cue).toBe('pallet');
    expect(director.update({ ...town, battle: { kind: 'gym' } }).cue).toBe('gym-battle');
    now += 100;
    expect(director.update({ ...town, captureOffer: true }).cue).toBe('gym-battle');
  });
});
