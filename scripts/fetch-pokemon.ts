import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { pokemonFormKoreanName } from '../src/data/pokemon-form-names';
import { COMBAT_FORMS } from '../src/data/pokemon-combat-forms';

const ROOT = new URL('../', import.meta.url);
const CACHE_DIR = new URL('src/data/.cache/pokeapi/', ROOT);
const SPRITE_DIR = new URL('public/pokemon/', ROOT);
const OUTPUTS = {
  pokemon: new URL('src/data/pokemon.ts', ROOT),
  versions: new URL('src/data/pokemon-versions.ts', ROOT),
  experience: new URL('src/data/pokemon-experience.ts', ROOT),
  validation: new URL('rust-server/data/pokemon-validation.json', ROOT),
  ranked: new URL('rust-server/data/ranked-catalog.json', ROOT),
};
const SOURCE_MANIFEST = new URL('src/data/source-manifest.json', ROOT);
const SPRITE_MANIFEST = new URL('public/pokemon/manifest.json', ROOT);
const CONCURRENCY = 12;
const CSV_FILES = [
  'abilities.csv', 'ability_names.csv', 'ability_prose.csv',
  'experience.csv', 'growth_rates.csv', 'items.csv', 'languages.csv', 'move_meta.csv',
  'move_meta_ailments.csv', 'move_meta_stat_changes.csv', 'move_names.csv', 'moves.csv',
  'pokedex_prose.csv', 'pokedex_version_groups.csv', 'pokedexes.csv', 'pokemon.csv',
  'pokemon_dex_numbers.csv', 'pokemon_evolution.csv', 'pokemon_form_names.csv', 'pokemon_forms.csv',
  'pokemon_abilities.csv', 'pokemon_habitat_names.csv', 'pokemon_habitats.csv', 'pokemon_moves.csv', 'pokemon_species.csv',
  'pokemon_species_names.csv', 'pokemon_stats.csv', 'pokemon_types.csv', 'stats.csv',
  'type_efficacy.csv', 'types.csv', 'version_groups.csv', 'version_names.csv', 'versions.csv',
] as const;

type Row = Record<string, string>;
type FileEntry = { file?: string; path?: string; url: string; sha256: string; bytes: number };
type PreviousManifest = { resolvedCommit: string; csvFiles?: FileEntry[]; sourceFiles?: FileEntry[]; files?: FileEntry[] };
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const exists = async (path: URL) => { try { await stat(path); return true; } catch { return false; } };
const rows = (bytes: Buffer) => parse(bytes, { columns: true, skip_empty_lines: true, relax_quotes: true }) as Row[];
const byId = (data: Row[]) => new Map(data.map(row => [Number(row.id), row]));
const ts = (value: unknown) => JSON.stringify(value, null, 2);
const num = (value: string | undefined) => value ? Number(value) : 0;
const groupBy = <T, K>(values: T[], key: (value: T) => K) => {
  const result = new Map<K, T[]>();
  for (const value of values) result.set(key(value), [...(result.get(key(value)) ?? []), value]);
  return result;
};
const localized = (data: Row[], key: string, languageId: number, value = 'name') => new Map(
  data.filter(row => Number(row.local_language_id) === languageId).map(row => [Number(row[key]), row[value]]),
);

async function githubHead(repo: string) {
  const response = await fetch(`https://api.github.com/repos/PokeAPI/${repo}/commits/master`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'choketmon-data-builder/2.0' },
  });
  if (!response.ok) throw new Error(`Cannot resolve ${repo} revision: ${response.status}`);
  return String((await response.json() as { sha: string }).sha);
}

async function download(url: string, destination: URL, expectedSha?: string, optional = false): Promise<Buffer | undefined> {
  const cached = await exists(destination) ? await readFile(destination) : undefined;
  if (cached && expectedSha && sha256(cached) !== expectedSha) throw new Error(`Cache checksum mismatch: ${destination.pathname}`);
  if (cached && !process.argv.includes('--verify-upstream')) return cached;
  const partial = new URL(`${destination.href}.part`);
  const offset = await exists(partial) ? (await stat(partial)).size : 0;
  const headers: Record<string, string> = { 'user-agent': 'choketmon-data-builder/2.0' };
  if (offset) headers.range = `bytes=${offset}-`;
  const response = await fetch(url, { headers });
  if (optional && response.status === 404) { await rm(partial, { force: true }); return undefined; }
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  const incoming = Buffer.from(await response.arrayBuffer());
  if (offset && response.status === 206) await appendFile(partial, incoming); else await writeFile(partial, incoming);
  const complete = await readFile(partial);
  if (expectedSha && sha256(complete) !== expectedSha) throw new Error(`Pinned checksum mismatch: ${url}`);
  if (cached && sha256(cached) !== sha256(complete)) throw new Error(`Cached source differs from pinned revision: ${url}`);
  if (cached) await rm(partial, { force: true }); else await rename(partial, destination);
  return cached ?? complete;
}

async function pool<T>(jobs: (() => Promise<T>)[], limit = CONCURRENCY) {
  const result: T[] = new Array(jobs.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) { const index = next++; result[index] = await jobs[index](); }
  }));
  return result;
}

await Promise.all([
  mkdir(CACHE_DIR, { recursive: true }), mkdir(SPRITE_DIR, { recursive: true }),
  mkdir(new URL('back/', SPRITE_DIR), { recursive: true }), mkdir(new URL('public/data/', ROOT), { recursive: true }),
  mkdir(new URL('rust-server/data/', ROOT), { recursive: true }),
]);
const previousData: PreviousManifest | undefined = await exists(SOURCE_MANIFEST) ? JSON.parse(await readFile(SOURCE_MANIFEST, 'utf8')) : undefined;
const previousSprites: PreviousManifest | undefined = await exists(SPRITE_MANIFEST) ? JSON.parse(await readFile(SPRITE_MANIFEST, 'utf8')) : undefined;
const dataCommit = previousData?.resolvedCommit ?? await githubHead('pokeapi');
const spritesCommit = previousSprites?.resolvedCommit ?? await githubHead('sprites');
if (![dataCommit, spritesCommit].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error('Immutable source commits required');
const csvBase = `https://raw.githubusercontent.com/PokeAPI/pokeapi/${dataCommit}/data/v2/csv`;
const spriteBase = `https://raw.githubusercontent.com/PokeAPI/sprites/${spritesCommit}/sprites/pokemon`;
const formsUrl = `https://raw.githubusercontent.com/PokeAPI/sprites/${spritesCommit}/scripts/forms.json`;
const csvBuffers = await pool(CSV_FILES.map(file => async () => {
  const bytes = await download(`${csvBase}/${file}`, new URL(file, CACHE_DIR), previousData?.csvFiles?.find(entry => entry.file === file)?.sha256);
  if (!bytes) throw new Error(`Missing ${file}`); return { file, bytes };
}));
const formsBytes = await download(formsUrl, new URL('sprite-forms.json', CACHE_DIR), previousData?.sourceFiles?.find(entry => entry.file === 'sprite-forms.json')?.sha256);
if (!formsBytes) throw new Error('Missing sprite forms map');
const spriteKeyByIdentifier = new Map(Object.entries(JSON.parse(formsBytes.toString()) as Record<string, string>).map(([key, id]) => [id, key]));
const tables = new Map(csvBuffers.map(({ file, bytes }) => [file, rows(bytes)]));
const table = (name: typeof CSV_FILES[number]) => tables.get(name)!;

const languages = table('languages.csv');
const ko = Number(languages.find(row => row.iso639 === 'ko')?.id ?? 3);
const en = Number(languages.find(row => row.iso639 === 'en')?.id ?? 9);
const speciesRows = table('pokemon_species.csv').sort((a, b) => Number(a.id) - Number(b.id));
const speciesById = byId(speciesRows);
const pokemonRows = table('pokemon.csv');
const pokemonById = byId(pokemonRows);
const defaults = pokemonRows.filter(row => row.is_default === '1');
const defaultBySpecies = new Map(defaults.map(row => [Number(row.species_id), row]));
const defaultIds = new Set(defaults.map(row => Number(row.id)));
const speciesKo = localized(table('pokemon_species_names.csv'), 'pokemon_species_id', ko);
const speciesEn = localized(table('pokemon_species_names.csv'), 'pokemon_species_id', en);
const moveKo = localized(table('move_names.csv'), 'move_id', ko);
const moveEn = localized(table('move_names.csv'), 'move_id', en);
const habitatKo = localized(table('pokemon_habitat_names.csv'), 'pokemon_habitat_id', ko);
const habitats = byId(table('pokemon_habitats.csv'));
const growth = byId(table('growth_rates.csv'));
const items = byId(table('items.csv'));
const moveRows = byId(table('moves.csv'));
const moveMeta = new Map(table('move_meta.csv').map(row => [Number(row.move_id), row]));
const ailments = byId(table('move_meta_ailments.csv'));
const stats = byId(table('stats.csv'));
const types = byId(table('types.csv'));
const typeRows = groupBy(table('pokemon_types.csv').filter(row => defaultIds.has(Number(row.pokemon_id))), row => Number(row.pokemon_id));
const statRows = groupBy(table('pokemon_stats.csv').filter(row => defaultIds.has(Number(row.pokemon_id))), row => Number(row.pokemon_id));
const allLearnRows = table('pokemon_moves.csv').filter(row => defaultIds.has(Number(row.pokemon_id)) && row.pokemon_move_method_id === '1');
const learnRowsByPokemon = groupBy(allLearnRows, row => Number(row.pokemon_id));
const groupOrder = new Map(table('version_groups.csv').map(row => [Number(row.id), Number(row.order)]));
const selectedGroup = new Map<number, number>();
for (const pokemon of defaults) {
  const ids = [...new Set((learnRowsByPokemon.get(Number(pokemon.id)) ?? []).map(row => Number(row.version_group_id)))];
  const selected = ids.sort((a, b) => (groupOrder.get(b) ?? 0) - (groupOrder.get(a) ?? 0))[0];
  if (selected) selectedGroup.set(Number(pokemon.id), selected);
}
const selectedLearnRows = allLearnRows.filter(row => selectedGroup.get(Number(row.pokemon_id)) === Number(row.version_group_id));
const selectedLearnByPokemon = groupBy(selectedLearnRows, row => Number(row.pokemon_id));
// Machine moves need an explicit runtime acquisition path. Start with Tera Blast,
// whose source compatibility table is version group 25 (Scarlet/Violet).
const runtimeMachineMoveIds = new Set([851]);
const machineRows = table('pokemon_moves.csv').filter(row => row.pokemon_move_method_id === '4' && runtimeMachineMoveIds.has(Number(row.move_id)));
const machineMovesBySpecies = groupBy(machineRows, row => Number(pokemonById.get(Number(row.pokemon_id))?.species_id));
const moveIds = [...new Set([...selectedLearnRows.map(row => Number(row.move_id)), ...runtimeMachineMoveIds, ...COMBAT_FORMS.flatMap(form => form.levelUpMoves.map(move => move.moveId))])].sort((a, b) => a - b);
const statChanges = groupBy(table('move_meta_stat_changes.csv'), row => Number(row.move_id));
const standardTypes = [...types.values()].filter(row => Number(row.id) <= 18);
const efficacy = table('type_efficacy.csv');
const typeEffectiveness = Object.fromEntries(standardTypes.map(attack => [attack.identifier, Object.fromEntries(standardTypes.map(defense => [
  defense.identifier, Number(efficacy.find(row => row.damage_type_id === attack.id && row.target_type_id === defense.id)?.damage_factor ?? 100) / 100,
]))]));
const moves = Object.fromEntries(moveIds.map(id => {
  const row = moveRows.get(id)!; const meta = moveMeta.get(id);
  const ailment = meta ? ailments.get(Number(meta.meta_ailment_id))?.identifier : undefined;
  const chances = [row.effect_chance, meta?.ailment_chance, meta?.flinch_chance, meta?.stat_chance].filter(Boolean).map(Number).filter(value => value > 0);
  return [id, {
    id, name: moveKo.get(id) ?? moveEn.get(id) ?? row.identifier, englishName: moveEn.get(id) ?? row.identifier,
    type: types.get(Number(row.type_id))?.identifier, power: num(row.power), accuracy: num(row.accuracy), pp: num(row.pp),
    damageClass: ({ 1: 'status', 2: 'physical', 3: 'special' } as const)[Number(row.damage_class_id) as 1 | 2 | 3],
    priority: Number(row.priority), effectId: Number(row.effect_id), targetId: Number(row.target_id), healing: num(meta?.healing),
    drain: num(meta?.drain), metaCategory: num(meta?.meta_category_id), ailmentChance: num(meta?.ailment_chance),
    statChance: num(meta?.stat_chance), minHits: num(meta?.min_hits), maxHits: num(meta?.max_hits),
    statChanges: (statChanges.get(id) ?? []).map(change => ({ stat: stats.get(Number(change.stat_id))!.identifier, change: Number(change.change) })),
    ...(ailment && ailment !== 'none' ? { ailment } : {}), ...(chances.length ? { effectChance: Math.max(...chances) } : {}),
  }];
}));
const evolutionRows = groupBy(table('pokemon_evolution.csv').filter(row => row.is_default === '1'), row => Number(speciesById.get(Number(row.evolved_species_id))?.evolves_from_species_id));
const evolutionConditionFields = [
  'gender_id', 'location_id', 'held_item_id', 'time_of_day', 'known_move_id', 'known_move_type_id',
  'minimum_happiness', 'minimum_beauty', 'minimum_affection', 'relative_physical_stats', 'party_species_id',
  'party_type_id', 'trade_species_id', 'needs_overworld_rain', 'turn_upside_down', 'needs_multiplayer',
  'near_special_rock', 'region_id', 'used_move_id', 'minimum_move_count',
  'minimum_steps', 'minimum_damage_taken',
] as const;
const meaningfulEvolutionConditions = (row: Row) => evolutionConditionFields
  .filter(key => row[key] !== '' && row[key] !== '0')
  .map(key => `${key}=${row[key]}`);
let specialEvolutionConditions = 0;
const species = speciesRows.map(speciesRow => {
  const id = Number(speciesRow.id), pokemon = defaultBySpecies.get(id);
  if (!pokemon) throw new Error(`No default Pokemon for species ${id}`);
  const pokemonId = Number(pokemon.id);
  const values = Object.fromEntries((statRows.get(pokemonId) ?? []).map(row => [stats.get(Number(row.stat_id))?.identifier, Number(row.base_stat)]));
  const learned = (selectedLearnByPokemon.get(pokemonId) ?? []).map(row => ({ level: Number(row.level), moveId: Number(row.move_id), order: num(row.order) }))
    .sort((a, b) => a.level - b.level || a.order - b.order || a.moveId - b.moveId)
    .filter((entry, index, all) => !all.slice(0, index).some(other => other.level === entry.level && other.moveId === entry.moveId))
    .map(({ level, moveId }) => ({ level, moveId }));
  const machineMoves = [...new Set((machineMovesBySpecies.get(id) ?? []).map(row => Number(row.move_id)))].sort((a, b) => a - b);
  const seen = new Set<number>();
  const evolutions = (evolutionRows.get(id) ?? []).sort((a, b) => num(a.version_group_id) - num(b.version_group_id))
    .filter(row => { const target = Number(row.evolved_species_id); if (seen.has(target)) return false; seen.add(target); return true; })
    .flatMap(row => {
      const trigger = Number(row.evolution_trigger_id), target = Number(row.evolved_species_id);
      const extra = meaningfulEvolutionConditions(row);
      if (trigger === 1 && row.minimum_level && extra.length === 0) return [{ target, method: 'level', level: Number(row.minimum_level) }];
      if (trigger === 2 && extra.length === 0) return [{ target, method: 'trade' }];
      if (trigger === 3 && extra.length === 0) return [{ target, method: 'stone', item: items.get(Number(row.trigger_item_id))?.identifier ?? `item-${row.trigger_item_id}` }];
      specialEvolutionConditions++;
      const conditions = [...(row.minimum_level ? [`minimum_level=${row.minimum_level}`] : []), ...extra];
      return [{ target, method: 'special', requirement: `PokéAPI trigger ${trigger}${conditions.length ? `: ${conditions.join(', ')}` : ''}` }];
    });
  const habitatId = num(speciesRow.habitat_id);
  return {
    id, name: speciesKo.get(id) ?? speciesEn.get(id) ?? speciesRow.identifier, englishName: speciesEn.get(id) ?? speciesRow.identifier,
    types: (typeRows.get(pokemonId) ?? []).sort((a, b) => Number(a.slot) - Number(b.slot)).map(row => types.get(Number(row.type_id))?.identifier),
    baseStats: { hp: values.hp, attack: values.attack, defense: values.defense, specialAttack: values['special-attack'], specialDefense: values['special-defense'], speed: values.speed },
    catchRate: Number(speciesRow.capture_rate), baseExperience: num(pokemon.base_experience), heightMeters: Number(pokemon.height) / 10,
    growthRate: growth.get(Number(speciesRow.growth_rate_id))?.identifier, frontSprite: `/pokemon/${pokemonId}.png`, backSprite: `/pokemon/back/${pokemonId}.png`,
    evolutions, moves: learned, machineMoves, habitat: habitatKo.get(habitatId) ?? habitats.get(habitatId)?.identifier ?? 'unknown',
  };
});

const pokemonOutput = `// Generated by scripts/fetch-pokemon.ts. Do not edit by hand.
import type { PokemonMove, PokemonSpecies, PokemonType } from '../game/contracts.ts';

import { pokemonSpriteUrl } from '../game/assets';

export const TYPE_EFFECTIVENESS: Record<PokemonType, Record<PokemonType, number>> = ${ts(typeEffectiveness)};

export const MOVES: Record<number, PokemonMove> = ${ts(moves)};

export const POKEMON: PokemonSpecies[] = ${ts(species)};

for (const species of POKEMON) { species.frontSprite = pokemonSpriteUrl(species.id); species.backSprite = pokemonSpriteUrl(species.id, true); }

export function getSpecies(id: number): PokemonSpecies {
  const species = POKEMON[id - 1];
  if (!species || species.id !== id) throw new RangeError(\`Unknown Pokemon species id: \${id}\`);
  return species;
}

export function getMove(id: number): PokemonMove {
  const move = MOVES[id];
  if (!move) throw new RangeError(\`Unknown Pokemon move id: \${id}\`);
  return move;
}

export function getTypeEffectiveness(attack: PokemonType, defense: PokemonType | readonly PokemonType[]): number {
  const defendingTypes = (Array.isArray(defense) ? defense : [defense]) as readonly PokemonType[];
  return defendingTypes.reduce((factor, defendingType) => factor * TYPE_EFFECTIVENESS[attack][defendingType], 1);
}
`;
await writeFile(OUTPUTS.pokemon, pokemonOutput);

const formNames = groupBy(table('pokemon_form_names.csv'), row => Number(row.pokemon_form_id));
const forms = table('pokemon_forms.csv').map(row => {
  const pokemon = pokemonById.get(Number(row.pokemon_id))!;
  const names = formNames.get(Number(row.id)) ?? [], koName = names.find(name => Number(name.local_language_id) === ko), enName = names.find(name => Number(name.local_language_id) === en);
  const baseName = speciesKo.get(Number(pokemon.species_id)) ?? speciesEn.get(Number(pokemon.species_id)) ?? row.identifier;
  const localizedFormName = koName?.form_name || enName?.form_name || row.form_identifier || '';
  const koreanForm = pokemonFormKoreanName(baseName, row.identifier);
  const spriteKey = spriteKeyByIdentifier.get(row.identifier) ?? row.pokemon_id;
  return {
    formId: Number(row.id), pokemonId: Number(row.pokemon_id), speciesId: Number(pokemon.species_id), identifier: row.identifier,
    name: koreanForm?.name || koName?.pokemon_name || enName?.pokemon_name || (localizedFormName ? `${baseName} (${localizedFormName})` : baseName),
    formName: koreanForm?.formName || localizedFormName, introducedInVersionGroupId: Number(row.introduced_in_version_group_id),
    isDefault: row.is_default === '1', isBattleOnly: row.is_battle_only === '1', isMega: row.is_mega === '1',
    order: Number(row.order), formOrder: Number(row.form_order), spriteKey, frontSprite: `/pokemon/${spriteKey}.png`, backSprite: `/pokemon/back/${spriteKey}.png`,
  };
});
// The sprites form map names cosmetic files such as 25_1. Pokemon varieties such as
// regional forms also have numeric Pokemon-ID files, so cache both and fall back to the latter.
const spriteKeys = [...new Set(forms.flatMap(form => [String(form.spriteKey), String(form.pokemonId)]))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const spriteFiles = (await pool(spriteKeys.flatMap(key => [false, true].map(back => async () => {
  const path = back ? `back/${key}.png` : `${key}.png`, url = `${spriteBase}/${path}`;
  const bytes = await download(url, new URL(path, SPRITE_DIR), previousSprites?.files?.find(entry => entry.path === path)?.sha256, true);
  return bytes ? { path, url, sha256: sha256(bytes), bytes: bytes.length } : undefined;
})))).filter((entry): entry is { path: string; url: string; sha256: string; bytes: number } => Boolean(entry));
const available = new Set(spriteFiles.map(file => file.path));
for (const form of forms) {
  const pokemonKey = String(form.pokemonId);
  form.frontSprite = available.has(`${form.spriteKey}.png`) ? `/pokemon/${form.spriteKey}.png`
    : available.has(`${pokemonKey}.png`) ? `/pokemon/${pokemonKey}.png` : null as never;
  form.backSprite = available.has(`back/${form.spriteKey}.png`) ? `/pokemon/back/${form.spriteKey}.png`
    : available.has(`back/${pokemonKey}.png`) ? `/pokemon/back/${pokemonKey}.png` : null as never;
}

const pokedexRows = table('pokedexes.csv'), pokedexById = byId(pokedexRows);
const dexNumbers = groupBy(table('pokemon_dex_numbers.csv'), row => Number(row.pokedex_id));
const groupDexes = groupBy(table('pokedex_version_groups.csv'), row => Number(row.version_group_id));
const dexKo = localized(table('pokedex_prose.csv'), 'pokedex_id', ko), dexEn = localized(table('pokedex_prose.csv'), 'pokedex_id', en);
const dexes = pokedexRows.map(row => ({
  id: row.identifier, numericId: Number(row.id), name: dexKo.get(Number(row.id)) ?? dexEn.get(Number(row.id)) ?? row.identifier,
  regionId: row.region_id ? Number(row.region_id) : null, isMainSeries: row.is_main_series === '1',
  entries: (dexNumbers.get(Number(row.id)) ?? []).map(entry => ({ number: Number(entry.pokedex_number), speciesId: Number(entry.species_id) })).sort((a, b) => a.number - b.number),
}));
const groups = table('version_groups.csv').map(row => {
  const dexIds = (groupDexes.get(Number(row.id)) ?? []).map(link => Number(link.pokedex_id));
  const speciesIds = [...new Set(dexIds.flatMap(id => (dexNumbers.get(id) ?? []).map(entry => Number(entry.species_id))))].sort((a, b) => a - b);
  return { id: row.identifier, numericId: Number(row.id), generation: Number(row.generation_id), order: Number(row.order), pokedexIds: dexIds.map(id => pokedexById.get(id)?.identifier).filter(Boolean), speciesIds, basis: speciesIds.length ? 'regional-pokedex' : 'no-pokedex-data', source: 'pokeapi-csv' };
});
const groupByNumeric = new Map(groups.map(group => [group.numericId, group]));
const versionKo = localized(table('version_names.csv'), 'version_id', ko), versionEn = localized(table('version_names.csv'), 'version_id', en);
const versions = table('versions.csv').map(row => {
  const group = groupByNumeric.get(Number(row.version_group_id))!;
  return { id: row.identifier, numericId: Number(row.id), name: versionKo.get(Number(row.id)) ?? versionEn.get(Number(row.id)) ?? row.identifier, versionGroupId: group.id, generation: group.generation, pokedexIds: group.pokedexIds, speciesIds: group.speciesIds, basis: group.basis, source: 'pokeapi-csv' };
});
const versionsOutput = `// Generated by scripts/fetch-pokemon.ts. Do not edit by hand.
import type { PokemonSpecies } from '../game/contracts.ts';
import { POKEMON, getSpecies } from './pokemon.ts';

export type PokemonDataBasis = 'regional-pokedex' | 'no-pokedex-data';
export type PokemonVersion = { id: string; numericId: number; name: string; versionGroupId: string; generation: number; pokedexIds: string[]; speciesIds: number[]; basis: PokemonDataBasis; source: 'pokeapi-csv' };
export type PokemonForm = { formId: number; pokemonId: number; speciesId: number; identifier: string; name: string; formName: string; introducedInVersionGroupId: number; isDefault: boolean; isBattleOnly: boolean; isMega: boolean; order: number; formOrder: number; spriteKey: string; frontSprite: string | null; backSprite: string | null };
export type PokemonPokedex = { id: string; numericId: number; name: string; regionId: number | null; isMainSeries: boolean; entries: { number: number; speciesId: number }[] };

export const POKEDEXES: PokemonPokedex[] = ${ts(dexes)};
export const VERSION_GROUPS = ${ts(groups)} as const;
export const POKEMON_VERSIONS: PokemonVersion[] = ${ts(versions)};
export const VERSIONS = POKEMON_VERSIONS;
export const POKEMON_FORMS: PokemonForm[] = JSON.parse(${JSON.stringify(JSON.stringify(forms))});
export const NATIONAL_POKEDEX_SPECIES_IDS: readonly number[] = POKEMON.map(species => species.id);

export function getPokemonVersion(id: string | number): PokemonVersion {
  const version = POKEMON_VERSIONS.find(entry => entry.id === id || entry.numericId === id);
  if (!version) throw new RangeError(\`Unknown Pokemon version: \${id}\`);
  return version;
}
export function getVersionSpeciesIds(id: string | number): readonly number[] { return id === 'national' ? NATIONAL_POKEDEX_SPECIES_IDS : getPokemonVersion(id).speciesIds; }
export function getVersionSpecies(id: string | number): PokemonSpecies[] { return getVersionSpeciesIds(id).map(getSpecies); }
export function getPokedexEntries(id: string | number) {
  const dex = POKEDEXES.find(entry => entry.id === id || entry.numericId === id);
  if (!dex) throw new RangeError(\`Unknown Pokedex: \${id}\`);
  return dex.entries;
}
export function getPokemonForms(speciesId: number): PokemonForm[] { getSpecies(speciesId); return POKEMON_FORMS.filter(form => form.speciesId === speciesId); }
`;
await writeFile(OUTPUTS.versions, versionsOutput);

const experience = Object.fromEntries([...growth].map(([growthId, row]) => [
  row.identifier, table('experience.csv').filter(entry => Number(entry.growth_rate_id) === growthId).sort((a, b) => Number(a.level) - Number(b.level)).map(entry => Number(entry.experience)),
]));
const experienceOutput = `// Generated by scripts/fetch-pokemon.ts. Do not edit by hand.
export const EXPERIENCE_BY_GROWTH_RATE: Record<string, readonly number[]> = ${ts(experience)};
export function getExperienceForLevel(growthRate: string, level: number): number {
  if (!Number.isInteger(level) || level < 1 || level > 100) throw new RangeError(\`Invalid Pokemon level: \${level}\`);
  const values = EXPERIENCE_BY_GROWTH_RATE[growthRate];
  if (!values) throw new RangeError(\`Unknown growth rate: \${growthRate}\`);
  return values[level - 1];
}
`;
await writeFile(OUTPUTS.experience, experienceOutput);

const validation = {
  species: species.map(entry => ({ id: entry.id, growthRate: entry.growthRate, experience: experience[String(entry.growthRate)], baseStats: entry.baseStats, moves: entry.moves, machineMoves: entry.machineMoves, evolutions: entry.evolutions.map(evolution => ({ target: evolution.target })) })),
  moves: moveIds.map(id => ({ id, pp: moves[id].pp })),
  versions: [
    { id: 'national', speciesIds: species.map(entry => entry.id) },
    ...versions.map(version => ({ id: version.id, speciesIds: version.speciesIds })),
  ],
};
await writeFile(OUTPUTS.validation, JSON.stringify(validation));
const rankedCatalog = {
  source: { dataset: 'PokeAPI data', commit: dataCommit, derivedFrom: ['src/data/pokemon.ts', 'src/data/.cache/pokeapi/pokemon_species.csv'] },
  species: species.map((entry, index) => ({
    id: entry.id, name: entry.name, types: entry.types, baseStats: entry.baseStats,
    restricted: speciesRows[index].is_legendary === '1' || speciesRows[index].is_mythical === '1',
  })),
  moves: moveIds.map(id => moves[id]),
  typeEffectiveness,
};
await writeFile(OUTPUTS.ranked, JSON.stringify(rankedCatalog));
await download(`https://raw.githubusercontent.com/PokeAPI/pokeapi/${dataCommit}/LICENSE.md`, new URL('public/data/POKEAPI-LICENSE.txt', ROOT));
await download(`https://raw.githubusercontent.com/PokeAPI/sprites/${spritesCommit}/LICENCE.txt`, new URL('public/data/POKEAPI-SPRITES-LICENCE.txt', ROOT), undefined, true);

await writeFile(SPRITE_MANIFEST, JSON.stringify({
  generatedAt: new Date().toISOString(), repository: 'https://github.com/PokeAPI/sprites', resolvedCommit: spritesCommit,
  license: 'https://github.com/PokeAPI/sprites/blob/master/LICENCE.txt', requestedKeys: spriteKeys.length,
  coverage: { requestedFiles: spriteKeys.length * 2, downloadedFiles: spriteFiles.length, missingFiles: spriteKeys.length * 2 - spriteFiles.length },
  files: spriteFiles.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true })),
}, null, 2) + '\n');
await writeFile(SOURCE_MANIFEST, JSON.stringify({
  generatedAt: new Date().toISOString(), repository: 'https://github.com/PokeAPI/pokeapi', resolvedCommit: dataCommit,
  license: 'https://github.com/PokeAPI/pokeapi/blob/master/LICENSE.md',
  csvFiles: csvBuffers.map(({ file, bytes }) => ({ file, url: `${csvBase}/${file}`, sha256: sha256(bytes), bytes: bytes.length })),
  sourceFiles: [{ file: 'sprite-forms.json', url: formsUrl, sha256: sha256(formsBytes), bytes: formsBytes.length }],
  selection: {
    species: `All ${species.length} National Pokedex species at the pinned commit; one default Pokemon variety per species`,
    forms: `All ${forms.length} pokemon_forms rows; sprite paths use pinned sprites forms.json where present`,
    versionSpeciesBasis: 'Union of pokemon_dex_numbers for Pokedexes linked to each version group; catalog membership, not encounter availability',
    learnsets: 'Newest version group by source order with level-up rows for each default Pokemon variety',
    machineMoves: `Runtime-supported machine move compatibility (${[...runtimeMachineMoveIds].join(', ')}) from all matching Pokemon varieties`,
    evolutions: 'Simple level, item, and trade rows preserve their method; compound and other trigger rows are preserved as unsupported special requirements', specialEvolutionConditions,
  },
  output: {
    species: species.length, forms: forms.length, versions: versions.length, versionGroups: groups.length, moves: moveIds.length,
    pokemonSha256: sha256(pokemonOutput), versionsSha256: sha256(versionsOutput), experienceSha256: sha256(experienceOutput),
    validationSha256: sha256(await readFile(OUTPUTS.validation)),
    rankedSha256: sha256(await readFile(OUTPUTS.ranked)),
  },
}, null, 2) + '\n');
console.log(`Generated ${species.length} species, ${forms.length} forms, ${versions.length} versions, ${moveIds.length} moves, and ${spriteFiles.length}/${spriteKeys.length * 2} sprites.`);
