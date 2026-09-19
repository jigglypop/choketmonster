import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getWorldAtlas } from '../src/openworld/atlas';

const label = process.argv[2] ?? 'baseline';
const results = [];
for (const region of ['hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'hisui', 'paldea'] as const) {
  const atlas = getWorldAtlas(region), durations = [];
  let checksum = 0;
  for (let run = 0; run < 6; run++) {
    const started = performance.now();
    for (let index = 0; index < 20_000; index++) {
      const point = atlas.sample((index * 17 % 480) - 240, (index * 31 % 478) - 239);
      checksum += point.height + Number(point.blocked);
    }
    if (run > 0) durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  results.push({ region, samples: 20_000, medianMs: durations[2], durations, checksum });
}
mkdirSync('artifacts/terrain-sampling', { recursive: true });
writeFileSync(`artifacts/terrain-sampling/${label}.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(({ region, medianMs, checksum }) => ({ region, medianMs, checksum }))));
