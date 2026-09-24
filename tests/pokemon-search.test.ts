import { describe, expect, it } from 'vitest';
import { createGame, createMonster } from '../src/game/engine';
import { searchPokemon } from '../src/ui/pokemon-search';

describe('box search', () => {
  it('combines name, number and Korean type terms without changing the collection', () => {
    const game = createGame(1, 'search');
    const monsters = [createMonster(game, 25, 8), createMonster(game, 1, 12), createMonster(game, 4, 5)];
    expect(searchPokemon(monsters, 'PIKACHU 전기')).toEqual([monsters[0]]);
    expect(searchPokemon(monsters, '#25')).toEqual([monsters[0]]);
    expect(searchPokemon(monsters, '피카츄', 'fire')).toEqual([]);
    expect(searchPokemon(monsters, '', 'all', 'level')).toEqual([monsters[1], monsters[0], monsters[2]]);
    expect(monsters.map(monster => monster.speciesId)).toEqual([25, 1, 4]);
    monsters[0].nickname = '새 이름';
    expect(searchPokemon(monsters, '새 이름')).toEqual([monsters[0]]);
  });

  it('puts Pokémon that cannot battle here after usable ones, keeping the chosen order in each group', () => {
    const game = createGame(1, 'search-usable');
    const monsters = [createMonster(game, 25, 8), createMonster(game, 1, 40), createMonster(game, 4, 5), createMonster(game, 7, 30)];
    const usable = (monster: typeof monsters[number]) => monster.level <= 20;
    expect(searchPokemon(monsters, '', 'all', 'level', usable)).toEqual([monsters[0], monsters[2], monsters[1], monsters[3]]);
    expect(searchPokemon(monsters, '', 'all', 'number', usable).map(monster => monster.speciesId)).toEqual([4, 25, 1, 7]);
  });
});
