import { describe, expect, it } from 'vitest';
import { FrameSampleRing } from '../src/openworld/render-probe';

describe('render probe frame samples', () => {
  it('retains a fixed chronological window without shifting the backing array', () => {
    const samples = new FrameSampleRing(3);
    samples.push({ frameMs: 10 });
    samples.push({ frameMs: 11 });
    samples.push({ frameMs: 12 });
    samples.push({ frameMs: 13 });
    expect(samples.read().map(sample => sample.frameMs)).toEqual([11, 12, 13]);
    samples.reset();
    samples.push({ frameMs: 14 });
    expect(samples.read().map(sample => sample.frameMs)).toEqual([14]);
  });
});
