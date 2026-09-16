import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

type ImageStats = { width: number; height: number; minAlpha: number; maxAlpha: number; zero: number; opaque: number; pixels: number };
type GLB = { images?: { name?: string; bufferView?: number; mimeType?: string; uri?: string }[];
  bufferViews: { byteOffset?: number; byteLength: number }[];
  textures?: { source?: number; extensions?: { EXT_texture_webp?: { source: number } } }[];
  materials?: { name?: string; alphaMode?: string; pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index: number }; metallicFactor?: number } }[] };
const inventory = JSON.parse(await readFile('artifacts/research/model-quality/full-model-quality-audit.json', 'utf8')) as { entries: { id: number; path: string; sourceClass: string }[] };
const browser = await chromium.launch();
const results: unknown[] = [];
try {
  const page = await browser.newPage();
  for (const entry of inventory.entries) {
    const bytes = await readFile(entry.path), jsonLength = bytes.readUInt32LE(12);
    const doc = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)) as GLB;
    const binStart = 20 + jsonLength + 8;
    const images = (doc.images ?? []).map(image => {
      const view = image.bufferView === undefined ? undefined : doc.bufferViews[image.bufferView];
      return { name: image.name, mime: image.mimeType ?? 'image/png',
        data: view ? bytes.subarray(binStart + (view.byteOffset ?? 0), binStart + (view.byteOffset ?? 0) + view.byteLength).toString('base64') : null };
    });
    const stats = await page.evaluate(async images => {
      const result: Array<ImageStats | { error: string }> = [];
      for (const image of images) {
        try {
          if (!image.data) throw new Error('non-embedded texture');
          const bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mime }));
          const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
          const context = canvas.getContext('2d', { willReadFrequently: true })!; context.drawImage(bitmap, 0, 0); bitmap.close();
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let minAlpha = 255, maxAlpha = 0, zero = 0, opaque = 0;
          for (let i = 3; i < data.length; i += 4) {
            const alpha = data[i]; minAlpha = Math.min(minAlpha, alpha); maxAlpha = Math.max(maxAlpha, alpha);
            if (alpha === 0) zero++; if (alpha === 255) opaque++;
          }
          result.push({ width: canvas.width, height: canvas.height, minAlpha, maxAlpha, zero, opaque, pixels: data.length / 4 });
          canvas.width = canvas.height = 0;
        } catch (error) { result.push({ error: String(error) }); }
      }
      return result;
    }, images);
    results.push({ ...entry, sha256: createHash('sha256').update(bytes).digest('hex'),
      images: images.map((image, index) => ({ name: image.name, ...stats[index] })),
      materials: (doc.materials ?? []).map(material => {
        const pbr = material.pbrMetallicRoughness, texture = doc.textures?.[pbr?.baseColorTexture?.index ?? -1];
        const imageIndex = texture?.extensions?.EXT_texture_webp?.source ?? texture?.source;
        return { name: material.name, alphaMode: material.alphaMode ?? 'OPAQUE', opacity: pbr?.baseColorFactor?.[3] ?? 1,
          metallic: pbr?.metallicFactor ?? 1, imageIndex, image: imageIndex === undefined ? undefined : stats[imageIndex] };
      }) });
    if (entry.id % 100 === 0) console.log(`Decoded texture pixels: ${entry.id}/1025`);
  }
} finally { await browser.close(); }
await mkdir('artifacts/model-appearance', { recursive: true });
await writeFile('artifacts/model-appearance/texture-audit.json', JSON.stringify({ generatedAt: new Date().toISOString(), models: results.length, results }, null, 2));
console.log(`Pixel audit complete: ${results.length} models`);
