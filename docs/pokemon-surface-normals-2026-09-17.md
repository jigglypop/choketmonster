# Rounded Pokémon surfaces and rectangular eye patches

## Diagnosis

Bidoof (#399) has valid opaque body/eye images, not a missing texture or a
disabled shader. Its pinned body has 3,695 vertices and 1,235 nondegenerate
triangles; every triangle has per-face normals. The separately textured eye
polygons also receive different lighting from the supporting body, exposing
their rectangular outlines. Piplup (#393) and Cinccino (#573) reproduce that
second defect clearly.

`scripts/audit-model-normals.ts` reads the pinned sources without changing them,
including Draco primitives through the game's existing offline decoder. It
records each source SHA-256 in `artifacts/model-appearance/normal-audit.json`.
The audit covers 1,025 models / 5,563 primitives: 5,164 normal-bearing triangle
primitives inspected, 399 primitives in 52 models skipped because of absent or
sparse normals or a non-triangle mode. No invalid-length normal was found among
the inspected attributes. Missing source normals are not counted as inspected.

## Repair scope

- A reviewed allowlist of 92 species receives normal-only correction once during
  GLB loading, before authored rig preparation and shared model caching.
- Coincident vertices can share lighting across UV seams without welding any
  vertices. A 60-degree crease limit preserves sharp edges and opposing faces.
  Different skin weights and different morph positions remain separate;
  authored morph-normal geometry is skipped.
- Older `EyeDh` / `EyeNl` patches use nearby body-triangle interpolated normals.
  Their positions, textures, UVs and skin weights are not changed.
- Original GLBs, texture resolution, mesh topology and animation tracks remain
  untouched. No subdivision, simplification, extra material or render pass is
  introduced. Models outside the allowlist, including intentionally angular
  Boldore (#525), retain their source normals.

## Verification

- Same camera, daylight environment, resolution and animation time for all 92
  before/after Chrome WebGPU captures; all eight contact-sheet pairs inspected.
  No page/GPU error in the 184 captures. Material/texture pixel statistics and
  surface bindings match in all 92 pairs.
- Bidoof: 3,562 body vertex normals repaired; all 12 eye vertices aligned. The
  minimum eye/body normal dot product changes from approximately 0.8703 to 1.
  Piplup and Cinccino captures also show removal of the rectangular lighting seam.
- Five unit tests cover UV seams, hard edges, skin weights, morphs and exclusions.
  Together with existing material regressions, 16 tests pass.
- Three actual Chrome WebGPU contract tests (#399, #393, #525) compare SHA-256
  hashes of every non-normal geometry attribute, indices, morph data and animation
  tracks before/after. Material reports, nonzero GPU draw counts and triangle
  counts remain equal. Boldore stays unmodified.
- A real-world Hisui browser test loads Bidoof, walks by map destination, saves,
  reloads and restores its model and position without rendering errors.
- TypeScript, unused-file/dependency check and production build pass.

The initial batch's `render.calls` measured renderer invocations, not GPU draw
calls, and its delayed triangle count had already auto-reset. Those fields are
not performance evidence. The contract test now measures a warmed scene with
auto-reset disabled and requires nonzero draw/triangle counts.

Reproduction (with the existing foreground `pnpm dev` terminal on port 5188):

```powershell
$env:CHOKETMON_TEST_PORT='5188'
pnpm exec tsx scripts/audit-model-normals.ts
pnpm exec tsx scripts/inspect-model-appearance.ts smooth-all normals-before source-normals
pnpm exec tsx scripts/inspect-model-appearance.ts smooth-all normals-after
pnpm exec playwright test --config playwright.webgpu.config.ts tests/ui/pokemon-normals.spec.ts
pnpm exec playwright test --config playwright.webgpu.config.ts tests/ui/late-region-runtime.spec.ts --grep 'partner 399'
```

Captures: `artifacts/model-appearance/<id>/normals-before/render.png` and
`normals-after/render.png`; final contract screenshots:
`artifacts/pokemon-normal-contract-final/`; world save/reload evidence:
`artifacts/bidoof-world-runtime/`.

These are repository-owned captures and tests, not sealed `game-dev` runs (that
CLI/adapter is unavailable here). They establish this shading repair, not a
measured FPS improvement, complete animation coverage, or recovery of textures
missing from other source models. The outstanding source-asset issues recorded
in `model-texture-pixel-audit-2026-09-17.md` remain separate.
