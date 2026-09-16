import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { selectMusicCue, sceneMusicTrack } from '../src/audio/scene-music';
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
});
