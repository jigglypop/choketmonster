import type { Monster } from './engine';

export const DUPLICATE_MERGE_PERCENT = 20;
export function duplicateMergeValue(monster: Pick<Monster, 'level'>) {
  return { levels: monster.level * DUPLICATE_MERGE_PERCENT / 100, percent: DUPLICATE_MERGE_PERCENT };
}
