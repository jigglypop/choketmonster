const listeners = new Set<(suspended: boolean) => void>();
const pending = new Set<symbol>();
export const renderingSuspended = () => pending.size > 0;
function notifyRenderSuspension(previous: boolean): void {
  const current = renderingSuspended();
  if (current === previous) return;
  for (const listener of listeners) listener(current);
}
export function onRenderSuspension(listener: (suspended: boolean) => void) {
  listeners.add(listener); listener(renderingSuspended());
  return () => { listeners.delete(listener); };
}

/** Give explicit saves time to finish IDB/network callbacks on slow GPUs. */
export async function withSaveRenderBudget<T>(operation: () => Promise<T>): Promise<T> {
  const token = Symbol(), wasSuspended = renderingSuspended(); pending.add(token);
  notifyRenderSuspension(wasSuspended);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const suspended = renderingSuspended(); pending.delete(token);
    notifyRenderSuspension(suspended);
  };
  // Offline requests must not freeze the 3D view for their network timeout.
  const timer = setTimeout(release, 1000);
  try { return await operation(); }
  finally { clearTimeout(timer); release(); }
}
