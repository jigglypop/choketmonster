const listeners = new Set<(suspended: boolean) => void>();
const pending = new Set<symbol>();
export const renderingSuspended = () => pending.size > 0;
export function onRenderSuspension(listener: (suspended: boolean) => void) {
  listeners.add(listener); listener(renderingSuspended());
  return () => { listeners.delete(listener); };
}

/** Give explicit saves time to finish IDB/network callbacks on slow GPUs. */
export async function withSaveRenderBudget<T>(operation: () => Promise<T>): Promise<T> {
  const token = Symbol(); pending.add(token);
  for (const listener of listeners) listener(true);
  let released = false;
  const release = () => {
    if (released) return;
    released = true; pending.delete(token);
    for (const listener of listeners) listener(renderingSuspended());
  };
  // Offline requests must not freeze the 3D view for their network timeout.
  const timer = setTimeout(release, 1000);
  try { return await operation(); }
  finally { clearTimeout(timer); release(); }
}
