import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPANDED_MODEL_COMMIT, EXPANDED_NON_DRACO_MODEL_IDS, EXPANDED_NON_WEBP_MODEL_IDS,
  EXPANDED_POKEMON_MODEL_IDS, MISSING_POKEMON_MODEL_IDS,
  getPokemonModelSource, hasPokemonModel,
} from '../src/data/pokemon-models.ts';

describe('Pokemon 3D model catalog', () => {
  it('keeps Kanto URLs and adds every available post-Kanto regular species', () => {
    expect(EXPANDED_POKEMON_MODEL_IDS).toHaveLength(820);
    expect(MISSING_POKEMON_MODEL_IDS).toHaveLength(54);
    expect(new Set(EXPANDED_POKEMON_MODEL_IDS).size).toBe(820);
    expect(EXPANDED_POKEMON_MODEL_IDS.every(id => id > 151 && id <= 1025)).toBe(true);
    for (const id of [1, 151, 152, 155, 158, 252, 387, 495, 650, 722, 810, 906]) expect(hasPokemonModel(id)).toBe(true);
    expect(hasPokemonModel(1024)).toBe(true);
    expect(getPokemonModelSource(25)).toMatchObject({ id: 25, format: 'glb', requiresDraco: false });
    expect(getPokemonModelSource(152)).toMatchObject({ id: 152, format: 'glb', requiresDraco: true, compression: 'KHR_draco_mesh_compression', textureEncoding: 'webp', commit: EXPANDED_MODEL_COMMIT });
    expect(EXPANDED_NON_DRACO_MODEL_IDS).toEqual([]);
    expect(EXPANDED_NON_WEBP_MODEL_IDS).toEqual([187, 201, 328, 343, 358, 378, 379, 871, 907, 913]);
    expect(getPokemonModelSource(187)?.textureEncoding).toBeUndefined();
    expect(getPokemonModelSource(521)?.sourcePath).toBe('models/opt/regular/521-M.glb');
    expect(getPokemonModelSource(1024)).toMatchObject({ sourceClass: 'research-fallback', rightsStatus: 'source-license-unverified', requiresDraco: false });
  });

  it('pins every expanded URL and verifies representative local GLBs', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'src/data/pokemon-models-manifest.json'), 'utf8')) as any;
    expect(manifest.catalog).toMatchObject({ expandedSpecies: 820, totalSupportedSpecies: 971, missingSpecies: 54, externalFallbackSpecies: 54, totalRuntimeSpecies: 1025, regularFiles: 974 });
    expect(manifest.sample).toMatchObject({ scope: 'all-expanded', totalBytes: 305962400 });
    expect(manifest.sample.inspections).toHaveLength(820);
    expect(manifest.sample.inspections.filter((item: any) => item.animations > 0)).toHaveLength(114);
    expect(manifest.sample.inspections.filter((item: any) => item.skins > 0)).toHaveLength(466);
    for (const inspection of manifest.sample.inspections) {
      expect(inspection).toMatchObject({ glbVersion: 2, embeddedBuffer: true, draco: true });
      const entry = manifest.catalog.expandedEntries.find((item: any) => item.id === inspection.id);
      const cachePath = join(process.cwd(), inspection.cachePath);
      if (await access(cachePath).then(() => true, () => false)) {
        const bytes = await readFile(cachePath);
        expect(bytes.length).toBe(entry.bytes);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(inspection.sha256);
      }
      expect(inspection.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.sourceUrl).toContain(EXPANDED_MODEL_COMMIT);
    }
    const generated = await readFile(join(process.cwd(), manifest.output.path));
    expect(createHash('sha256').update(generated).digest('hex')).toBe(manifest.output.sha256);
  });
});
