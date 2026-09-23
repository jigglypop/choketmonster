import { describe, expect, it } from 'vitest';
import { STATIC_MOTION_CLIP, getPokemonMotionSupport, selectPokemonMotionClip, type PokemonMotionKind } from '../src/data/model-motion';

const clips = (...names: string[]) => names.map(name => ({ name }));

describe('Pokemon model motion metadata', () => {
  it('keeps the audited 1..1025 support counts', () => {
    const counts = new Map<string, number>();
    for (let id = 1; id <= 1025; id++) {
      const support = getPokemonMotionSupport(id);
      counts.set(support, (counts.get(support) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      'rigged-animated': 261,
      'rigged-static': 410,
      'static': 350,
      'transform-animated': 4,
    });
  });

  it.each([
    ['idle', ['Idol', 'Walking', 'Attack'], 'Idol'],
    ['idle', ['pm_ba10_waitA01', 'pm_ba20_buturi01'], 'pm_ba10_waitA01'],
    ['walk', ['kartana_idle', 'kartana_fly'], 'kartana_fly'],
    ['attack', ['pm_ba10_waitA01', 'pm_ba20_buturi01'], 'pm_ba20_buturi01'],
    ['damage', ['stakataka_idle', 'stakataka_faint'], 'stakataka_faint'],
  ] as const)('selects the %s clip used by pinned source naming', (kind, names, expected) => {
    expect(selectPokemonMotionClip(clips(...names), kind).clip?.name).toBe(expected);
    expect(selectPokemonMotionClip(clips(...names), kind).matched).toBe(true);
  });

  it('marks a generic fallback as unmatched so it is not clamped as an attack', () => {
    expect(selectPokemonMotionClip(clips('ArmatureAction'), 'attack')).toEqual({ clip: { name: 'ArmatureAction' }, matched: false });
  });

  it('never lets a frozen source clip shadow an authored clip of the same kind', () => {
    const frozen = { name: 'Walking', userData: { [STATIC_MOTION_CLIP]: true } };
    const list = [{ name: 'Idol', userData: {} }, frozen, { name: 'CM_walk', userData: {} }];
    expect(selectPokemonMotionClip(list, 'walk')).toEqual({ clip: list[2], matched: true });
    // Only frozen clips: still return one so a static pose is shown.
    expect(selectPokemonMotionClip([frozen], 'walk').clip).toBe(frozen);
  });

  it('falls back to a generic clip before a clip of another kind', () => {
    expect(selectPokemonMotionClip(clips('bd_attack', 'Take 001', 'CM_walk'), 'idle')).toEqual({ clip: { name: 'Take 001' }, matched: false });
  });

  it('returns no clip for a clipless rigged model', () => {
    for (const kind of ['idle', 'walk', 'attack', 'damage'] as PokemonMotionKind[]) {
      expect(selectPokemonMotionClip([], kind)).toEqual({ clip: undefined, matched: false });
    }
  });
});
