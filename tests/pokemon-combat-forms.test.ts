import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POKEMON_FORMS } from '../src/data/pokemon-versions.ts';
import {
  COMBAT_FORMS, getAlolaCombatForm, getCombatForm, getMegaCombatForm, getMegaCombatForms, isMegaEligible,
} from '../src/data/pokemon-combat-forms.ts';

describe('source-backed regional and Mega combat forms', () => {
  it('publishes every pinned Alola and Mega form with combat data and available sprites', async () => {
    expect(COMBAT_FORMS.filter(form => form.kind === 'alola')).toHaveLength(18);
    expect(COMBAT_FORMS.filter(form => form.kind === 'mega')).toHaveLength(97);
    for (const form of COMBAT_FORMS) {
      expect(form.types.length).toBeGreaterThan(0);
      expect(Object.values(form.baseStats).every(value => Number.isInteger(value) && value > 0)).toBe(true);
      expect(form.levelUpMoves.length).toBeGreaterThan(0);
      expect(POKEMON_FORMS.find(source => source.identifier === form.identifier)?.pokemonId).toBe(form.pokemonId);
      for (const sprite of [form.frontSprite, form.backSprite]) {
        if (sprite) await expect(readFile(join(process.cwd(), 'public', sprite))).resolves.toBeTruthy();
      }
    }
  });

  it('uses the actual Alola profiles rather than the base species profile', () => {
    expect(getAlolaCombatForm(19)).toMatchObject({ identifier: 'rattata-alola', pokemonId: 10091,
      types: ['dark', 'normal'], baseStats: { hp: 30, attack: 56, defense: 35, specialAttack: 25, specialDefense: 35, speed: 72 } });
    expect(getAlolaCombatForm(38)).toMatchObject({ identifier: 'ninetales-alola', pokemonId: 10104,
      types: ['ice', 'fairy'], baseStats: { hp: 73, attack: 67, defense: 75, specialAttack: 81, specialDefense: 100, speed: 109 } });
    expect(getAlolaCombatForm(6)).toBeUndefined();
  });

  it('exposes Mega eligibility, variants, stats, abilities and source form sprites', () => {
    expect(isMegaEligible(6)).toBe(true);
    expect(getMegaCombatForms(6).map(form => form.identifier)).toEqual(['charizard-mega-x', 'charizard-mega-y']);
    expect(getMegaCombatForm(6, 'charizard-mega-x')).toMatchObject({ pokemonId: 10034, types: ['fire', 'dragon'],
      baseStats: { hp: 78, attack: 130, defense: 111, specialAttack: 130, specialDefense: 85, speed: 100 },
      abilities: [{ slug: 'tough-claws', englishName: 'Tough Claws' }] });
    expect(getCombatForm('gengar-mega')).toMatchObject({ pokemonId: 10038, types: ['ghost', 'poison'],
      baseStats: { hp: 60, attack: 65, defense: 80, specialAttack: 170, specialDefense: 95, speed: 130 },
      abilities: [{ slug: 'shadow-tag', englishName: 'Shadow Tag' }] });
    expect(isMegaEligible(1)).toBe(false);
  });
});
