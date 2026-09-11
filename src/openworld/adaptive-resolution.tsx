import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';

/** Adjust the 3D canvas only; HTML controls stay at native display resolution. */
export function AdaptiveResolution({ setDpr }: { setDpr: (value: number) => void }) {
  const { gl } = useThree();
  const windowed = useRef({ seconds: 0, frames: 0, cooldown: 3 });
  useFrame((_, delta) => {
    const stats = windowed.current;
    if (document.hidden || delta > .8) { stats.seconds = 0; stats.frames = 0; return; }
    if (stats.cooldown > 0) { stats.cooldown -= delta; return; }
    stats.seconds += delta; stats.frames++;
    if (stats.seconds < 2) return;
    const fps = stats.frames / stats.seconds;
    const current = gl.getPixelRatio(), maximum = Math.min(window.devicePixelRatio || 1, 1.5);
    if (fps < 38 && current > .7) setDpr(Math.max(.7, Math.round((current - .2) * 100) / 100));
    else if (fps > 57 && current < maximum) setDpr(Math.min(maximum, Math.round((current + .1) * 100) / 100));
    stats.seconds = 0; stats.frames = 0; stats.cooldown = fps > 57 ? 8 : 2;
  });
  return null;
}
