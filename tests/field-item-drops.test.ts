import { describe, expect, it } from 'vitest';
import { Random } from '../src/core/random';
import { captureItemChances, FIELD_ITEM_STOCK_LIMIT, fieldItemCatalogCounts, grantFieldItem, rollCapturedSpeciesItem } from '../src/openworld/field-item-drops';

describe('species capture item rewards', () => {
  it('keeps every supported item and rewards only its specified species', () => {
    expect(fieldItemCatalogCounts()).toEqual({ heldTools: 47, megaStones: 65 });
    expect(rollCapturedSpeciesItem(() => 0, 143)?.id).toBe('leftovers');
    expect(rollCapturedSpeciesItem(() => 0, 129)).toBeUndefined();
    expect(rollCapturedSpeciesItem(() => 0, 94)?.id).toBe('mega-stone:gengar-mega');
  });
  it('balances rare tools at 4 percent and splits the twelve percent Mega chance across forms', () => {
    expect(rollCapturedSpeciesItem(() => .03999, 143)?.id).toBe('leftovers');
    expect(rollCapturedSpeciesItem(() => .04, 143)).toBeUndefined();
    const choices = captureItemChances(6);
    expect(choices.reduce((sum, item) => sum + item.chance, 0)).toBeCloseTo(.12);
    expect(rollCapturedSpeciesItem(() => .12, 6)).toBeUndefined();
    expect(rollCapturedSpeciesItem(() => .05, 6)?.id).toBe('mega-stone:charizard-mega-x');
    expect(rollCapturedSpeciesItem(() => .07, 6)?.id).toBe('mega-stone:charizard-mega-y');
  });
  it('caps inventory and replays deterministically from the saved RNG', () => {
    const drop = rollCapturedSpeciesItem(() => 0, 143)!;
    const inventory: Record<string, number> = { leftovers: 2 };
    expect(grantFieldItem(inventory, drop)).toBe(true); expect(inventory.leftovers).toBe(3);
    inventory.leftovers = FIELD_ITEM_STOCK_LIMIT;
    expect(grantFieldItem(inventory, drop)).toBe(false);
    const a = new Random(9081), b = new Random(a.state);
    expect(rollCapturedSpeciesItem(() => a.next(), 94)).toEqual(rollCapturedSpeciesItem(() => b.next(), 94));
    expect(a.state).toBe(b.state);
  });
});
