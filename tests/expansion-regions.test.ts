import { describe, expect, it } from 'vitest';
import { EXPANSION_ENCOUNTER_POOLS, EXPANSION_ENCOUNTER_SOURCE } from '../src/data/expansion-encounters.generated';
import { expansionSpeciesAssetAvailable } from '../src/data/expansion-asset-availability';
import { HOENN_CONNECTIONS, HOENN_GYMS, HOENN_LOCATIONS, hoennBuildingOffsets, nearestHoennWalkable, sampleHoennWorld } from '../src/openworld/hoenn';
import { SINNOH_CONNECTIONS, SINNOH_GYMS, SINNOH_LOCATIONS, nearestSinnohWalkable, sampleSinnohWorld, sinnohBuildingOffsets } from '../src/openworld/sinnoh';
import { UNOVA_CONNECTIONS, UNOVA_GYMS, UNOVA_LOCATIONS, nearestUnovaWalkable, sampleUnovaWorld, unovaBuildingOffsets } from '../src/openworld/unova';

const regions = [
  {id:'hoenn' as const,locations:HOENN_LOCATIONS,connections:HOENN_CONNECTIONS,gyms:HOENN_GYMS,sample:sampleHoennWorld,nearest:nearestHoennWalkable,buildings:hoennBuildingOffsets,dex:[252,386] as const,league:'ever-grande-city'},
  {id:'sinnoh' as const,locations:SINNOH_LOCATIONS,connections:SINNOH_CONNECTIONS,gyms:SINNOH_GYMS,sample:sampleSinnohWorld,nearest:nearestSinnohWalkable,buildings:sinnohBuildingOffsets,dex:[387,493] as const,league:'sinnoh-pokemon-league'},
  {id:'unova' as const,locations:UNOVA_LOCATIONS,connections:UNOVA_CONNECTIONS,gyms:UNOVA_GYMS,sample:sampleUnovaWorld,nearest:nearestUnovaWalkable,buildings:unovaBuildingOffsets,dex:[494,649] as const,league:'unova-pokemon-league'},
];
describe('authored expansion regions',()=>{
  for(const region of regions)it(`${region.id} has connected walkable progression and collision`,()=>{
    const ids=new Set(region.locations.map(location=>location.id));expect(ids.has(region.league)).toBe(true);expect(region.gyms.map(gym=>gym.badge)).toEqual([1,2,3,4,5,6,7,8]);
    for(const [from,to] of region.connections){expect(ids.has(from)).toBe(true);expect(ids.has(to)).toBe(true);}
    for(const location of region.locations){expect(region.sample(location.x,location.z).blocked).toBe(false);expect(region.nearest(location.x,location.z,8)).toBeDefined();}
    for(const town of region.locations.filter(location=>location.kind==='town'))for(const [dx,dz] of region.buildings(town))expect(region.sample(town.x+dx,town.z+dz).blocked).toBe(true);
    const graph=new Map<string,string[]>();for(const [from,to] of region.connections){graph.set(from,[...(graph.get(from)??[]),to]);graph.set(to,[...(graph.get(to)??[]),from]);}
    const reached=new Set<string>(),queue=[region.locations[0].id];while(queue.length){const id=queue.shift()!;if(reached.has(id))continue;reached.add(id);queue.push(...(graph.get(id)??[]));}
    for(const gym of region.gyms)expect(reached.has(gym.locationId)).toBe(true);expect(reached.has(region.league)).toBe(true);
    for(let id=region.dex[0];id<=region.dex[1];id++)expect(expansionSpeciesAssetAvailable(region.id,id)).toBe(true);
  });
  it('uses normalized species IDs while preserving source form IDs',()=>{
    expect(EXPANSION_ENCOUNTER_SOURCE.selectedVersions).toEqual({hoenn:'emerald',sinnoh:'platinum',unova:'black'});
    for(const region of regions)for(const pool of EXPANSION_ENCOUNTER_POOLS[region.id]){
      expect(['walk','surf']).toContain(pool.method);expect(pool.slots.reduce((sum,slot)=>sum+slot.weight,0)).toBe(100);
      for(const slot of pool.slots){expect(slot.speciesId).toBeGreaterThan(0);expect(slot.speciesId).toBeLessThanOrEqual(region.dex[1]);expect(slot.sourcePokemonId).toBeGreaterThan(0);}
    }
  });
});
