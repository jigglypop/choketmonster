import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPERIENCE_BY_GROWTH_RATE, getExperienceForLevel } from '../src/data/pokemon-experience.ts';
import {
  NATIONAL_POKEDEX_SPECIES_IDS, POKEDEXES, POKEMON_FORMS, POKEMON_VERSIONS,
  VERSION_GROUPS, getPokedexEntries, getPokemonForms, getPokemonVersion,
  getVersionSpecies, getVersionSpeciesIds,
} from '../src/data/pokemon-versions.ts';

describe('Pokemon forms and version catalogs', () => {
  it('exposes every source form and available local sprite without pretending missing files exist', async () => {
    expect(POKEMON_FORMS).toHaveLength(1579);
    expect(getPokemonForms(19).some(form => form.identifier === 'rattata-alola')).toBe(true);
    expect(getPokemonForms(6).some(form => form.isMega)).toBe(true);
    expect(() => getPokemonForms(1026)).toThrow(RangeError);
    for (const form of POKEMON_FORMS) {
      expect(form.speciesId).toBeGreaterThanOrEqual(1);
      expect(form.speciesId).toBeLessThanOrEqual(1025);
      for (const sprite of [form.frontSprite, form.backSprite]) {
        if (sprite) await expect(readFile(join(process.cwd(), 'public', sprite))).resolves.toBeTruthy();
      }
    }
  });

  it('maps versions to the regional Pokedex rows at the pinned source revision', () => {
    expect(POKEMON_VERSIONS).toHaveLength(53);
    expect(VERSION_GROUPS).toHaveLength(32);
    expect(POKEDEXES).toHaveLength(35);
    expect(getPokemonVersion('red')).toMatchObject({ versionGroupId: 'red-blue', generation: 1, basis: 'regional-pokedex' });
    expect(getVersionSpeciesIds('red')).toHaveLength(151);
    expect(getVersionSpeciesIds('scarlet')).toHaveLength(664);
    expect(getVersionSpecies('red').map(species => species.id)).toEqual(getVersionSpeciesIds('red'));
    expect(getPokedexEntries('kanto')[0]).toEqual({ number: 1, speciesId: 1 });
    expect(getVersionSpeciesIds('national')).toBe(NATIONAL_POKEDEX_SPECIES_IDS);
    expect(NATIONAL_POKEDEX_SPECIES_IDS).toHaveLength(1025);
    expect(() => getPokemonVersion('national')).toThrow(RangeError);
  });

  it('preserves all six official experience curves through level 100', () => {
    expect(Object.keys(EXPERIENCE_BY_GROWTH_RATE).sort()).toEqual([
      'fast', 'fast-then-very-slow', 'medium', 'medium-slow', 'slow', 'slow-then-very-fast',
    ]);
    for (const values of Object.values(EXPERIENCE_BY_GROWTH_RATE)) {
      expect(values).toHaveLength(100);
      expect(values[0]).toBe(0);
      expect(values.every((value, index) => index === 0 || value >= values[index - 1])).toBe(true);
    }
    expect(getExperienceForLevel('slow-then-very-fast', 100)).toBe(600000);
    expect(getExperienceForLevel('fast-then-very-slow', 100)).toBe(1640000);
  });

  it('matches generated outputs and Rust validation artifact checksums', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'src/data/source-manifest.json'), 'utf8')) as {
      output: { versionsSha256: string; experienceSha256: string; validationSha256: string };
    };
    for (const [path, expected] of [
      ['src/data/pokemon-versions.ts', manifest.output.versionsSha256],
      ['src/data/pokemon-experience.ts', manifest.output.experienceSha256],
      ['rust-server/data/pokemon-validation.json', manifest.output.validationSha256],
    ] as const) {
      const bytes = await readFile(join(process.cwd(), path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
    }
  });
});
