/** Mulberry32 with explicit serializable state. Rendering must never consume this RNG. */
export class Random {
  constructor(public state: number) { this.state = state >>> 0; }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number { return Math.floor(this.next() * n); }
}
export const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x));
