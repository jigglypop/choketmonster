import { getSpecies } from '../data/pokemon';
import { getCombatForm } from '../data/pokemon-combat-forms';
import type { Monster } from '../game/engine';

const speciesText = new Map<string, string>();
const typeNames: Record<string, string> = { normal: '노말', fire: '불꽃', water: '물', electric: '전기', grass: '풀', ice: '얼음', fighting: '격투', poison: '독', ground: '땅', flying: '비행', psychic: '에스퍼', bug: '벌레', rock: '바위', ghost: '고스트', dragon: '드래곤', dark: '악', steel: '강철', fairy: '페어리' };
const nameOrder = new Intl.Collator('ko', { numeric: true });
export type CollectionSort = 'number' | 'level' | 'name' | 'recent';

export function searchPokemon(monsters: readonly Monster[], query: string, type = 'all', sort: CollectionSort = 'number'): Monster[] {
  const words = query.trim().toLocaleLowerCase().replace(/#/g, '').split(/\s+/).filter(Boolean);
  const matches = monsters.filter(monster => {
    const species = getSpecies(monster.speciesId);
    const form = monster.regionalForm ? getCombatForm(monster.regionalForm) : undefined;
    const types = form?.types ?? species.types;
    if (type !== 'all' && !types.includes(type as typeof species.types[number])) return false;
    if (!words.length) return true;
    const key = `${species.id}:${form?.identifier ?? ''}`;
    let text = speciesText.get(key);
    if (!text) {
      text = `${species.name} ${species.englishName} ${species.id} ${form ? `${form.name} 알로라 alola` : ''} ${types.map(type => `${type} ${typeNames[type]}`).join(' ')}`.toLocaleLowerCase();
      speciesText.set(key, text);
    }
    const individual = `${text} ${monster.nickname} ${monster.instanceId}`.toLocaleLowerCase();
    return words.every(word => individual.includes(word));
  });
  if (sort === 'recent') return matches.reverse();
  return matches.sort((a, b) => sort === 'level' ? b.level - a.level : sort === 'name' ? nameOrder.compare(a.nickname, b.nickname) : a.speciesId - b.speciesId);
}
