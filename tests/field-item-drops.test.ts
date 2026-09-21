import { describe, expect, it } from 'vitest';
import { Random } from '../src/core/random';
import {
  FIELD_ITEM_STOCK_LIMIT,
  fieldItemCatalogCounts,
  grantFieldItem,
  rollFieldItemDrop,
} from '../src/openworld/field-item-drops';

function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

describe('wild field item drops', () => {
  it('uses the complete 6 tool and 64 mega stone catalog', () => {
    expect(fieldItemCatalogCounts()).toEqual({ heldTools: 6, megaStones: 64 });
  });

  it('keeps 94 percent empty, 5 percent held-tool, and 1 percent mega boundaries', () => {
    expect(rollFieldItemDrop(sequence(.06), 94, [])).toBeUndefined();
    expect(rollFieldItemDrop(sequence(.059, 0), 94, [])).toMatchObject({ kind: 'held-tool', quantity: 1 });
    expect(rollFieldItemDrop(sequence(.01, .999), 94, [])).toMatchObject({ kind: 'held-tool', quantity: 1 });
    expect(rollFieldItemDrop(sequence(.009, .1, 0), 94, [])).toMatchObject({
      id: 'mega-stone:gengar-mega', kind: 'mega-stone', quantity: 1,
    });
  });

  it('prefers the defeated species, then local species, while retaining a global branch', () => {
    expect(rollFieldItemDrop(sequence(0, .2, 0), 6, [94])).toMatchObject({ speciesId: 6 });
    expect(rollFieldItemDrop(sequence(0, .2, 0), 9999, [94])).toMatchObject({ speciesId: 94 });
    const global = rollFieldItemDrop(sequence(0, .9, .999), 6, [94]);
    expect(global?.kind).toBe('mega-stone');
    expect(global?.speciesId).not.toBe(6);
  });

  it('increments duplicate stock and refuses the one-billion overflow', () => {
    const inventory: Record<string, number> = { leftovers: 2 };
    expect(grantFieldItem(inventory, { id: 'leftovers', name: '먹다남은음식', kind: 'held-tool', quantity: 1 })).toBe(true);
    expect(inventory.leftovers).toBe(3);
    inventory.leftovers = FIELD_ITEM_STOCK_LIMIT;
    expect(grantFieldItem(inventory, { id: 'leftovers', name: '먹다남은음식', kind: 'held-tool', quantity: 1 })).toBe(false);
    expect(inventory.leftovers).toBe(FIELD_ITEM_STOCK_LIMIT);
  });

  it('replays the same roll from a saved world RNG state', () => {
    const first = new Random(9081);
    const restored = new Random(first.state);
    expect(rollFieldItemDrop(() => first.next(), 94, [94, 6]))
      .toEqual(rollFieldItemDrop(() => restored.next(), 94, [94, 6]));
    expect(first.state).toBe(restored.state);
  });
});
