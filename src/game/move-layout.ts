import { getMove } from '../data/pokemon';
import type { Monster } from './engine';

export type MoveLayoutEntry = { moveId: number; pp: number; sourceIndex: number };

function preferredMoveIds(monster: Monster): number[] {
  const current = new Set(monster.moves.map((slot) => slot.moveId));
  const preferred = (monster.moveOrder ?? []).filter((moveId) => current.has(moveId));
  const included = new Set(preferred);
  for (const slot of monster.moves) {
    if (!included.has(slot.moveId)) {
      preferred.push(slot.moveId);
      included.add(slot.moveId);
    }
  }
  return preferred;
}

/**
 * Returns presentation slots without changing the engine-owned move array.
 * Physical/special moves are shown before status moves; saved order applies
 * only within each group.
 */
export function getMoveLayout(monster: Monster): MoveLayoutEntry[] {
  const preference = preferredMoveIds(monster);
  const rank = new Map(preference.map((moveId, index) => [moveId, index]));
  return monster.moves
    .map((slot, sourceIndex) => ({ moveId: slot.moveId, pp: slot.pp, sourceIndex }))
    .sort((a, b) => {
      const aStatus = getMove(a.moveId).damageClass === 'status';
      const bStatus = getMove(b.moveId).damageClass === 'status';
      return Number(aStatus) - Number(bStatus)
        || (rank.get(a.moveId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.moveId) ?? Number.MAX_SAFE_INTEGER)
        || a.sourceIndex - b.sourceIndex;
    });
}

/** Keep a persisted preference aligned with learned moves after replacement. */
export function reconcileMoveOrder(monster: Monster): void {
  if (monster.moveOrder === undefined) return;
  monster.moveOrder = getMoveLayout(monster).map((entry) => entry.moveId);
}
