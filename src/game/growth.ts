import type { Monster } from './engine';

/** The highest participant level is used once, so batch merging cannot stack linearly. */
export const DUPLICATE_MERGE_PERCENT = 5;
export function duplicateMergeValue(monster: Pick<Monster, 'level'>) {
  return { levels: monster.level * DUPLICATE_MERGE_PERCENT / 100, percent: DUPLICATE_MERGE_PERCENT };
}
