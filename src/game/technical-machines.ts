import machinesJson from '../data/technical-machines.json' with { type: 'json' };
import { getMove } from '../data/pokemon';

export type TechnicalMachineTier = 'common' | 'uncommon' | 'rare';
export type TechnicalMachine = { id: string; moveId: number; name: string; tier: TechnicalMachineTier };

type MachineRow = { moveId: number; tier: TechnicalMachineTier; species: string };
const rows = (machinesJson as { machines: MachineRow[] }).machines;
/** Roadside and bag items for a machine use this id; the save stores counts by move ID. */
export const technicalMachineItemId = (moveId: number) => `tm:${moveId}`;
const machines: readonly TechnicalMachine[] = rows.map(row => ({ id: technicalMachineItemId(row.moveId), moveId: row.moveId, name: `기술머신 ${getMove(row.moveId).name}`, tier: row.tier }));
const byMove = new Map(machines.map(machine => [machine.moveId, machine]));
const bitsets = new Map(rows.map(row => [row.moveId, row.species]));

export const TECHNICAL_MACHINE_STOCK_LIMIT = 1_000_000_000;
export function technicalMachines(): readonly TechnicalMachine[] { return machines; }
export function getTechnicalMachine(moveId: number): TechnicalMachine | undefined { return byMove.get(moveId); }
export function technicalMachineFromItemId(itemId: string): TechnicalMachine | undefined {
  const match = /^tm:(\d+)$/.exec(itemId); return match ? byMove.get(Number(match[1])) : undefined;
}

/** Species n is bit n - 1 of the hex bitset, most significant bit first in each nibble. */
export function machineCompatible(moveId: number, speciesId: number): boolean {
  const bits = bitsets.get(moveId);
  if (!bits || !Number.isInteger(speciesId) || speciesId < 1) return false;
  const nibble = Math.floor((speciesId - 1) / 4);
  if (nibble >= bits.length) return false;
  return (Number.parseInt(bits[nibble], 16) & (8 >> ((speciesId - 1) % 4))) !== 0;
}

export function validateTechnicalMachineStock(value: unknown): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('기술머신 보관함이 올바르지 않습니다.');
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (String(Number(key)) !== key || !byMove.has(Number(key)) || !Number.isSafeInteger(count) || count < 0 || count > TECHNICAL_MACHINE_STOCK_LIMIT) throw new Error('기술머신 보관함이 올바르지 않습니다.');
    if (count > 0) result[key] = count;
  }
  return result;
}
