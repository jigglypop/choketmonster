/**
 * setTimeout that counts only time the page is visible. A hidden tab draws nothing and throttles timers (to once
 * a second, then once a minute after five minutes), so a wall-clock deadline there fails work that never had a
 * chance to run. Returns a cancel function; outside a browser it is a plain timeout.
 */
export function visibleTimeout(callback: () => void, milliseconds: number): () => void {
  const page = typeof document === 'undefined' ? undefined : document;
  let remaining = milliseconds, startedAt = 0, done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => { done = true; page?.removeEventListener('visibilitychange', change); };
  const run = () => {
    if (done || timer !== undefined || page?.hidden) return;
    startedAt = performance.now();
    timer = setTimeout(() => {
      timer = undefined;
      if (page?.hidden) return;
      finish(); callback();
    }, remaining);
  };
  const pause = () => {
    if (timer === undefined) return;
    clearTimeout(timer); timer = undefined;
    remaining = Math.max(0, remaining - (performance.now() - startedAt));
  };
  function change() { if (page?.hidden) pause(); else run(); }
  page?.addEventListener('visibilitychange', change);
  run();
  return () => { pause(); finish(); };
}
