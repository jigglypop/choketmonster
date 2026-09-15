import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';

type Row = Record<string, string>;
type Period = 'morning' | 'day' | 'night';
type Pool = { locationId: string; areaId: number; areaName: string; method: string; period: Period; slots: Array<{ speciesId: number; sourcePokemonId: number; minLevel: number; maxLevel: number; weight: number }> };
const sourceRoot = join('data', 'local', 'johto-gold-source');
const revision = readdirSync(sourceRoot, { withFileTypes: true }).find(entry => entry.isDirectory())?.name;
if (!revision) throw new Error('Pinned PokeAPI CSV cache is missing');
const sourceDir = join(sourceRoot, revision);
const expansionSourceDir = join('data','local','region-expansion-source',revision);
const rows = (name: string): Row[] => parse(readFileSync(join(sourceDir, name)), { columns: true, skip_empty_lines: true });
const versions = new Map(rows('versions.csv').map(row => [row.identifier, { id: Number(row.id), group: Number(row.version_group_id) }]));
const slots = new Map(rows('encounter_slots.csv').map(row => [Number(row.id), { group: Number(row.version_group_id), method: Number(row.encounter_method_id), weight: Number(row.rarity) }]));
const areas = new Map(rows('location_areas.csv').map(row => [Number(row.id), { location: Number(row.location_id), name: row.identifier }]));
const locations = new Map(rows('locations.csv').map(row => [Number(row.id), { region: Number(row.region_id), name: row.identifier }]));
const methods = new Map(rows('encounter_methods.csv').map(row => [Number(row.id), row.identifier]));
const values = new Map(rows('encounter_condition_values.csv').map(row => [Number(row.id), { condition: Number(row.encounter_condition_id), name: row.identifier, default: row.is_default === '1' }]));
const conditionMap = new Map<number, number[]>();
for (const row of rows('encounter_condition_value_map.csv')) {
  const encounter = Number(row.encounter_id), value = Number(row.encounter_condition_value_id);
  conditionMap.set(encounter, [...(conditionMap.get(encounter) ?? []), value]);
}
const encounters = rows('encounters.csv');
const pokemonSpecies = new Map((parse(readFileSync(join(expansionSourceDir,'pokemon.csv')), { columns: true, skip_empty_lines: true }) as Row[]).map(row=>[Number(row.id),Number(row.species_id)]));
const specs = [
  { region: 'hoenn', regionId: 3, candidates: ['ruby', 'sapphire', 'emerald'], dexLimit: 386 },
  { region: 'sinnoh', regionId: 4, candidates: ['diamond', 'pearl', 'platinum'], dexLimit: 493 },
  { region: 'unova', regionId: 5, candidates: ['black', 'white'], dexLimit: 649 },
] as const;

function build(regionId: number, versionName: string, dexLimit: number): Pool[] {
  const version = versions.get(versionName); if (!version) throw new Error(`Unknown version ${versionName}`);
  const grouped = new Map<string, Pool>();
  for (const row of encounters) {
    if (Number(row.version_id) !== version.id) continue;
    const areaId = Number(row.location_area_id), area = areas.get(areaId), location = area && locations.get(area.location), slot = slots.get(Number(row.encounter_slot_id));
    if (!area || !location || location.region !== regionId || !slot || slot.group !== version.group) continue;
    const conditions = (conditionMap.get(Number(row.id)) ?? []).map(id => values.get(id)!).filter(Boolean);
    if (conditions.some(value => value.condition !== 2 && !value.default && !(value.condition === 6 && value.name === 'season-spring'))) continue;
    const explicit = conditions.find(value => value.condition === 2)?.name;
    const periods: Period[] = explicit === 'time-morning' ? ['morning'] : explicit === 'time-day' ? ['day'] : explicit === 'time-night' ? ['night'] : ['morning', 'day', 'night'];
    for (const period of periods) {
      const method = methods.get(slot.method) ?? `method-${slot.method}`; if(method!=='walk'&&method!=='surf')continue;
      const key = `${location.name}|${areaId}|${method}|${period}`;
      const pool = grouped.get(key) ?? { locationId: location.name, areaId, areaName: area.name, method, period, slots: [] };
      const sourcePokemonId=Number(row.pokemon_id),speciesId=pokemonSpecies.get(sourcePokemonId);if(!speciesId)throw new Error(`pokemon ${sourcePokemonId}: species mapping missing`);
      pool.slots.push({ speciesId, sourcePokemonId, minLevel: Number(row.min_level), maxLevel: Number(row.max_level), weight: slot.weight });
      grouped.set(key, pool);
    }
  }
  return [...grouped.values()].filter(pool => pool.slots.some(slot => slot.speciesId <= dexLimit))
    .sort((a, b) => a.locationId.localeCompare(b.locationId) || a.areaId - b.areaId || a.period.localeCompare(b.period));
}

const output: Record<string, Pool[]> = {}, comparison: Record<string, Record<string, { pools: number; species: number }>> = {}, selectedVersions: Record<string, string> = {};
for (const spec of specs) {
  const candidates = spec.candidates.map(version => ({ version, pools: build(spec.regionId, version, spec.dexLimit) }));
  comparison[spec.region] = Object.fromEntries(candidates.map(item => [item.version, { pools: item.pools.length, species: new Set(item.pools.flatMap(pool => pool.slots.map(slot => slot.speciesId).filter(id => id <= spec.dexLimit))).size }]));
  candidates.sort((a, b) => comparison[spec.region][b.version].species - comparison[spec.region][a.version].species || a.version.localeCompare(b.version));
  selectedVersions[spec.region] = candidates[0].version; output[spec.region] = candidates[0].pools;
}
const sourceFiles = ['encounters.csv', 'encounter_slots.csv', 'encounter_condition_values.csv', 'encounter_condition_value_map.csv', 'location_areas.csv', 'locations.csv', 'versions.csv'];
const checksums = Object.fromEntries(sourceFiles.map(name => [name, createHash('sha256').update(readFileSync(join(sourceDir, name))).digest('hex')]));
checksums['pokemon.csv']=createHash('sha256').update(readFileSync(join(expansionSourceDir,'pokemon.csv'))).digest('hex');
const source = { repository: 'https://github.com/PokeAPI/pokeapi', revision, license: 'BSD-3-Clause', selectedVersions, comparison, selectionRule: 'greatest unique species count within walk and surf pools; alphabetical identifier breaks a tie', fixedConditions: { season: 'spring' }, checksums };
const text = `// Generated by scripts/generate-expansion-encounters.ts. Do not edit by hand.\n`
  + `export type ExpansionRegion = 'hoenn' | 'sinnoh' | 'unova';\n`
  + `export type ExpansionEncounterPool = { locationId: string; areaId: number; areaName: string; method: 'walk' | 'surf'; period: 'morning' | 'day' | 'night'; slots: Array<{ speciesId: number; sourcePokemonId: number; minLevel: number; maxLevel: number; weight: number }> };\n`
  + `export const EXPANSION_ENCOUNTER_SOURCE = ${JSON.stringify(source)} as const;\n`
  + `export const EXPANSION_ENCOUNTER_POOLS: Record<ExpansionRegion, ExpansionEncounterPool[]> = ${JSON.stringify(output)};\n`;
writeFileSync(join('src', 'data', 'expansion-encounters.generated.ts'), text);
console.log(JSON.stringify({ selectedVersions, comparison, pools: Object.fromEntries(Object.entries(output).map(([key, pools]) => [key, pools.length])) }, null, 2));
