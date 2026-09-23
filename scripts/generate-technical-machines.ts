// Generates src/data/technical-machines.json from the pinned PokeAPI CSV cache.
// Compatibility is every species with a machine (method 4) learn row for the move
// in any version group, across all of the species' varieties.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { MOVES } from '../src/data/pokemon';

const CACHE = 'src/data/.cache/pokeapi';
const OUTPUT = 'src/data/technical-machines.json';
const MAX_SPECIES = 1025;

/** Single-turn moves the battle engine resolves from move data alone, grouped by type. */
const MACHINE_MOVE_IDS = [
  34, 263, 14, // normal: Body Slam, Facade, Swords Dance
  53, 126, 488, // fire: Flamethrower, Fire Blast, Flame Charge
  57, 56, 503, 127, // water: Surf, Hydro Pump, Scald, Waterfall
  412, 202, 402, // grass: Energy Ball, Giga Drain, Seed Bomb
  85, 87, 528, // electric: Thunderbolt, Thunder, Wild Charge
  58, 59, 419, // ice: Ice Beam, Blizzard, Avalanche
  370, 280, 411, 396, // fighting: Close Combat, Brick Break, Focus Blast, Aura Sphere
  188, 398, // poison: Sludge Bomb, Poison Jab
  89, 414, // ground: Earthquake, Earth Power
  413, 403, 512, // flying: Brave Bird, Air Slash, Acrobatics
  94, 473, 428, 347, // psychic: Psychic, Psyshock, Zen Headbutt, Calm Mind
  404, 405, // bug: X-Scissor, Bug Buzz
  444, 157, 408, // rock: Stone Edge, Rock Slide, Power Gem
  247, 421, // ghost: Shadow Ball, Shadow Claw
  337, 406, // dragon: Dragon Claw, Dragon Pulse
  399, 242, // dark: Dark Pulse, Crunch
  430, 442, // steel: Flash Cannon, Iron Head
  585, 605, 583, // fairy: Moonblast, Dazzling Gleam, Play Rough
];

const table = (name: string) => parse(readFileSync(`${CACHE}/${name}`), { columns: true, skip_empty_lines: true }) as Record<string, string>[];
const speciesOfPokemon = new Map(table('pokemon.csv').map(row => [Number(row.id), Number(row.species_id)]));
const wanted = new Set(MACHINE_MOVE_IDS.filter(id => MOVES[id]));
const compatible = new Map<number, Set<number>>([...wanted].map(id => [id, new Set<number>()]));
for (const row of table('pokemon_moves.csv')) {
  if (row.pokemon_move_method_id !== '4') continue;
  const moveId = Number(row.move_id), species = speciesOfPokemon.get(Number(row.pokemon_id));
  if (!species || species > MAX_SPECIES) continue;
  compatible.get(moveId)?.add(species);
}

/** Bit n of the hex string is species n + 1, most significant bit of each nibble first. */
function bitset(species: Set<number>): string {
  const bits = new Uint8Array(Math.ceil(MAX_SPECIES / 8));
  for (const id of species) bits[(id - 1) >> 3] |= 0x80 >> ((id - 1) & 7);
  return Buffer.from(bits).toString('hex');
}

const tier = (moveId: number) => {
  const move = MOVES[moveId];
  if (move.damageClass === 'status') return 'uncommon';
  return move.power >= 110 ? 'rare' : move.power >= 90 ? 'uncommon' : 'common';
};

const machines = MACHINE_MOVE_IDS.filter(id => compatible.get(id)?.size).map(moveId => ({ moveId, tier: tier(moveId), species: bitset(compatible.get(moveId)!) }));
const missing = MACHINE_MOVE_IDS.filter(id => !machines.some(machine => machine.moveId === id));
if (missing.length) console.warn(`Skipped moves without runtime data or machine rows: ${missing.join(', ')}`);
writeFileSync(OUTPUT, `${JSON.stringify({ source: 'PokeAPI pokemon_moves.csv, pokemon_move_method_id 4, all version groups', maxSpecies: MAX_SPECIES, machines }, null, 1)}\n`);
console.log(`${machines.length} technical machines → ${OUTPUT}`);
