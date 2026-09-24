import { describe, expect, it } from 'vitest';
import { CLIP_GROUND_SPEED, STATIC_MOTION_CLIP, clipGroundSpeed, getPokemonMotionSupport, selectPokemonMotionClip, type PokemonMotionKind } from '../src/data/model-motion';

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

  it('ranks running loops first and never walks with a turn or a transition', () => {
    const pm = (...names: string[]) => clips(...names.map(name => `pm0212_51_00_00026_${name}`));
    expect(selectPokemonMotionClip(pm('turnmove01_r090', 'walk01_loop', 'run01_loop'), 'walk').clip?.name).toMatch(/run01_loop$/);
    expect(selectPokemonMotionClip(pm('turnmove01_r090', 'walk01_loop'), 'walk').clip?.name).toMatch(/walk01_loop$/);
    expect(selectPokemonMotionClip(clips('Walk_Start', 'Walk_Loop', 'Walk_End'), 'walk').clip?.name).toBe('Walk_Loop');
    expect(selectPokemonMotionClip(clips('idle', 'attack', 'happy', 'run', 'walk', 'sleep'), 'walk').clip?.name).toBe('run');
    // A quarter turn alone is no walk: the idle stands in, unmatched, so the rig authors a walk.
    expect(selectPokemonMotionClip(pm('battlewait01_loop', 'turnmove01_r090'), 'walk')).toMatchObject({ clip: { name: expect.stringMatching(/battlewait01_loop$/) }, matched: false });
  });

  it('prefers flinches to knockouts and loops to one-shot idles', () => {
    expect(selectPokemonMotionClip(clips('jumpdown01_start', 'down01_start', 'damage01', 'damage02'), 'damage').clip?.name).toBe('damage01');
    expect(selectPokemonMotionClip(clips('jumpdown01_start', 'down01_loop'), 'damage').matched).toBe(false);
    expect(selectPokemonMotionClip(clips('Idol', 'Walking', 'Attack', 'Faint'), 'damage').clip?.name).toBe('Faint');
    expect(selectPokemonMotionClip(clips('defaultidle01', 'battlewait01_loop', 'defaultwait01_loop'), 'idle').clip?.name).toBe('defaultwait01_loop');
    expect(selectPokemonMotionClip(clips('rangeattack02_start', 'attack01'), 'attack').clip?.name).toBe('attack01');
  });

  it('picks the measured walk loop whose ground speed fits the pace', () => {
    const walk = { name: 'walk01_loop', userData: { [CLIP_GROUND_SPEED]: .8 } }, run = { name: 'run01_loop', userData: { [CLIP_GROUND_SPEED]: 3.6 } };
    expect(selectPokemonMotionClip([walk, run], 'walk', 1).clip).toBe(walk);
    expect(selectPokemonMotionClip([walk, run], 'walk', 2.4).clip).toBe(run);
    expect(selectPokemonMotionClip([walk, run], 'walk').clip).toBe(run);
    expect(clipGroundSpeed(walk)).toBe(.8);
    expect(clipGroundSpeed({ name: 'x', userData: { [CLIP_GROUND_SPEED]: 'fast' } })).toBeUndefined();
  });

  it('returns no clip for a clipless rigged model', () => {
    for (const kind of ['idle', 'walk', 'attack', 'damage'] as PokemonMotionKind[]) {
      expect(selectPokemonMotionClip([], kind)).toEqual({ clip: undefined, matched: false });
    }
  });
});
