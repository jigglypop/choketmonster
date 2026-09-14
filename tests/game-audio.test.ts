import { describe, expect, it } from 'vitest';
import { creatureVoiceNotes, normalizeGameAudioSettings } from '../src/audio/game-audio';

describe('game audio preferences', () => {
  it('clamps persisted levels and restores invalid fields to defaults', () => {
    expect(normalizeGameAudioSettings({ musicVolume: 2, effectsVolume: -.4, muted: true }))
      .toEqual({ musicVolume: 1, effectsVolume: 0, muted: true });
    expect(normalizeGameAudioSettings({ musicVolume: 'loud', muted: 'no' }))
      .toEqual({ musicVolume: .34, effectsVolume: .62, muted: false });
  });

  it('creates stable but distinct creature motifs', () => {
    expect(creatureVoiceNotes(25)).toEqual(creatureVoiceNotes(25));
    expect(creatureVoiceNotes(25)).not.toEqual(creatureVoiceNotes(26));
  });
});

