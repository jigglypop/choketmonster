import type { InventoryItem } from '../game/engine';
import { TECHNICAL_MACHINE_LOCATIONS } from './technical-machine-locations';

/**
 * Items a dungeon holds in the version each region follows (item lists on Serebii and Bulbapedia): Red/Blue's Mt. Moon
 * Moon Stones and Safari Zone Leaf Stone, FireRed's Power Plant Thunder Stone; Gold's King's Rock in Slowpoke Well,
 * Moon Stone at Tohjo Falls, Dragon Fang in Dragon's Den, BlackGlasses in Dark Cave and NeverMeltIce in the Ice Path;
 * Emerald's Everstone in Granite Cave, Fire Stone on the Fiery Path and Moon Stone at Meteor Falls; Platinum's Iron
 * Plate on Iron Island.
 */
const DUNGEON_ITEMS: Readonly<Record<string, readonly InventoryItem[]>> = {
  'kanto:mt-moon': ['moon-stone'], 'kanto:safari-zone': ['leaf-stone'], 'kanto:power-plant': ['thunder-stone'],
  'johto:slowpoke-well': ['kings-rock'], 'johto:tohjo-falls': ['moon-stone'], 'johto:dragons-den': ['dragon-fang'],
  'johto:dark-cave': ['black-glasses'], 'johto:ice-path': ['never-melt-ice'],
  'hoenn:granite-cave': ['everstone'], 'hoenn:fiery-path': ['fire-stone'], 'hoenn:meteor-falls': ['moon-stone'],
  'sinnoh:iron-island': ['iron-plate'],
};

export type DungeonReward = { machines: number[]; items: InventoryItem[]; money: number };

/**
 * What clearing a dungeon the first time gives: the machines its version finds there, the items it holds, or, where it
 * holds neither, prize money that grows with its wild levels.
 */
export function dungeonReward(regionId: string, dungeonId: string, maxLevel: number): DungeonReward {
  const machines = Object.entries(TECHNICAL_MACHINE_LOCATIONS[regionId] ?? {})
    .filter(([, places]) => places.includes(dungeonId)).map(([move]) => Number(move));
  const items = [...DUNGEON_ITEMS[`${regionId}:${dungeonId}`] ?? []];
  const money = machines.length || items.length ? 0 : Math.max(1000, Math.round(maxLevel * 1.2) * 100);
  return { machines, items, money };
}
