import { afterEach, describe, expect, it } from 'vitest';
import { readMusicPaused, writeMusicPaused } from '../src/audio/original-music';

describe('music pause preference', () => {
  afterEach(() => { Reflect.deleteProperty(globalThis, 'sessionStorage'); });

  it('falls back to playing when the browser blocks session storage', () => {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    expect(readMusicPaused()).toBe(false);
    expect(() => writeMusicPaused(true)).not.toThrow();
    expect(() => writeMusicPaused(false)).not.toThrow();
  });

  it('remembers a pause for the session', () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); },
    } });
    writeMusicPaused(true); expect(readMusicPaused()).toBe(true);
    writeMusicPaused(false); expect(readMusicPaused()).toBe(false);
  });
});
