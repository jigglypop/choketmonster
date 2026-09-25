import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleTimeout } from '../src/three/visible-time';

function stubPage() {
  const listeners = new Set<() => void>();
  const page = {
    hidden: false,
    addEventListener: (_: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_: string, listener: () => void) => { listeners.delete(listener); },
    show(hidden: boolean) { page.hidden = hidden; listeners.forEach(listener => listener()); },
    listeners,
  };
  vi.stubGlobal('document', page);
  return page;
}

describe('deadlines that count only visible time', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('pauses while the page is hidden and resumes with the remaining time', async () => {
    vi.useFakeTimers();
    const page = stubPage(), expired = vi.fn();
    visibleTimeout(expired, 1000);
    await vi.advanceTimersByTimeAsync(600);
    page.show(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(expired).not.toHaveBeenCalled();
    page.show(false);
    await vi.advanceTimersByTimeAsync(399);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(page.listeners.size).toBe(0);
  });

  it('does not start counting until a hidden page is shown, and cancels cleanly', async () => {
    vi.useFakeTimers();
    const page = stubPage(), expired = vi.fn();
    page.hidden = true;
    const cancel = visibleTimeout(expired, 500);
    await vi.advanceTimersByTimeAsync(5000);
    expect(expired).not.toHaveBeenCalled();
    page.show(false);
    await vi.advanceTimersByTimeAsync(250);
    cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(expired).not.toHaveBeenCalled();
    expect(page.listeners.size).toBe(0);
  });

  it('is a plain timeout outside a browser', async () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    visibleTimeout(expired, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(expired).toHaveBeenCalledTimes(1);
  });
});
