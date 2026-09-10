import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MOVES, POKEMON, TYPE_EFFECTIVENESS, getMove, getSpecies, getTypeEffectiveness,
} from '../src/data/pokemon.ts';

const ROOT = process.cwd();

describe('Pokemon source data', () => {
  it('contains every first-generation species in National Pokedex order', () => {
    expect(POKEMON).toHaveLength(151);
    expect(POKEMON.map(species => species.id)).toEqual(Array.from({ length: 151 }, (_, index) => index + 1));
    expect(new Set(POKEMON.map(species => species.name)).size).toBe(151);
    expect(getSpecies(1)).toMatchObject({ name: '이상해씨', englishName: 'Bulbasaur' });
    expect(getSpecies(25)).toMatchObject({ name: '피카츄', englishName: 'Pikachu' });
    expect(getSpecies(151)).toMatchObject({ name: '뮤', englishName: 'Mew' });
    expect(() => getSpecies(0)).toThrow(RangeError);
    expect(() => getSpecies(152)).toThrow(RangeError);
  });

  it('preserves current stats, types, and complete referenced level-up moves', () => {
    expect(getSpecies(3).baseStats).toEqual({ hp: 80, attack: 82, defense: 83, specialAttack: 100, specialDefense: 100, speed: 80 });
    expect(getSpecies(35).types).toEqual(['fairy']);
    expect(getSpecies(81).types).toEqual(['electric', 'steel']);
    expect(Object.keys(MOVES).length).toBeGreaterThan(300);
    for (const species of POKEMON) {
      expect(species.name).toMatch(/[가-힣]/);
      expect(species.types.length).toBeGreaterThanOrEqual(1);
      expect(species.moves.length).toBeGreaterThan(0);
      expect(species.catchRate).toBeGreaterThan(0);
      expect(species.baseExperience).toBeGreaterThan(0);
      for (const learned of species.moves) expect(MOVES[learned.moveId], `${species.id} -> move ${learned.moveId}`).toBeDefined();
    }
    expect(getMove(33)).toMatchObject({ name: '몸통박치기', type: 'normal', power: 40, accuracy: 100, pp: 35, damageClass: 'physical' });
    expect(getMove(85)).toMatchObject({ name: '10만볼트', ailment: 'paralysis', effectChance: 10 });
    expect(() => getMove(-1)).toThrow(RangeError);
  });

  it('keeps evolutions inside the 151-species set with traditional methods', () => {
    for (const species of POKEMON) {
      for (const evolution of species.evolutions) {
        expect(evolution.target).toBeGreaterThanOrEqual(1);
        expect(evolution.target).toBeLessThanOrEqual(151);
        expect(getSpecies(evolution.target).id).toBe(evolution.target);
      }
    }
    expect(getSpecies(1).evolutions).toEqual([{ target: 2, method: 'level', level: 16 }]);
    expect(getSpecies(25).evolutions).toEqual([{ target: 26, method: 'stone', item: 'thunder-stone' }]);
    expect(getSpecies(64).evolutions).toEqual([{ target: 65, method: 'trade' }]);
    expect(getSpecies(133).evolutions).toEqual([
      { target: 134, method: 'stone', item: 'water-stone' },
      { target: 135, method: 'stone', item: 'thunder-stone' },
      { target: 136, method: 'stone', item: 'fire-stone' },
    ]);
  });

  it('provides the modern 18-type effectiveness table including dual types', () => {
    expect(Object.keys(TYPE_EFFECTIVENESS)).toHaveLength(18);
    expect(getTypeEffectiveness('fire', 'grass')).toBe(2);
    expect(getTypeEffectiveness('normal', 'ghost')).toBe(0);
    expect(getTypeEffectiveness('electric', ['water', 'flying'])).toBe(4);
    expect(getTypeEffectiveness('dragon', 'fairy')).toBe(0);
  });

  it('has both PNG sprites for every species and matches their SHA-256 manifest', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'public/pokemon/manifest.json'), 'utf8')) as {
      files: { path: string; sha256: string; bytes: number }[];
    };
    expect(manifest.files).toHaveLength(302);
    const files = new Map(manifest.files.map(file => [file.path, file]));
    for (let id = 1; id <= 151; id++) {
      for (const relative of [`${id}.png`, `back/${id}.png`]) {
        const entry = files.get(relative);
        expect(entry, relative).toBeDefined();
        const bytes = await readFile(join(ROOT, 'public/pokemon', relative));
        expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(bytes.length).toBe(entry!.bytes);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry!.sha256);
      }
    }
  });

  it('records checksums for each cached source CSV and the generated dataset', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'src/data/source-manifest.json'), 'utf8')) as {
      csvFiles: { file: string; sha256: string; bytes: number }[];
      output: { species: number; moves: number; sha256: string };
    };
    expect(manifest.output).toMatchObject({ species: 151, moves: Object.keys(MOVES).length });
    expect(manifest.csvFiles.length).toBeGreaterThan(15);
    for (const entry of manifest.csvFiles) {
      const bytes = await readFile(join(ROOT, 'src/data/.cache/pokeapi', entry.file));
      expect(bytes.length).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    }
    const generated = await readFile(join(ROOT, 'src/data/pokemon.ts'));
    expect(createHash('sha256').update(generated).digest('hex')).toBe(manifest.output.sha256);
  });
});
