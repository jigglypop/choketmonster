import { expect, it } from 'vitest';
import { COMBAT_FORMS, getCombatForm } from '../src/data/pokemon-combat-forms';
import { POKEMON_FORMS } from '../src/data/pokemon-versions';

it('shows every Alola and Mega name in Korean in battle and dex metadata', () => {
  expect(COMBAT_FORMS).toHaveLength(115);
  for (const form of COMBAT_FORMS) {
    expect(form.name).toMatch(/[가-힣]/);
    expect(form.name).not.toMatch(/[A-Wa-z]/);
    const metadata = POKEMON_FORMS.find(source => source.identifier === form.identifier)!;
    expect(metadata.name).toBe(form.name);
    expect(metadata.formName).not.toMatch(/Alola|Mega/);
  }
  expect(getCombatForm('raichu-alola')?.name).toBe('알로라 라이츄');
  expect(getCombatForm('charizard-mega-x')?.name).toBe('메가리자몽 X');
});
