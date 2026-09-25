import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';

/** Seconds of frames ignored after the tab is shown again: the first one reports the whole time away as its delta. */
const RESUME_GRACE = .5;

/**
 * Frame rate a two-second window must beat to raise resolution. `display` is the best window rate seen, which
 * tracks the display's refresh: 57 at 60 Hz and above, 95% of slower panels (a 50 Hz display recovers at 47.5),
 * and never below 40 so it stays clear of the 38 fps drop and cannot oscillate against it.
 */
export const recoveryRate = (display: number) => Math.max(40, Math.min(57, display * .95));

/** The pixel ratio after a two-second window at `fps`; `current` when it holds. */
export function nextPixelRatio(fps: number, display: number, current: number, maximum: number): number {
  if (fps < 38 && current > .7) return Math.max(.7, Math.round((current - .2) * 100) / 100);
  if (fps > recoveryRate(display) && current < maximum) return Math.min(maximum, Math.round((current + .1) * 100) / 100);
  return current;
}

/** Adjust the 3D canvas only; HTML controls stay at native display resolution. */
export function AdaptiveResolution({ setDpr }: { setDpr: (value: number) => void }) {
  const { gl } = useThree();
  const windowed = useRef({ seconds: 0, frames: 0, cooldown: 3, display: 0, grace: 0 });
  useEffect(() => {
    const resume = () => { windowed.current.grace = RESUME_GRACE; };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, []);
  useFrame((_, delta) => {
    const stats = windowed.current;
    if (document.hidden || !Number.isFinite(delta)) { stats.seconds = 0; stats.frames = 0; return; }
    if (stats.grace > 0) { stats.grace -= Math.min(delta, .1); stats.seconds = 0; stats.frames = 0; return; }
    if (delta > .25 && gl.getPixelRatio() > .7) {
      // Slow frames are evidence to lower resolution, not samples to discard.
      setDpr(Math.max(.7, Math.round((gl.getPixelRatio() - .2) * 100) / 100));
      stats.seconds = 0; stats.frames = 0; stats.cooldown = 3; return;
    }
    if (stats.cooldown > 0) { stats.cooldown -= delta; return; }
    stats.seconds += delta; stats.frames++;
    if (stats.seconds < 2) return;
    const fps = stats.frames / stats.seconds;
    stats.display = Math.max(stats.display, fps);
    const current = gl.getPixelRatio(), maximum = Math.min(window.devicePixelRatio || 1, 1.5);
    const next = nextPixelRatio(fps, stats.display, current, maximum);
    if (next !== current) setDpr(next);
    stats.seconds = 0; stats.frames = 0; stats.cooldown = fps > recoveryRate(stats.display) ? 8 : 2;
  });
  return null;
}
