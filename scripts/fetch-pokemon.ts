import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';

const CACHE_DIR = new URL('../src/data/.cache/pokeapi/', import.meta.url);
const OUTPUT = new URL('../src/data/pokemon.ts', import.meta.url);
const SPRITE_DIR = new URL('../public/pokemon/', import.meta.url);
const SOURCE_MANIFEST = new URL('../src/data/source-manifest.json', import.meta.url);
const SPRITE_MANIFEST = new URL('../public/pokemon/manifest.json', import.meta.url);
const CONCURRENCY = 6;

const CSV_FILES = [
  'growth_rates.csv', 'items.csv', 'languages.csv', 'move_meta.csv',
  'move_meta_ailments.csv', 'move_meta_stat_changes.csv', 'move_names.csv', 'moves.csv', 'pokemon.csv',
  'pokemon_evolution.csv', 'pokemon_habitat_names.csv', 'pokemon_habitats.csv',
  'pokemon_moves.csv', 'pokemon_species.csv', 'pokemon_species_names.csv',
  'pokemon_stats.csv', 'pokemon_types.csv', 'stats.csv', 'type_names.csv',
  'type_efficacy.csv', 'types.csv', 'version_groups.csv',
] as const;

type Row = Record<string, string>;

function sha256(data: Uint8Array | string) {
  return createHash('sha256').update(data).digest('hex');
}

async function exists(path: URL) {
  try { await stat(path); return true; } catch { return false; }
}

async function download(url: string, destination: URL, expectedSha?: string) {
  const cached = await exists(destination) ? await readFile(destination) : undefined;
  if (cached && expectedSha && sha256(cached) !== expectedSha) throw new Error(`Source cache checksum mismatch: ${destination}`);
  if (cached && !process.argv.includes('--verify-upstream')) return cached;
  const response = await fetch(url, { headers: { 'user-agent': 'choketmon-data-builder/1.0' } });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (expectedSha && sha256(bytes) !== expectedSha) throw new Error(`Pinned upstream checksum mismatch: ${url}`);
  if (cached) {
    if (sha256(cached) !== sha256(bytes)) throw new Error(`Cached source differs from pinned revision: ${url}`);
    return cached;
  }
  await writeFile(destination, bytes);
  return Buffer.from(bytes);
}

async function pool<T>(jobs: (() => Promise<T>)[], limit = CONCURRENCY) {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]();
    }
  }));
  return results;
}

function rows(text: Buffer) {
  return parse(text, { columns: true, skip_empty_lines: true }) as Row[];
}

function byId(data: Row[]) {
  return new Map(data.map(row => [Number(row.id), row]));
}

function localized(data: Row[], ownerKey: string, languageId: number) {
  return new Map(data.filter(row => Number(row.local_language_id) === languageId)
    .map(row => [Number(row[ownerKey]), row.name]));
}

function numberOrZero(value: string | undefined) {
  return value ? Number(value) : 0;
}

function ts(value: unknown) {
  return JSON.stringify(value, null, 2);
}

async function githubHead(repo: string) {
  const response = await fetch(`https://api.github.com/repos/PokeAPI/${repo}/commits/master`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'choketmon-data-builder/1.0' },
  });
  if (!response.ok) throw new Error(`Cannot resolve ${repo} revision: ${response.status}`);
  return String((await response.json() as { sha: string }).sha);
}

await mkdir(CACHE_DIR, { recursive: true });
await mkdir(SPRITE_DIR, { recursive: true });
await mkdir(new URL('./back/', SPRITE_DIR), { recursive: true });

type PreviousManifest = { resolvedCommit: string; csvFiles?: { file: string; sha256: string }[]; files?: { path: string; sha256: string }[] };
const previousData: PreviousManifest | undefined = await exists(SOURCE_MANIFEST) ? JSON.parse(await readFile(SOURCE_MANIFEST, 'utf8')) : undefined;
const previousSprites: PreviousManifest | undefined = await exists(SPRITE_MANIFEST) ? JSON.parse(await readFile(SPRITE_MANIFEST, 'utf8')) : undefined;
const dataCommit = previousData?.resolvedCommit ?? await githubHead('pokeapi');
const spritesCommit = previousSprites?.resolvedCommit ?? await githubHead('sprites');
if (![dataCommit, spritesCommit].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error('Valid immutable source commits are required');
const CSV_BASE = `https://raw.githubusercontent.com/PokeAPI/pokeapi/${dataCommit}/data/v2/csv`;
const SPRITE_BASE = `https://raw.githubusercontent.com/PokeAPI/sprites/${spritesCommit}/sprites/pokemon`;

const csvBuffers = await pool(CSV_FILES.map(file => async () => ({
  file,
  bytes: await download(`${CSV_BASE}/${file}`, new URL(file, CACHE_DIR), previousData?.csvFiles?.find(entry => entry.file === file)?.sha256),
})));
const tables = new Map(csvBuffers.map(({ file, bytes }) => [file, rows(bytes)]));
const table = (name: typeof CSV_FILES[number]) => tables.get(name)!;

const languages = table('languages.csv');
const koreanId = Number(languages.find(row => row.iso639 === 'ko')?.id ?? 3);
const englishId = Number(languages.find(row => row.iso639 === 'en')?.id ?? 9);
const speciesById = byId(table('pokemon_species.csv'));
const pokemonById = byId(table('pokemon.csv').filter(row => row.is_default === '1'));
const speciesKo = localized(table('pokemon_species_names.csv'), 'pokemon_species_id', koreanId);
const speciesEn = localized(table('pokemon_species_names.csv'), 'pokemon_species_id', englishId);
const moveKo = localized(table('move_names.csv'), 'move_id', koreanId);
const moveEn = localized(table('move_names.csv'), 'move_id', englishId);
const habitatKo = localized(table('pokemon_habitat_names.csv'), 'pokemon_habitat_id', koreanId);
const habitatById = byId(table('pokemon_habitats.csv'));
const growthById = byId(table('growth_rates.csv'));
const itemById = byId(table('items.csv'));
const moveById = byId(table('moves.csv'));
const moveMetaById = new Map(table('move_meta.csv').map(row => [Number(row.move_id), row]));
const ailmentById = byId(table('move_meta_ailments.csv'));
const statById = byId(table('stats.csv'));
const typeById = byId(table('types.csv'));
const versionGroups = byId(table('version_groups.csv'));
const standardTypes = [...typeById.values()].filter(row => Number(row.id) <= 18);
const typeEffectiveness = Object.fromEntries(standardTypes.map(attack => [attack.identifier,
  Object.fromEntries(standardTypes.map(defense => {
    const efficacy = table('type_efficacy.csv').find(row =>
      Number(row.damage_type_id) === Number(attack.id) && Number(row.target_type_id) === Number(defense.id)
    );
    return [defense.identifier, Number(efficacy?.damage_factor ?? 100) / 100];
  })),
]));

const typeRows = table('pokemon_types.csv').filter(row => Number(row.pokemon_id) <= 151);
const statsRows = table('pokemon_stats.csv').filter(row => Number(row.pokemon_id) <= 151);
const learnRows = table('pokemon_moves.csv').filter(row =>
  Number(row.pokemon_id) <= 151 && Number(row.pokemon_move_method_id) === 1
);

// Prefer the newest conventional main-series learnset available for each species.
const preferredVersionGroups = [25, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 1];
const learnsetVersion = new Map<number, number>();
for (let pokemonId = 1; pokemonId <= 151; pokemonId++) {
  const available = new Set(learnRows.filter(row => Number(row.pokemon_id) === pokemonId).map(row => Number(row.version_group_id)));
  const selected = preferredVersionGroups.find(id => available.has(id));
  if (!selected) throw new Error(`No level-up learnset found for Pokemon ${pokemonId}`);
  learnsetVersion.set(pokemonId, selected);
}

const selectedLearnRows = learnRows.filter(row => learnsetVersion.get(Number(row.pokemon_id)) === Number(row.version_group_id));
const selectedMoveIds = [...new Set(selectedLearnRows.map(row => Number(row.move_id)))].sort((a, b) => a - b);

const moves = Object.fromEntries(selectedMoveIds.map(id => {
  const row = moveById.get(id);
  if (!row) throw new Error(`Missing move ${id}`);
  const meta = moveMetaById.get(id);
  const ailment = meta ? ailmentById.get(Number(meta.meta_ailment_id))?.identifier : undefined;
  const damageClass = ({ 1: 'status', 2: 'physical', 3: 'special' } as const)[Number(row.damage_class_id) as 1 | 2 | 3];
  const chances = [row.effect_chance, meta?.ailment_chance, meta?.flinch_chance, meta?.stat_chance]
    .filter(Boolean).map(Number).filter(value => value > 0);
  return [id, {
    id,
    name: moveKo.get(id) ?? moveEn.get(id) ?? row.identifier,
    englishName: moveEn.get(id) ?? row.identifier,
    type: typeById.get(Number(row.type_id))?.identifier,
    power: numberOrZero(row.power), accuracy: numberOrZero(row.accuracy), pp: numberOrZero(row.pp),
    damageClass, priority: Number(row.priority),
    effectId: Number(row.effect_id), targetId: Number(row.target_id),
    healing: numberOrZero(meta?.healing), drain: numberOrZero(meta?.drain), metaCategory: numberOrZero(meta?.meta_category_id),
    ailmentChance: numberOrZero(meta?.ailment_chance), statChance: numberOrZero(meta?.stat_chance),
    minHits: numberOrZero(meta?.min_hits), maxHits: numberOrZero(meta?.max_hits),
    statChanges: table('move_meta_stat_changes.csv').filter(change => Number(change.move_id) === id).map(change => ({ stat: statById.get(Number(change.stat_id))!.identifier, change: Number(change.change) })),
    ...(ailment && ailment !== 'none' ? { ailment } : {}),
    ...(chances.length ? { effectChance: Math.max(...chances) } : {}),
  }];
}));

const evolutionRows = table('pokemon_evolution.csv');
const species = Array.from({ length: 151 }, (_, index) => {
  const id = index + 1;
  const speciesRow = speciesById.get(id);
  const pokemonRow = pokemonById.get(id);
  if (!speciesRow || !pokemonRow) throw new Error(`Missing Pokemon ${id}`);

  const types = typeRows.filter(row => Number(row.pokemon_id) === id)
    .sort((a, b) => Number(a.slot) - Number(b.slot))
    .map(row => typeById.get(Number(row.type_id))?.identifier);
  const statValues = Object.fromEntries(statsRows.filter(row => Number(row.pokemon_id) === id).map(row => [
    statById.get(Number(row.stat_id))?.identifier, Number(row.base_stat),
  ]));
  const movesForSpecies = selectedLearnRows.filter(row => Number(row.pokemon_id) === id)
    .map(row => ({ level: Number(row.level), moveId: Number(row.move_id), order: Number(row.order || 0) }))
    .sort((a, b) => a.level - b.level || a.order - b.order || a.moveId - b.moveId)
    .filter((entry, i, all) => !all.slice(0, i).some(other => other.level === entry.level && other.moveId === entry.moveId))
    .map(({ level, moveId }) => ({ level, moveId }));

  const evolutionCandidates = evolutionRows.filter(row => {
    const target = Number(row.evolved_species_id);
    return target <= 151 && Number(speciesById.get(target)?.evolves_from_species_id) === id && row.is_default === '1';
  });
  const seenTargets = new Set<number>();
  const evolutions = evolutionCandidates
    .sort((a, b) => Number(a.version_group_id || 0) - Number(b.version_group_id || 0))
    .filter(row => { const target = Number(row.evolved_species_id); if (seenTargets.has(target)) return false; seenTargets.add(target); return true; })
    .map(row => {
      const trigger = Number(row.evolution_trigger_id);
      const target = Number(row.evolved_species_id);
      if (trigger === 1) return { target, method: 'level', ...(row.minimum_level ? { level: Number(row.minimum_level) } : {}) };
      if (trigger === 2) return { target, method: 'trade' };
      if (trigger === 3) return { target, method: 'stone', item: itemById.get(Number(row.trigger_item_id))?.identifier ?? `item-${row.trigger_item_id}` };
      throw new Error(`Unsupported evolution trigger ${trigger} for ${id} -> ${target}`);
    });

  const habitatId = Number(speciesRow.habitat_id || 0);
  return {
    id, name: speciesKo.get(id) ?? speciesEn.get(id) ?? speciesRow.identifier,
    englishName: speciesEn.get(id) ?? speciesRow.identifier,
    types,
    baseStats: {
      hp: statValues.hp, attack: statValues.attack, defense: statValues.defense,
      specialAttack: statValues['special-attack'], specialDefense: statValues['special-defense'], speed: statValues.speed,
    },
    catchRate: Number(speciesRow.capture_rate), baseExperience: Number(pokemonRow.base_experience),
    growthRate: growthById.get(Number(speciesRow.growth_rate_id))?.identifier,
    frontSprite: `/pokemon/${id}.png`, backSprite: `/pokemon/back/${id}.png`,
    evolutions, moves: movesForSpecies,
    habitat: habitatKo.get(habitatId) ?? habitatById.get(habitatId)?.identifier ?? 'unknown',
  };
});

const output = `// Generated by scripts/fetch-pokemon.ts. Do not edit by hand.\n` +
  `import type { PokemonMove, PokemonSpecies, PokemonType } from '../game/contracts.ts';\n\n` +
  `import { pokemonSpriteUrl } from '../game/assets';\n\n` +
  `export const TYPE_EFFECTIVENESS: Record<PokemonType, Record<PokemonType, number>> = ${ts(typeEffectiveness)};\n\n` +
  `export const MOVES: Record<number, PokemonMove> = ${ts(moves)};\n\n` +
  `export const POKEMON: PokemonSpecies[] = ${ts(species)};\n\n` +
  `for (const species of POKEMON) { species.frontSprite = pokemonSpriteUrl(species.id); species.backSprite = pokemonSpriteUrl(species.id, true); }\n\n` +
  `export function getSpecies(id: number): PokemonSpecies {\n  const species = POKEMON[id - 1];\n  if (!species || species.id !== id) throw new RangeError(\`Unknown Pokemon species id: \${id}\`);\n  return species;\n}\n\n` +
  `export function getMove(id: number): PokemonMove {\n  const move = MOVES[id];\n  if (!move) throw new RangeError(\`Unknown Pokemon move id: \${id}\`);\n  return move;\n}\n\n` +
  `export function getTypeEffectiveness(attack: PokemonType, defense: PokemonType | readonly PokemonType[]): number {\n  const defendingTypes = (Array.isArray(defense) ? defense : [defense]) as readonly PokemonType[];\n  return defendingTypes.reduce((factor, defendingType) => factor * TYPE_EFFECTIVENESS[attack][defendingType], 1);\n}\n`;
await writeFile(OUTPUT, output, 'utf8');

const spriteJobs: (() => Promise<{ path: string; url: string; sha256: string; bytes: number }>)[] = [];
for (let id = 1; id <= 151; id++) {
  for (const back of [false, true]) {
    const relativePath = back ? `back/${id}.png` : `${id}.png`;
    const url = `${SPRITE_BASE}/${back ? 'back/' : ''}${id}.png`;
    const destination = new URL(relativePath, SPRITE_DIR);
    spriteJobs.push(async () => {
      const bytes = await download(url, destination, previousSprites?.files?.find(entry => entry.path === relativePath)?.sha256);
      return { path: relativePath, url, sha256: sha256(bytes), bytes: bytes.length };
    });
  }
}
const spriteFiles = (await pool(spriteJobs)).sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
await download(`https://raw.githubusercontent.com/PokeAPI/pokeapi/${dataCommit}/LICENSE.md`, new URL('../public/data/POKEAPI-LICENSE.txt', import.meta.url));
await writeFile(SPRITE_MANIFEST, JSON.stringify({
  generatedAt: new Date().toISOString(), repository: 'https://github.com/PokeAPI/sprites', resolvedCommit: spritesCommit,
  license: 'https://github.com/PokeAPI/sprites/blob/master/README.md', files: spriteFiles,
}, null, 2) + '\n');
await writeFile(SOURCE_MANIFEST, JSON.stringify({
  generatedAt: new Date().toISOString(), repository: 'https://github.com/PokeAPI/pokeapi', resolvedCommit: dataCommit,
  license: 'https://github.com/PokeAPI/pokeapi/blob/master/LICENSE.md',
  csvFiles: csvBuffers.map(({ file, bytes }) => ({ file, url: `${CSV_BASE}/${file}`, sha256: sha256(bytes), bytes: bytes.length })),
  selection: { species: 'National Pokedex IDs 1-151, default forms', learnsetVersionGroups: Object.fromEntries([...learnsetVersion].map(([id, group]) => [id, versionGroups.get(group)?.identifier])) },
  output: { species: species.length, moves: selectedMoveIds.length, sha256: sha256(output) },
}, null, 2) + '\n');

console.log(`Generated ${species.length} species, ${selectedMoveIds.length} moves, and ${spriteFiles.length} sprites.`);
