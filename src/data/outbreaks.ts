/**
 * Mass outbreaks (대량발생): for a day, one place in a region teems with one species. Johto keeps Gold and Silver's
 * swarms that Professor Oak's radio show announced (Bulbapedia, "Mass outbreak", Generation II): Yanma on Route 35,
 * Snubbull on Route 38, Marill in Mt. Mortar and Dunsparce in Dark Cave. Elsewhere, as in Scarlet and Violet and
 * Legends: Arceus, any route or forest may hold one, with a species from its own table.
 */
export type Outbreak = { locationId: string; speciesId: number };

const SWARMS: Readonly<Record<string, readonly Outbreak[]>> = {
  johto: [
    { locationId: 'route-35', speciesId: 193 }, { locationId: 'route-38', speciesId: 209 },
    { locationId: 'mt-mortar', speciesId: 183 }, { locationId: 'dark-cave-west', speciesId: 206 },
  ],
};

type Place = { id: string; kind: string; encounters: readonly number[] };

/** The day an outbreak lasts, counted from the Unix epoch in UTC. */
export const outbreakDay = (epochMilliseconds: number): number => Math.floor(epochMilliseconds / 86_400_000);

/** The outbreak of `day` in a region; `allowed` keeps species the region may spawn (never lair legendaries). */
export function dailyOutbreak(regionId: string, places: readonly Place[], day: number, allowed: (speciesId: number) => boolean): Outbreak | undefined {
  // An FNV hash of the region and a multiplicative hash of the day spread consecutive days over the list.
  const regionSeed = [...regionId].reduce((hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619), 2166136261);
  const pick = (count: number, salt: number) => count ? (Math.imul((day + salt * 7919) ^ regionSeed, 2654435761) >>> 0) % count : -1;
  const swarms = (SWARMS[regionId] ?? []).filter(item => allowed(item.speciesId) && places.some(place => place.id === item.locationId));
  if (swarms.length) return swarms[pick(swarms.length, 1)];
  const habitats = places.filter(place => (place.kind === 'route' || place.kind === 'forest') && place.encounters.some(allowed));
  const place = habitats[pick(habitats.length, 2)]; if (!place) return undefined;
  const species = place.encounters.filter(allowed);
  return { locationId: place.id, speciesId: species[pick(species.length, 3)] };
}
