import { describe, expect, it } from 'vitest';
import { onRenderSuspension, withSaveRenderBudget } from '../src/three/render-budget';

describe('save render budget', () => {
  it('notifies only suspension transitions across overlapping saves', async () => {
    const events: boolean[] = [];
    const stop = onRenderSuspension(value => events.push(value));
    let finishFirst!: () => void, finishSecond!: () => void;
    const first = withSaveRenderBudget(() => new Promise<void>(resolve => { finishFirst = resolve; }));
    const second = withSaveRenderBudget(() => new Promise<void>(resolve => { finishSecond = resolve; }));
    expect(events).toEqual([false, true]);
    finishFirst(); await first;
    expect(events).toEqual([false, true]);
    finishSecond(); await second;
    expect(events).toEqual([false, true, false]);
    stop();
  });
});
