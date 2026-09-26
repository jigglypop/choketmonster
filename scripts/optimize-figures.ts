// Builds the game's figure models (public/models/trainer/web/) from their masters in assets/trainer-source/web/.
// pnpm exec tsx scripts/optimize-figures.ts [name ...]
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const source = 'assets/trainer-source/web', target = 'public/models/trainer/web';
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const names = process.argv.length > 2 ? process.argv.slice(2) : (await readdir(source)).filter(file => file.endsWith('.glb')).map(file => file.slice(0, -4));
const megabytes = async (path: string) => ((await stat(path)).size / 1e6).toFixed(2);

for (const name of names) {
  const input = join(source, `${name}.glb`), output = join(target, `${name}.glb`);
  const document = await io.read(input);
  // shadeFigure draws every figure fully rough and non-metallic, so its metallic-roughness map never reaches the screen.
  for (const material of document.getRoot().listMaterials()) material.setMetallicRoughnessTexture(null);
  await document.transform(
    dedup(), prune(),
    // Relief at half the colour map's size, still lossless: a 1.9 m figure a few metres away shows no finer normal detail.
    textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /^normalTexture$/, resize: [1024, 1024], lossless: true }),
    // Quantized, reordered and compressed geometry and clips; the loader decodes them with three's MeshoptDecoder.
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(output, document);
  console.log(`${name}: ${await megabytes(input)} MB -> ${await megabytes(output)} MB`);
}
