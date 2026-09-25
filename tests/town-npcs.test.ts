import { describe, expect, it } from 'vitest';
import { getWorldAtlas } from '../src/openworld/atlas';
import { isRegionalLeagueLocation } from '../src/openworld/gym-scenes';
import { nearbyDungeon, npcLines, particle, planTownNpcs } from '../src/openworld/town-npc-plan';

const REGIONS = ['kanto', 'johto', 'hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'hisui', 'paldea'];

describe('town townsfolk', () => {
  it('stand on open ground beside the buildings of every town, apart from each other', { timeout: 60_000 }, () => {
    for (const region of REGIONS) {
      const atlas = getWorldAtlas(region);
      for (const town of atlas.locations.filter(place => place.kind === 'town' && !isRegionalLeagueLocation(region, place.id))) {
        const npcs = planTownNpcs(atlas, town, atlas.gyms.some(gym => gym.locationId === town.id));
        expect(npcs.length, `${region}:${town.id}`).toBeGreaterThan(0);
        const standing = npcs.filter(npc => !npc.patrol);
        for (const npc of standing) {
          expect(atlas.sample(npc.x, npc.z).blocked, `${region}:${npc.id}`).toBe(false);
          for (const other of standing) if (other !== npc) expect(Math.hypot(other.x - npc.x, other.z - npc.z)).toBeGreaterThanOrEqual(3.5);
        }
        // An officer's whole ring is open ground that passes no one standing.
        for (const officer of npcs.filter(npc => npc.patrol)) for (let step = 0; step < 36; step++) {
          const angle = step / 36 * Math.PI * 2, x = officer.patrol!.x + Math.cos(angle) * officer.patrol!.radius, z = officer.patrol!.z + Math.sin(angle) * officer.patrol!.radius;
          expect(atlas.sample(x, z).blocked, `${region}:${officer.id}`).toBe(false);
          for (const npc of standing) expect(Math.hypot(npc.x - x, npc.z - z)).toBeGreaterThanOrEqual(1.4);
        }
      }
    }
  });

  it('talk about the town: its shop, its gym and the day\'s news', () => {
    const atlas = getWorldAtlas('kanto'), celadon = atlas.locations.find(place => place.id === 'celadon')!;
    const gym = atlas.gyms.find(item => item.locationId === 'celadon')!;
    const context = { regionId: 'kanto', regionName: atlas.name, town: { id: celadon.id, name: celadon.name }, gym, badges: 0,
      outbreak: { placeName: '상록숲', speciesName: '피카츄' }, partnerName: '이상해씨', nearbyDungeon: nearbyDungeon(atlas, celadon) };
    expect(npcLines('shop', context).join(' ')).toContain('무지개시티 백화점');
    expect(npcLines('gym', context)[0]).toContain(gym.name);
    expect(npcLines('gym', { ...context, badges: 8 })[0]).toContain('받았군요');
    const plaza = npcLines('plaza', context).join(' ');
    expect(plaza).toContain('피카츄가 잔뜩');
    expect(plaza).toContain('이상해씨와 함께');
    for (const role of ['clinic', 'shop', 'gym', 'lab', 'home', 'plaza', 'police'] as const) expect(npcLines(role, context).length, role).toBeGreaterThan(0);
  });

  it('pick Korean particles by the last syllable', () => {
    expect(particle('피카츄', '이', '가')).toBe('피카츄가');
    expect(particle('이상해꽃', '과', '와')).toBe('이상해꽃과');
    expect(particle('불꽃의돌', '을', '를')).toBe('불꽃의돌을');
    expect(particle('기술머신 냉동빔', '을', '를')).toBe('기술머신 냉동빔을');
  });
});
