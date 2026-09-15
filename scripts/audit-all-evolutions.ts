import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { POKEMON } from '../src/data/pokemon';

type Row = Record<string, string>;
const root = resolve(import.meta.dirname, '..');
const cache = resolve(root, 'src/data/.cache/pokeapi');
const outputArg = process.argv.indexOf('--out');
const outputPath = resolve(root, outputArg >= 0 ? process.argv[outputArg + 1] : 'artifacts/evolution-completeness/source-audit.json');
const manifest = JSON.parse(readFileSync(resolve(root, 'src/data/source-manifest.json'), 'utf8')) as {
  resolvedCommit: string; license: string; csvFiles: Array<{ file: string; url: string; sha256: string; bytes: number }>;
};
const load = (name: string) => parse(readFileSync(resolve(cache, name)), { columns: true, skip_empty_lines: true }) as Row[];
const digest = (name: string) => createHash('sha256').update(readFileSync(resolve(cache, name))).digest('hex');
const sourceFiles = ['pokemon_evolution.csv', 'pokemon_species.csv', 'pokemon.csv', 'pokemon_forms.csv', 'items.csv'] as const;
for (const file of sourceFiles) {
  const expected = manifest.csvFiles.find(entry => entry.file === file);
  if (!expected || expected.sha256 !== digest(file)) throw new Error(`Pinned source checksum mismatch: ${file}`);
}

const evolutionRows = load('pokemon_evolution.csv');
const speciesRows = load('pokemon_species.csv');
const pokemonRows = load('pokemon.csv');
const formRows = load('pokemon_forms.csv');
const speciesById = new Map(speciesRows.map(row => [Number(row.id), row]));
const pokemonById = new Map(pokemonRows.map(row => [Number(row.id), row]));
const formByPokemonId = new Map(formRows.map(row => [Number(row.pokemon_id), row]));
const triggerNames: Record<number, string> = {
  1: 'level-up', 2: 'trade', 3: 'use-item', 4: 'shed', 5: 'spin', 6: 'tower-of-darkness', 7: 'tower-of-waters',
  8: 'three-critical-hits', 9: 'take-damage', 10: 'other', 11: 'agile-style-move', 12: 'strong-style-move',
  13: 'recoil-damage', 14: 'use-move', 15: 'three-defeated-bisharp', 16: 'gimmighoul-coins',
};
const booleanFields = new Set(['needs_overworld_rain', 'turn_upside_down', 'needs_multiplayer', 'near_special_rock']);
const metadataFields = new Set(['id', 'evolved_species_id', 'evolution_trigger_id', 'version_group_id', 'is_default']);
const conditionFields = Object.keys(evolutionRows[0]).filter(field => !metadataFields.has(field));
const activeConditions = (row: Row) => conditionFields.filter(field => row[field] !== '' && (!booleanFields.has(field) || row[field] === '1'))
  .map(field => ({ field, value: row[field] }));
const sourceFor = (row: Row) => Number(speciesById.get(Number(row.evolved_species_id))?.evolves_from_species_id ?? 0);
const relevantRows = evolutionRows.filter(row => {
  const source = sourceFor(row), target = Number(row.evolved_species_id);
  return source >= 1 && source <= 1025 && target >= 1 && target <= 1025;
});
const edgeKey = (row: Row) => `${sourceFor(row)}>${Number(row.evolved_species_id)}`;
const signature = (row: Row) => JSON.stringify({ trigger: Number(row.evolution_trigger_id), conditions: activeConditions(row) });
const groups = new Map<string, Row[]>();
for (const row of relevantRows) groups.set(edgeKey(row), [...(groups.get(edgeKey(row)) ?? []), row]);

const selectedRows: Row[] = [];
const bySource = new Map<number, Row[]>();
for (const row of relevantRows.filter(row => row.is_default === '1')) {
  const source = sourceFor(row); bySource.set(source, [...(bySource.get(source) ?? []), row]);
}
for (const rows of bySource.values()) {
  const seen = new Set<number>();
  for (const row of rows.sort((a, b) => Number(a.version_group_id || 0) - Number(b.version_group_id || 0))) {
    const target = Number(row.evolved_species_id); if (seen.has(target)) continue; seen.add(target); selectedRows.push(row);
  }
}
const selectedIds = new Set(selectedRows.map(row => Number(row.id)));
const selectedByEdge = new Map(selectedRows.map(row => [edgeKey(row), row]));
const currentEdges = new Set(POKEMON.filter(species => species.id <= 1025).flatMap(species => species.evolutions.map(evolution => `${species.id}>${evolution.target}`)));
const currentByEdge = new Map<string, (typeof POKEMON)[number]['evolutions'][number]>(
  POKEMON.filter(species => species.id <= 1025).flatMap(species => species.evolutions.map(evolution => [`${species.id}>${evolution.target}`, evolution])),
);
const defaultEdges = new Set(relevantRows.filter(row => row.is_default === '1').map(edgeKey));

const resolveForm = (value: string) => {
  if (!value) return undefined;
  const pokemon = pokemonById.get(Number(value)), form = formByPokemonId.get(Number(value));
  return { pokemonId: Number(value), pokemonIdentifier: pokemon?.identifier, speciesId: Number(pokemon?.species_id || 0) || undefined, formIdentifier: form?.identifier };
};
const triggerCounts = (rows: Row[]) => Object.fromEntries(Object.entries(triggerNames).map(([id, name]) => {
  const subset = rows.filter(row => row.evolution_trigger_id === id);
  return [name, { rows: subset.length, edges: new Set(subset.map(edgeKey)).size }];
}).filter(([, value]) => (value as { rows: number }).rows));
const fieldCounts = Object.fromEntries(conditionFields.map(field => [field, {
  allRows: relevantRows.filter(row => activeConditions(row).some(condition => condition.field === field)).length,
  defaultRows: relevantRows.filter(row => row.is_default === '1' && activeConditions(row).some(condition => condition.field === field)).length,
  selectedRows: selectedRows.filter(row => activeConditions(row).some(condition => condition.field === field)).length,
}]));

const edgeAudit = [...groups].sort(([a], [b]) => {
  const [as, at] = a.split('>').map(Number), [bs, bt] = b.split('>').map(Number); return as - bs || at - bt;
}).map(([key, rows]) => {
  const sourceId = sourceFor(rows[0]), targetId = Number(rows[0].evolved_species_id), selected = selectedByEdge.get(key);
  return {
    sourceId, source: speciesById.get(sourceId)?.identifier, targetId, target: speciesById.get(targetId)?.identifier,
    rowCount: rows.length, defaultRowCount: rows.filter(row => row.is_default === '1').length,
    distinctConditionVariants: new Set(rows.map(signature)).size, selectedRowId: selected ? Number(selected.id) : null,
    currentGeneratedEvolution: currentByEdge.get(key) ?? null,
    variants: rows.map(row => ({
      rowId: Number(row.id), isDefault: row.is_default === '1', versionGroupId: Number(row.version_group_id),
      triggerId: Number(row.evolution_trigger_id), trigger: triggerNames[Number(row.evolution_trigger_id)] ?? `unknown-${row.evolution_trigger_id}`,
      conditions: activeConditions(row), baseForm: resolveForm(row.base_form_id), evolvedForm: resolveForm(row.evolved_form_id),
      retainedByCurrentGenerator: selectedIds.has(Number(row.id)),
    })),
  };
});

const droppedDefaultRows = relevantRows.filter(row => row.is_default === '1' && !selectedIds.has(Number(row.id)));
const differentAlternatives = droppedDefaultRows.filter(row => signature(row) !== signature(selectedByEdge.get(edgeKey(row))!));
const relativeStatsZero = selectedRows.filter(row => row.relative_physical_stats === '0');
const formScopedSelected = selectedRows.filter(row => row.base_form_id || row.evolved_form_id);
const selectedSpecialRequirements = POKEMON.slice(0, 1025).flatMap(species => species.evolutions)
  .filter(evolution => evolution.method === 'special').map(evolution => evolution.requirement ?? '').filter(Boolean);
const over649Edges = edgeAudit.filter(edge => edge.sourceId > 649 || edge.targetId > 649);
const over649Variants = over649Edges.flatMap(edge => edge.variants);
const currentMethodCounts = Object.fromEntries(['level','stone','trade','special'].map(method => [method,
  [...currentByEdge.values()].filter(evolution => evolution.method === method).length]));
const conditionsOtherThan = (row: Row, allowed: string[]) => activeConditions(row).filter(condition => !allowed.includes(condition.field));
const exactlyRepresentedLevelRows = selectedRows.filter(row => row.evolution_trigger_id === '1' && row.minimum_level
  && conditionsOtherThan(row, ['minimum_level']).length === 0);
const bareTradeRows = selectedRows.filter(row => row.evolution_trigger_id === '2' && activeConditions(row).length === 0);
const bareItemRows = selectedRows.filter(row => row.evolution_trigger_id === '3' && row.trigger_item_id
  && conditionsOtherThan(row, ['trigger_item_id']).length === 0);
const output = {
  schema: 1,
  scope: 'National Pokedex species 1..1025; every pinned PokeAPI evolution row whose inferred source and target species are in scope',
  grain: { source: 'one pokemon_evolution.csv row per version/form/condition variant', edge: 'source species > evolved species' },
  source: {
    repository: 'https://github.com/PokeAPI/pokeapi', revision: manifest.resolvedCommit, license: manifest.license,
    evolutionTriggerLookup: `https://raw.githubusercontent.com/PokeAPI/pokeapi/${manifest.resolvedCommit}/data/v2/csv/evolution_triggers.csv`,
    files: sourceFiles.map(file => ({ file, sha256: digest(file), bytes: readFileSync(resolve(cache, file)).byteLength })),
  },
  coverage: {
    speciesRowsInScope: speciesRows.filter(row => Number(row.id) <= 1025).length,
    sourceRows: evolutionRows.length, relevantRows: relevantRows.length,
    defaultRows: relevantRows.filter(row => row.is_default === '1').length,
    nonDefaultRows: relevantRows.filter(row => row.is_default !== '1').length,
    logicalEdgesAllVariants: groups.size, logicalEdgesWithDefaultVariant: defaultEdges.size,
    currentGeneratedEdges: currentEdges.size,
    currentEdgesNotBackedByDefaultSource: [...currentEdges].filter(key => !defaultEdges.has(key)),
    defaultSourceEdgesMissingFromCurrent: [...defaultEdges].filter(key => !currentEdges.has(key)),
  },
  triggerCounts: { allRelevantRows: triggerCounts(relevantRows), defaultRows: triggerCounts(relevantRows.filter(row => row.is_default === '1')), selectedRows: triggerCounts(selectedRows) },
  triggerDictionary: triggerNames,
  conditionFieldCounts: fieldCounts,
  currentRepresentation: {
    methodCounts: currentMethodCounts,
    uniqueSpecialRequirements: [...new Set(selectedSpecialRequirements)].sort(),
    semanticallyCompleteLevelRows: exactlyRepresentedLevelRows.length,
    bareTradeRowsUsingLinkCableProxy: bareTradeRows.length,
    bareItemRowsBeforeInventoryVocabularyCheck: bareItemRows.length,
    compoundOrSpecialRowsRequiringMoreThanCurrentPredicate: selectedRows.length - exactlyRepresentedLevelRows.length - bareTradeRows.length - bareItemRows.length,
  },
  post649Summary: {
    sourceRows: over649Variants.length, logicalEdges: over649Edges.length,
    selectedRows: over649Edges.filter(edge => edge.selectedRowId !== null).length,
    selectedSpecialEdges: over649Edges.filter(edge => edge.currentGeneratedEvolution?.method === 'special').length,
    triggerCounts: triggerCounts(relevantRows.filter(row => sourceFor(row) > 649 || Number(row.evolved_species_id) > 649)),
    conditionFieldCounts: Object.fromEntries(conditionFields.map(field => [field, over649Variants.filter(variant => variant.conditions.some(condition => condition.field === field)).length])),
  },
  transformationLoss: {
    nonDefaultRowsDiscardedBeforeGrouping: relevantRows.filter(row => row.is_default !== '1').length,
    edgesAvailableOnlyAsNonDefaultRows: edgeAudit.filter(edge => edge.defaultRowCount === 0).map(edge => `${edge.sourceId}>${edge.targetId}`),
    additionalDefaultRowsDiscardedByFirstTargetRule: droppedDefaultRows.length,
    discardedDefaultRowsWithDifferentConditions: differentAlternatives.map(row => Number(row.id)),
    selectedRowsWithFormScopeOmitted: formScopedSelected.map(row => Number(row.id)),
    relativePhysicalStatsEqualRowsMisreadAsNoCondition: relativeStatsZero.map(row => Number(row.id)),
    versionGroupContextOmittedFromEveryGeneratedEdge: selectedRows.length,
    specialRequirementsStoredOnlyAsOpaqueText: POKEMON.slice(0, 1025).flatMap(species => species.evolutions).filter(evolution => evolution.method === 'special').length,
    runtimeObservation: 'evolutionReady checks only level, or an inventory item/link-cable mapping; it does not evaluate the opaque requirement string.',
  },
  implementationRequirements: [
    { sourceFields: ['minimum_level'], state: ['monster.level'], status: 'present' },
    { sourceFields: ['trigger_item_id'], state: ['canonical source item id', 'inventory use event'], status: 'partial-item-vocabulary' },
    { sourceFields: ['gender_id'], state: ['persistent individual gender'], status: 'missing' },
    { sourceFields: ['location_id','region_id','near_special_rock'], state: ['canonical location/region mapping', 'nearby landmark tag'], status: 'partial-world-location-only' },
    { sourceFields: ['held_item_id'], state: ['persistent held item', 'consume/retain rule'], status: 'missing' },
    { sourceFields: ['time_of_day'], state: ['evolution context time period'], status: 'clock-exists-condition-missing' },
    { sourceFields: ['known_move_id','known_move_type_id'], state: ['known move ids/types'], status: 'data-present-condition-missing' },
    { sourceFields: ['minimum_happiness','minimum_beauty','minimum_affection'], state: ['three persistent per-individual attributes'], status: 'missing' },
    { sourceFields: ['relative_physical_stats'], state: ['derived attack-defense comparison including zero/equal'], status: 'derivable-condition-missing' },
    { sourceFields: ['party_species_id','party_type_id'], state: ['current party species/types'], status: 'derivable-condition-missing' },
    { sourceFields: ['trade_species_id'], state: ['actual trade counterpart species/event'], status: 'link-cable-proxy-only' },
    { sourceFields: ['needs_overworld_rain'], state: ['weather at evolution event'], status: 'missing' },
    { sourceFields: ['turn_upside_down','needs_multiplayer'], state: ['explicit orientation/action context', 'multiplayer evolution context'], status: 'missing' },
    { sourceFields: ['base_form_id','evolved_form_id'], state: ['persistent Pokemon/form identity separate from species id'], status: 'missing' },
    { sourceFields: ['used_move_id','minimum_move_count','minimum_steps','minimum_damage_taken'], state: ['per-individual move-use, steps, and unfainted damage counters'], status: 'missing' },
    { sourceFields: ['evolution_trigger_id'], state: ['shed/spin/tower/critical-hit/style/recoil/use-move/Bisharp-defeat/coin event counters'], status: 'special-triggers-missing' },
    { sourceFields: ['version_group_id','is_default'], state: ['ruleset/version selection and variant precedence'], status: 'missing' },
  ],
  acceptanceMetrics: {
    sourceRowPreservation: '100% of relevant source rows retained with provenance and structured fields',
    edgeCoverage: 'every logical edge has at least one selectable rule; form-scoped-only edges remain form-scoped',
    evaluatorCoverage: 'every trigger and active condition field has an executable predicate or an explicit unavailable result',
    saveCoverage: 'all new per-individual counters and form identity round-trip through local/account saves',
    regressionFixtures: 'at least one positive and one negative fixture per trigger and condition field, plus multi-variant edges',
  },
  edges: edgeAudit,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: outputPath, coverage: output.coverage, transformationLoss: {
  nonDefaultRows: output.transformationLoss.nonDefaultRowsDiscardedBeforeGrouping,
  nonDefaultOnlyEdges: output.transformationLoss.edgesAvailableOnlyAsNonDefaultRows.length,
  droppedDefaultRows: output.transformationLoss.additionalDefaultRowsDiscardedByFirstTargetRule,
  differentAlternatives: output.transformationLoss.discardedDefaultRowsWithDifferentConditions.length,
  formScopedSelected: output.transformationLoss.selectedRowsWithFormScopeOmitted.length,
  relativeStatsZeroBug: output.transformationLoss.relativePhysicalStatsEqualRowsMisreadAsNoCondition.length,
  opaqueSpecial: output.transformationLoss.specialRequirementsStoredOnlyAsOpaqueText,
} }, null, 2));
