import { describe, expect, it } from 'vitest';
import { creatureLods, terrainChunks } from '../src/openworld/lod';
import type { WorldCreature } from '../src/openworld/types';

const creature = (id: string, x: number, z: number): WorldCreature => ({ id, x, z, speciesId: 152, name: '치코리타', level: 5, hp: 20, maxHp: 20 });

describe('visible world streaming budgets', () => {
  it('does not request distant or offscreen Pokemon even when selected, and caps near models', () => {
    const entries = [creature('companion:mon-1', 0, 0), creature('selected-far', 100, 0), creature('behind-camera', -12, 0),
      ...Array.from({ length: 1000 }, (_, i) => creature(`wild-${i}`, 2 + i % 20, i % 5))];
    const before = JSON.stringify(entries);
    const visible = creatureLods(entries, { x: 0, z: 0 }, x => x >= 0, true, 'selected-far');
    expect(visible.filter(item => item.model)).toHaveLength(4);
    expect(visible.map(item => item.creature.id)).not.toContain('selected-far');
    expect(visible.map(item => item.creature.id)).not.toContain('behind-camera');
    expect(visible[0].creature.id).toBe('companion:mon-1');
    expect(JSON.stringify(entries)).toBe(before);
  });

  it('only admits nearby 3D models and keeps unavailable saved companions as status markers', () => {
    const visible = creatureLods([creature('near', 10, 0), creature('middle', 45, 0), creature('far', 100, 0)], { x: 0, z: 0 }, () => true, false);
    expect(visible.map(item => [item.creature.id, item.model])).toEqual([['near', true]]);
    const unsupported = [
      { ...creature('wild-unavailable', 1, 0), speciesId: 1024 },
      { ...creature('companion:saved-mon', 0, 0), speciesId: 1024 },
    ];
    expect(creatureLods(unsupported, { x: 0, z: 0 }, () => true, true).map(item => [item.creature.id, item.model]))
      .toEqual([['companion:saved-mon', false]]);
  });

  it('keeps local ground while clipping other chunks and changes detail with distance', () => {
    const player = { x: -68, z: 82 };
    const hidden = terrainChunks(player, () => false), all = terrainChunks(player, () => true);
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.length).toBeLessThan(all.length);
    expect(hidden.every(chunk => chunk.segments === 12)).toBe(true);
    expect(all.some(chunk => chunk.segments === 4)).toBe(true);
    expect(all.length).toBeLessThan(36);
    const moved = terrainChunks({ x: 100, z: -100 }, () => false);
    expect(moved.some(chunk => hidden.some(previous => previous.key === chunk.key))).toBe(false);
  });
});
