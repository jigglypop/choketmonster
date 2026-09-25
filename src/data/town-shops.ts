import type { InventoryItem } from '../game/engine';

/** One counter of a town: machines by move id with their price, and items sold for money. */
export type TownShop = {
  name: string;
  machines?: Readonly<Record<number, number>>;
  items?: readonly InventoryItem[];
  /** Prices for items the general store does not price (Mega Stones). */
  prices?: Readonly<Partial<Record<InventoryItem, number>>>;
};

const STONES = ['fire-stone', 'water-stone', 'thunder-stone', 'leaf-stone', 'moon-stone', 'sun-stone', 'shiny-stone', 'dusk-stone', 'dawn-stone'] as const;

/**
 * What only one town sells, from the stores of the version each region follows: department stores and game corners
 * (machines), battle facilities (their Battle Point items, sold here for money in the town that hosts them or sails
 * to them) and special shops. Only machines and items this game has are listed; stronger ones still wait for badges.
 * Sources (store lists on Bulbapedia, Serebii, Game8 and Gamer Guides): FireRed Celadon Dept. Store 2F and Game Corner,
 * HeartGold Goldenrod Dept. Store 5F and Gold's Game Corner, HeartGold Battle Frontier, Emerald Lilycove Dept. Store,
 * Mauville Game Corner and Battle Frontier, Lavaridge Herb Shop, Platinum Veilstone Dept. Store, Diamond/Pearl Veilstone
 * Game Corner and Battle Tower, Black/White Battle Subway, X/Y Stone Emporium and Battle Maison, Sun/Moon Konikoni TM
 * stall and Battle Tree, Sword/Shield Battle Tower, Scarlet/Violet Delibird Presents.
 * Evolution items: Celadon's 4F stones (Let's Go adds the Moon Stone), Silph Co.'s Up-Grade and the S.S. Aqua's Metal
 * Coat (Gold/Silver), the Pokéathlon Dome's stones by Goldenrod, Slowpoke Well's King's Rock, Blackthorn's Dragon Scale,
 * Slateport's Deep Sea Tooth and Scale, Mossdeep's Sun Stone, Solaceon's Oval Stone, the battle facilities' evolution
 * items (Diamond/Pearl, Black 2/White 2, X/Y), Undella's Prism Scale, Lumiose's Stone Emporium, Stow-on-Side's pots,
 * Jubilife Village's Hisuian items and the Delibird Presents general goods. A region whose games sell no stones gets them
 * in its biggest market town (Lilycove, Veilstone, Castelia, Konikoni, Hammerlocke), so every region can evolve its own.
 */
export const TOWN_SHOPS: Readonly<Record<string, Readonly<Record<string, readonly TownShop[]>>>> = {
  kanto: {
    celadon: [
      { name: '무지개시티 백화점', machines: { 280: 3000 }, items: ['fire-stone', 'water-stone', 'thunder-stone', 'leaf-stone', 'moon-stone'] },
      { name: '무지개시티 게임코너', machines: { 58: 10000, 85: 10000, 53: 10000, 247: 10000 } },
    ],
    saffron: [{ name: '실프주식회사', items: ['up-grade'] }],
    vermilion: [{ name: '갈색시티', items: ['metal-coat'] }],
  },
  johto: {
    goldenrod: [
      { name: '포켓슬론 돔', items: [...STONES] },
      { name: '금빛시티 백화점', machines: { 411: 5500 } },
      { name: '금빛시티 게임코너', machines: { 87: 10000, 59: 10000, 126: 10000 } },
    ],
    // The Battle Frontier lies west of Olivine on Route 40.
    olivine: [{ name: '담청시티', items: ['metal-coat'] }, { name: '배틀프런티어', items: ['choice-band', 'choice-specs', 'choice-scarf', 'life-orb', 'focus-sash', 'leftovers', 'muscle-band', 'wise-glasses', 'bright-powder', 'wide-lens', 'quick-claw', 'focus-band', 'white-herb'] }],
    // Azalea's charcoal kiln.
    azalea: [{ name: '고동마을', items: ['charcoal', 'kings-rock'] }],
    blackthorn: [{ name: '검은먹시티', items: ['dragon-scale'] }],
  },
  hoenn: {
    'lilycove-city': [{ name: '해안시티 백화점', machines: { 126: 5500, 87: 5500, 59: 5500 }, items: ['fire-stone', 'water-stone', 'thunder-stone', 'leaf-stone', 'moon-stone'] }],
    'mossdeep-city': [{ name: '이끼시티', items: ['sun-stone'] }],
    'mauville-city': [{ name: '보라시티 게임코너', machines: { 53: 10000, 85: 10000, 58: 10000, 94: 8000 } }],
    // The ferry to the Battle Frontier sails from Slateport.
    'slateport-city': [{ name: '잿빛도시', items: ['deep-sea-tooth', 'deep-sea-scale'] }, { name: '배틀프런티어', items: ['leftovers', 'white-herb', 'quick-claw', 'bright-powder', 'choice-band', 'focus-band'] }],
    // Lavaridge's herb shop, where the owner hands out Charcoal.
    'lavaridge-town': [{ name: '용암마을', items: ['charcoal'] }],
  },
  sinnoh: {
    'veilstone-city': [
      { name: '장막시티 백화점', machines: { 411: 5500, 126: 5500, 87: 5500, 59: 5500 }, items: [...STONES] },
      { name: '장막시티 게임코너', machines: { 53: 10000, 58: 10000, 85: 10000, 14: 8000 } },
    ],
    // The boat to the Battle Tower's Fight Area leaves from Snowpoint.
    'snowpoint-city': [{ name: '배틀타워', items: ['choice-band', 'choice-specs', 'choice-scarf', 'life-orb', 'focus-sash', 'leftovers', 'muscle-band', 'wise-glasses', 'expert-belt', 'bright-powder', 'wide-lens', 'focus-band', 'white-herb',
      'protector', 'electirizer', 'magmarizer', 'dubious-disc', 'reaper-cloth', 'razor-claw', 'razor-fang'] }],
    'solaceon-town': [{ name: '신수마을', items: ['oval-stone'] }],
  },
  unova: {
    'nimbasa-city': [{ name: '배틀서브웨이', items: ['choice-band', 'choice-specs', 'choice-scarf', 'focus-sash', 'life-orb', 'focus-band', 'bright-powder', 'air-balloon', 'rocky-helmet', 'razor-claw', 'razor-fang'] }],
    'castelia-city': [{ name: '구름시티', items: [...STONES] }],
    'undella-town': [{ name: '물결마을', items: ['prism-scale'] }],
  },
  kalos: {
    'lumiose-city': [
      // The Stone Emporium's back corner offers the Kanto partners' Mega Stones.
      { name: '미르시티', items: [...STONES, 'mega-stone:venusaur-mega', 'mega-stone:charizard-mega-x', 'mega-stone:charizard-mega-y', 'mega-stone:blastoise-mega'],
        prices: { 'mega-stone:venusaur-mega': 20000, 'mega-stone:charizard-mega-x': 20000, 'mega-stone:charizard-mega-y': 20000, 'mega-stone:blastoise-mega': 20000 } },
      // The Battle Maison is a train ride from Lumiose.
      { name: '배틀하우스', items: ['choice-band', 'choice-specs', 'choice-scarf', 'assault-vest', 'focus-sash', 'life-orb', 'air-balloon', 'weakness-policy', 'white-herb', 'wise-glasses', 'muscle-band', 'wide-lens', 'focus-band', 'bright-powder',
        'protector', 'electirizer', 'magmarizer', 'reaper-cloth', 'up-grade', 'dubious-disc', 'whipped-dream', 'sachet'] },
    ],
  },
  alola: {
    'konikoni-city': [{ name: '코니코니시티', machines: { 421: 10000 }, items: [...STONES, 'ice-stone'] }],
    // The Battle Tree stands on Poni Island, above Seafolk Village.
    'seafolk-village': [{ name: '배틀트리', items: ['choice-band', 'choice-specs', 'choice-scarf', 'assault-vest', 'life-orb', 'focus-sash', 'leftovers', 'bright-powder'] }],
  },
  galar: {
    turffield: [{ name: '터프마을', items: ['tart-apple', 'sweet-apple'] }],
    'stow-on-side': [{ name: '래터럴마을', items: ['cracked-pot', 'chipped-pot'] }],
    wedgehurst: [{ name: '브래시마을', items: ['scroll-of-darkness', 'scroll-of-waters'] }],
    hammerlocke: [{ name: '너클시티', items: [...STONES] }],
    circhester: [{ name: '키르쿠스마을', items: ['ice-stone'] }],
    wyndon: [{ name: '배틀타워', items: ['choice-band', 'choice-specs', 'choice-scarf', 'life-orb', 'focus-sash', 'assault-vest', 'weakness-policy', 'rocky-helmet', 'air-balloon'],
      machines: { 34: 5000, 53: 8000, 57: 8000, 58: 8000, 85: 8000, 89: 8000, 94: 8000 } }],
  },
  hisui: {
    'jubilife-village': [{ name: '축복마을', items: [...STONES, 'ice-stone', 'black-augurite', 'peat-block'] }],
  },
  paldea: {
    mesagoza: [{ name: '델리버드 프레젠트', items: [...STONES, 'ice-stone', 'tart-apple', 'sweet-apple', 'focus-sash',
      'syrupy-apple', 'metal-alloy', 'auspicious-armor', 'malicious-armor', 'unremarkable-teacup', 'masterpiece-teacup'] }],
    levincia: [{ name: '델리버드 프레젠트', items: [...STONES, 'ice-stone', 'tart-apple', 'sweet-apple', 'black-glasses', 'never-melt-ice', 'metal-coat', 'shell-bell'] }],
    cascarrafa: [{ name: '델리버드 프레젠트', items: [...STONES, 'ice-stone', 'tart-apple', 'sweet-apple', 'charcoal', 'rocky-helmet', 'miracle-seed', 'mystic-water', 'silk-scarf', 'sharp-beak', 'silver-powder', 'muscle-band', 'wise-glasses', 'expert-belt', 'focus-band', 'choice-scarf', 'quick-claw'] }],
  },
};
