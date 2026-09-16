import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';

type Row = Record<string, string>;
type Manifest = { resolvedCommit: string; csvFiles: Array<{ file: string; sha256: string }> };
const root = resolve(import.meta.dirname, '..'), cache = resolve(root, 'src/data/.cache/pokeapi');
const revision = '8fe210b21c9abbe73de93670f3d5a346c80a3625';
const read = (path: string) => readFileSync(path);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(read(resolve(root, 'src/data/source-manifest.json')).toString()) as Manifest;
if (manifest.resolvedCommit !== revision) throw new Error(`Expected pinned PokeAPI ${revision}, received ${manifest.resolvedCommit}`);
const csv = (name: string) => {
  const path = resolve(cache, name), bytes = read(path), expected = manifest.csvFiles.find(file => file.file === name)?.sha256;
  if (!expected || sha256(bytes) !== expected) throw new Error(`Pinned checksum mismatch: ${name}`);
  return { data: parse(bytes, { columns: true, skip_empty_lines: true }) as Row[], sha256: expected };
};
const pinnedFile = async (name: string, path: string, expected: string) => {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const url = `https://raw.githubusercontent.com/PokeAPI/pokeapi/${revision}/data/v2/csv/${name}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download pinned ${name}: HTTP ${response.status}`);
    const downloaded = new Uint8Array(await response.arrayBuffer());
    if (sha256(downloaded) !== expected) throw new Error(`Downloaded checksum mismatch: ${name}`);
    const partial = `${path}.part`;
    writeFileSync(partial, downloaded); renameSync(partial, path);
  }
  const bytes = read(path);
  if (sha256(bytes) !== expected) throw new Error(`Pinned checksum mismatch: ${name}`);
  return bytes;
};

const evolution = csv('pokemon_evolution.csv'), species = csv('pokemon_species.csv'), pokemon = csv('pokemon.csv');
const items = csv('items.csv'), types = csv('types.csv'), moves = csv('moves.csv'), moveNames = csv('move_names.csv'), speciesNames = csv('pokemon_species_names.csv');
const supplemental = {
  'locations.csv': '2af5d6a1151d5ae402f9da1d5513bc1c7437795e69b140787c7aab3f6ed7eaa3',
  'regions.csv': 'dbd1ecc3f014b67c1a9452611fca5d13542ebc3524f3a4188b5a6cb1ca911d79',
} as const;
const supplementalRows = async (name: keyof typeof supplemental) => parse(await pinnedFile(name, resolve(cache, name), supplemental[name]), { columns: true, skip_empty_lines: true }) as Row[];
const locations = await supplementalRows('locations.csv'), regions = await supplementalRows('regions.csv');
const itemNameDir = resolve(root, 'data/local/evolution-shop-source', revision);
const itemNamePath = resolve(itemNameDir, 'item_names.csv');
const itemNameSha256 = '7b1b4fe6edf7946110050a5dddabf62c3a1dc3e1616099c4ae97abcb5ebd0f97';
const itemNameBytes = await pinnedFile('item_names.csv', itemNamePath, itemNameSha256);
const itemNames = parse(itemNameBytes, { columns: true, skip_empty_lines: true }) as Row[];
if (evolution.data.length !== 553) throw new Error(`Expected 553 pinned evolution rows, received ${evolution.data.length}`);

const metadata = new Set(['id', 'evolved_species_id', 'evolution_trigger_id', 'version_group_id', 'is_default']);
const booleanFields = new Set(['needs_overworld_rain', 'turn_upside_down', 'needs_multiplayer', 'near_special_rock']);
const conditionFields = Object.keys(evolution.data[0]).filter(field => !metadata.has(field));
const speciesById = new Map(species.data.map(row => [Number(row.id), row]));
const sourceRules = evolution.data.map(row => {
  const to = Number(row.evolved_species_id), from = Number(speciesById.get(to)?.evolves_from_species_id ?? 0);
  if (from < 1 || from > 1025 || to < 1 || to > 1025) throw new Error(`Evolution row ${row.id} is outside species 1..1025`);
  const conditions = Object.fromEntries(conditionFields
    .filter(field => row[field] !== '' && (!booleanFields.has(field) || row[field] === '1'))
    .map(field => [field, row[field]]));
  return { id: Number(row.id), from, to, trigger: Number(row.evolution_trigger_id), versionGroup: Number(row.version_group_id), isDefault: row.is_default === '1', conditions };
});

const defaultPokemon = new Map(pokemon.data.filter(row => row.is_default === '1').map(row => [Number(row.species_id), Number(row.id)]));
const speciesTraits = Object.fromEntries(species.data.filter(row => Number(row.id) <= 1025).map(row => {
  const id = Number(row.id), defaultFormId = defaultPokemon.get(id); if (!defaultFormId) throw new Error(`Missing default form for species ${id}`);
  return [id, { genderRate: Number(row.gender_rate), baseHappiness: Number(row.base_happiness), defaultFormId }];
}));

const itemById = new Map(items.data.map(row => [Number(row.id), row.identifier]));
const koreanItemNames = new Map(itemNames.filter(row => row.local_language_id === '3').map(row => [Number(row.item_id), row.name]));
const referencedItemIds = [...new Set(sourceRules.flatMap(rule => ['trigger_item_id','held_item_id'].map(field => Number(rule.conditions[field] || 0))).filter(Boolean))].sort((a, b) => a - b);
const sourceItems = Object.fromEntries(referencedItemIds.map(id => {
  const identifier = itemById.get(id); if (!identifier) throw new Error(`Unknown source item ${id}`);
  return [id, { id: identifier, name: koreanItemNames.get(id) ?? identifier }];
}));

const localized = (values: Row[], names: Row[], nameKey: string) => Object.fromEntries(values.map(value => {
  const id = Number(value.id), ko = names.find(name => Number(name[nameKey]) === id && name.local_language_id === '3')?.name;
  return [String(id), ko ?? value.identifier];
}));
const itemLabels = Object.fromEntries(referencedItemIds.map(id => [String(id), sourceItems[id].name]));
const referencedLabels = (fields: string[], labels: Record<string, string>) => Object.fromEntries([...new Set(sourceRules.flatMap(rule => fields.map(field => rule.conditions[field]).filter(Boolean)))]
  .sort((a, b) => Number(a) - Number(b)).map(value => [value, labels[value] ?? value]));
const typeLabels = referencedLabels(['known_move_type_id','party_type_id'], Object.fromEntries(types.data.map(value => [value.id, value.identifier])));
const moveLabels = referencedLabels(['known_move_id','used_move_id'], localized(moves.data, moveNames.data, 'move_id'));
const speciesLabels = referencedLabels(['party_species_id','trade_species_id'], localized(species.data, speciesNames.data, 'pokemon_species_id'));
const locationLabels = referencedLabels(['location_id'], Object.fromEntries(locations.map(value => [value.id, value.identifier])));
const regionLabels = referencedLabels(['region_id'], Object.fromEntries(regions.map(value => [value.id, value.identifier])));
const formLabels = referencedLabels(['base_form_id','evolved_form_id'], Object.fromEntries(pokemon.data.map(value => [value.id, value.identifier])));
const conditionNames: Record<string, Record<string, string>> = {
  trigger_item_id: itemLabels, held_item_id: itemLabels,
  known_move_id: moveLabels, used_move_id: moveLabels,
  known_move_type_id: typeLabels, party_type_id: typeLabels,
  party_species_id: speciesLabels, trade_species_id: speciesLabels,
  location_id: locationLabels, region_id: regionLabels,
  base_form_id: formLabels, evolved_form_id: formLabels,
  gender_id: { '1': 'female', '2': 'male', '3': 'genderless' },
  time_of_day: { day: '낮', night: '밤', dusk: '해질녘', 'full-moon': '보름달' },
  relative_physical_stats: { '-1': '공격 < 방어', '0': '공격 = 방어', '1': '공격 > 방어' },
  needs_overworld_rain: { '1': '비가 오는 필드' }, turn_upside_down: { '1': '기기를 거꾸로 듦' },
  needs_multiplayer: { '1': '멀티플레이 중' }, near_special_rock: { '1': '특수 바위 근처' },
};

const js = (value: unknown) => JSON.stringify(value, null, 2);
const output = `// Generated by scripts/generate-evolution-rules.ts. Do not edit by hand.
// Source: https://github.com/PokeAPI/pokeapi/tree/${revision}/data/v2/csv
// pokemon_evolution.csv: ${evolution.sha256}; rows: ${sourceRules.length}; species: 1..1025
// item_names.csv: ${itemNameSha256}

export const EVOLUTION_CONDITION_FIELDS = ${js(conditionFields)} as const;
export type EvolutionConditionField = typeof EVOLUTION_CONDITION_FIELDS[number];
export type EvolutionSourceRule = { id: number; from: number; to: number; trigger: number; versionGroup: number; isDefault: boolean; conditions: Record<string, string> };

export const EVOLUTION_SOURCE_RULES: EvolutionSourceRule[] = ${js(sourceRules)};

export const EVOLUTION_SPECIES_TRAITS: Record<number, { genderRate: number; baseHappiness: number; defaultFormId: number }> = ${js(speciesTraits)};

export const EVOLUTION_SOURCE_ITEMS: Record<number, { id: string; name: string }> = ${js(sourceItems)};

export const EVOLUTION_CONDITION_NAMES: Record<string, Record<string, string>> = ${js(conditionNames)};
`;
writeFileSync(resolve(root, 'src/data/evolution-rules.ts'), output);
console.log(`Generated ${sourceRules.length} evolution source rules, ${Object.keys(speciesTraits).length} species traits, and ${referencedItemIds.length} referenced items.`);
