import { writeFile } from 'node:fs/promises';
import { PLAYABLE_WORLDS, isPlayableSpecies } from '../src/openworld/availability';
import { FIELD_TRAINERS, type FieldTrainer } from '../src/data/field-trainers';

// These practice opponents are authored game content, not cartridge trainer data.
const starters: Record<string, number> = { kanto: 19, johto: 161, hoenn: 263, sinnoh: 399, unova: 504, kalos: 659, alola: 734 };
const trainers: FieldTrainer[] = PLAYABLE_WORLDS.flatMap(world => world.locations
  .filter(location => ['town', 'route', 'forest'].includes(location.kind))
  .map(location => {
    const candidates = [...new Set(location.encounters.filter(isPlayableSpecies))];
    const level = Math.max(3, Math.min(60, location.minLevel));
    const team: [number, number][] = [[candidates[0] ?? starters[world.id], level]];
    if (level >= 10 && candidates[1]) team.push([candidates[1], Math.max(3, level - 1)]);
    return { id: `practice-${world.id}-${location.id}`, region: world.id, locationId: location.id,
      name: `${location.name} 도전자`, trainerClass: '트레이너', team, reward: level * 40, trainerOrigin: 'authored' } as FieldTrainer;
  }));
await writeFile('src/data/authored-trainers.json', JSON.stringify(trainers, null, 2) + '\n');
const canonical = [...FIELD_TRAINERS.filter(trainer => trainer.trainerOrigin !== 'authored'), ...trainers]
  .map(({ id, region, locationId, team, reward }) => ({ id, region, locationId, team, reward }));
await writeFile('src/data/trainer-battle-catalog.json', JSON.stringify(canonical, null, 2) + '\n');
console.log(JSON.stringify({ authored: trainers.length, total: canonical.length }));
