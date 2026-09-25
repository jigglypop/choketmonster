import type { InventoryItem } from '../game/engine';

/** One counter of a town: machines by move id with their price, and items sold for money. */
export type TownShop = {
  name: string;
  machines?: Readonly<Record<number, number>>;
  items?: readonly InventoryItem[];
  /** Prices for items the general store does not price (Mega Stones). */
  prices?: Readonly<Partial<Record<InventoryItem, number>>>;
};

/**
 * What only one town sells, from the stores of the version each region follows: department stores and game corners
 * (machines), battle facilities (their Battle Point items, sold here for money in the town that hosts them or sails
 * to them) and special shops. Only machines and items this game has are listed; stronger ones still wait for badges.
 * Sources (store lists on Bulbapedia, Serebii, Game8 and Gamer Guides): FireRed Celadon Dept. Store 2F and Game Corner,
 * HeartGold Goldenrod Dept. Store 5F and Gold's Game Corner, HeartGold Battle Frontier, Emerald Lilycove Dept. Store,
 * Mauville Game Corner and Battle Frontier, Lavaridge Herb Shop, Platinum Veilstone Dept. Store, Diamond/Pearl Veilstone
 * Game Corner and Battle Tower, Black/White Battle Subway, X/Y Stone Emporium and Battle Maison, Sun/Moon Konikoni TM
 * stall and Battle Tree, Sword/Shield Battle Tower, Scarlet/Violet Delibird Presents.
 */
export const TOWN_SHOPS: Readonly<Record<string, Readonly<Record<string, readonly TownShop[]>>>> = {
  kanto: {
    celadon: [
      { name: '무지개시티 백화점', machines: { 280: 3000 } },
      { name: '무지개시티 게임코너', machines: { 58: 10000, 85: 10000, 53: 10000, 247: 10000 } },
    ],
  },
  johto: {
    goldenrod: [
      { name: '금빛시티 백화점', machines: { 411: 5500 } },
      { name: '금빛시티 게임코너', machines: { 87: 10000, 59: 10000, 126: 10000 } },
    ],
    // The Battle Frontier lies west of Olivine on Route 40.
    olivine: [{ name: '배틀프런티어', items: ['choice-band', 'choice-specs', 'choice-scarf', 'life-orb', 'focus-sash', 'leftovers', 'muscle-band', 'wise-glasses', 'bright-powder', 'wide-lens', 'quick-claw', 'focus-band', 'white-herb'] }],
    // Azalea's charcoal kiln.
    azalea: [{ name: '고동마을', items: ['charcoal'] }],
  },
  hoenn: {
    'lilycove-city': [{ name: '해안시티 백화점', machines: { 126: 5500, 87: 5500, 59: 5500 } }],
    'mauville-city': [{ name: '보라시티 게임코너', machines: { 53: 10000, 85: 10000, 58: 10000, 94: 8000 } }],
    // The ferry to the Battle Frontier sails from Slateport.
    'slateport-city': [{ name: '배틀프런티어', items: ['leftovers', 'white-herb', 'quick-claw', 'bright-powder', 'choice-band', 'focus-band'] }],
    // Lavaridge's herb shop, where the owner hands out Charcoal.
    'lavaridge-town': [{ name: '용암마을', items: ['charcoal'] }],
  },
  sinnoh: {
    'veilstone-city': [
      { name: '장막시티 백화점', machines: { 411: 5500, 126: 5500, 87: 5500, 59: 5500 } },
      { name: '장막시티 게임코너', machines: { 53: 10000, 58: 10000, 85: 10000, 14: 8000 } },
    ],
    // The boat to the Battle Tower's Fight Area leaves from Snowpoint.
    'snowpoint-city': [{ name: '배틀타워', items: ['choice-band', 'choice-specs', 'choice-scarf', 'life-orb', 'focus-sash', 'leftovers', 'muscle-band', 'wise-glasses', 'expert-belt', 'bright-powder', 'wide-lens', 'focus-band', 'white-herb'] }],
  },
  unova: {
    'nimbasa-city': [{ name: '배틀서브웨이', items: ['choice-band', 'choice-specs', 'choice-scarf', 'focus-sash', 'life-orb', 'focus-band', 'bright-powder', 'air-balloon', 'rocky-helmet'] }],
  },
  kalos: {
    'lumiose-city': [
      // The Stone Emporium's back corner offers the Kanto partners' Mega Stones.
      { name: '미르시티', items: ['mega-stone:venusaur-mega', 'mega-stone:charizard-mega-x', 'mega-stone:charizard-mega-y', 'mega-stone:blastoise-mega'],
        prices: { 'mega-stone:venusaur-mega': 20000, 'mega-stone:charizard-mega-x': 20000, 'mega-stone:charizard-mega-y': 20000, 'mega-stone:blastoise-mega': 20000 } },
      // The Battle Maison is a train ride from Lumiose.
      { name: '배틀하우스', items: ['choice-band', 'choice-specs', 'choice-scarf', 'assault-vest', 'focus-sash', 'life-orb', 'air-balloon', 'weakness-policy', 'white-herb', 'wise-glasses', 'muscle-band', 'wide-lens', 'focus-band', 'bright-powder'] },
    ],
  },
  alola: {
    'konikoni-city': [{ name: '코니코니시티', machines: { 421: 10000 } }],
    // The Battle Tree stands on Poni Island, above Seafolk Village.
    'seafolk-village': [{ name: '배틀트리', items: ['choice-band', 'choice-specs', 'choice-scarf', 'assault-vest', 'life-orb', 'focus-sash', 'leftovers', 'bright-powder'] }],
  },
  galar: {
    wyndon: [{ name: '배틀타워', items: ['choice-band', 'choice-specs', 'choice-scarf', 'life-orb', 'focus-sash', 'assault-vest', 'weakness-policy', 'rocky-helmet', 'air-balloon'],
      machines: { 34: 5000, 53: 8000, 57: 8000, 58: 8000, 85: 8000, 89: 8000, 94: 8000 } }],
  },
  paldea: {
    mesagoza: [{ name: '델리버드 프레젠트', items: ['focus-sash'] }],
    levincia: [{ name: '델리버드 프레젠트', items: ['black-glasses', 'never-melt-ice', 'metal-coat', 'shell-bell'] }],
    cascarrafa: [{ name: '델리버드 프레젠트', items: ['charcoal', 'rocky-helmet', 'miracle-seed', 'mystic-water', 'silk-scarf', 'sharp-beak', 'silver-powder', 'muscle-band', 'wise-glasses', 'expert-belt', 'focus-band', 'choice-scarf', 'quick-claw'] }],
  },
};
