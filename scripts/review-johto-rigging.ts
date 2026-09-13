import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const sourceRoot = 'data/local/pokemon-models-expanded/429de1288cea0d43f5b4f56305d2276e94239d65';
const outputRoot = 'artifacts/johto-rig-review';
const defaultSpeciesIds = [152, 160, 165, 170, 187, 195, 201, 222] as const;

type ReviewResult = {
  id: number;
  automatedChecksPassed: boolean;
  visualReview: 'requires-human-inspection';
  image: string;
  cloneIndependence: {
    skinsA: number;
    skinsB: number;
    sharedBones: number;
    sharedSkeletons: number;
    relativeMotionA: number;
    relativeMotionB: number;
  };
  [key: string]: unknown;
};

function parseSpeciesIds(args: string[]) {
  const value = args.find(argument => !argument.startsWith('-'));
  if (!value) return [...defaultSpeciesIds];
  const ids = value.split(',').map(part => Number(part.trim()));
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error(`Invalid species ID list: ${value}`);
  }
  return ids;
}

const speciesIds = parseSpeciesIds(process.argv.slice(2));
mkdirSync(outputRoot, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
await page.route('**/rig-source/*.glb', async route => {
  const match = new URL(route.request().url()).pathname.match(/\/rig-source\/(\d+)\.glb$/);
  if (!match) return route.continue();
  await route.fulfill({ body: readFileSync(`${sourceRoot}/${match[1]}.glb`), contentType: 'model/gltf-binary' });
});
await page.goto('http://127.0.0.1:5173/data/connectome.json');

const results: Array<Omit<ReviewResult, 'image'> & { image?: undefined; sourceSha256: string }> = [];
try {
  for (const id of speciesIds) {
    const result = await page.evaluate(async speciesId => {
      const path = '/scripts/johto-rig-review-probe.ts';
      const { reviewJohtoRig } = await import(/* @vite-ignore */ path);
      return reviewJohtoRig(speciesId);
    }, id) as ReviewResult;
    writeFileSync(`${outputRoot}/${id}-phases.png`, Buffer.from(result.image.split(',')[1], 'base64'));
    const record = {
      ...result,
      image: undefined,
      sourceSha256: createHash('sha256').update(readFileSync(`${sourceRoot}/${id}.glb`)).digest('hex'),
    };
    results.push(record);
    writeFileSync(`${outputRoot}/review.json`, JSON.stringify({ generatedAt: new Date().toISOString(), speciesIds, results }, null, 2));
    console.log(JSON.stringify({ id, automatedChecksPassed: result.automatedChecksPassed, visualReview: result.visualReview, cloneIndependence: result.cloneIndependence }));
  }
} finally {
  await browser.close();
}

if (results.some(result => !result.automatedChecksPassed)) process.exitCode = 1;
