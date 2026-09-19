import { describe, expect, it } from 'vitest';
import { getWorldAtlas } from '../src/openworld/atlas';
import { townPavingCells, townStyle } from '../src/openworld/town-style';

describe('town identity without more paving geometry', () => {
  it('distinguishes every Johto town while preserving the existing paving footprint', () => {
    const towns = getWorldAtlas('johto').locations.filter(location => location.kind === 'town');
    expect(new Set(towns.map(town => townStyle(town.id).color)).size).toBe(towns.length);
    expect(new Set(towns.map(town => townStyle(town.id).paving)).size).toBe(3);
    const original: string[] = [];
    for (let x = -7; x <= 7; x++) for (let z = -7; z <= 7; z++) if (Math.hypot(x, z) <= 7.1) original.push(`${x}:${z}`);
    for (const town of towns) expect(townPavingCells(town.id).map(([x, z]) => `${x}:${z}`)).toEqual(original);
  });
});
