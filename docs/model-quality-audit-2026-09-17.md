# Model quality audit — 2026-09-17

This receipt separates immutable source defects from runtime correction. It does not claim that a structural or deformation pass is a human visual review of every silhouette.

Follow-up: the Corviknight report exposed a gap in this structural audit. See [the pixel and runtime appearance audit](model-texture-pixel-audit-2026-09-17.md) for the repaired alpha/metal defects and the still-unresolved visual/source findings. The mechanical 1,025/1,025 result below must not be read as visual approval.

## Full source inventory

`scripts/audit-model-quality.ts` read the GLB JSON chunk of all 1,025 locally pinned regular-species models without rewriting source bytes: 971 primary models and 54 research-only HOME fallbacks. The complete per-species receipt is `artifacts/research/model-quality/full-model-quality-audit.json`.

- 4,396 meshes, 5,563 primitives, and 7,253,507 referenced position vertices were inspected.
- 354 source models have no skin and 760 have no source animation. In total, 764 need the existing explicitly authored runtime rig and/or motion path. These are source limitations, not remaining runtime failures.
- 310 source models contain at least one material with metallic factor above 0.15. Runtime now preserves metal only when a material name or metallic map explicitly identifies a metal surface; a Steel species type no longer makes its entire body chrome-like.
- 149 source models contain BLEND materials. Twelve have a BLEND material without a base-color texture: 168, 200, 577, 578, 579, 726, 752, 790, 837, 893, 897, and 945. A fully opaque material with no map or alpha map is now moved to the opaque depth-writing pass, preventing transparent-sort disappearance.
- 64 models have no source texture references. Fifty-four are the already documented HOME research fallbacks, which retain the authored sprite-derived palette classification. The ten primary-source IDs are recorded in the JSON receipt and are not falsely described as source-textured.

Material correction clones only shared imported materials that actually need a runtime fix, reuses untouched materials, and disposes the corrected per-instance clones when the actor leaves the scene. Geometry, topology, UVs, skin weights, morph targets, and texture objects stay unchanged; the cached loader template is not mutated. Geometry simplification remains disabled, so this optimization does not reduce model detail.

## Runtime rig and deformation rerun

- Kanto primary models: 151/151 passed production loader, finite-pose, and non-rigid deformation checks.
- Johto primary models: 100/100 passed bind, idle, walk, attack, damage, finite-weight, grounding, and deformation checks.
- Generation 3–9 primary models present in the pinned source: 720/720 passed the same runtime rig/deformation probe. The other 54 IDs in those National Dex ranges are the external research fallbacks.
- HOME research fallbacks: 54/54 passed all four authored-clip deformation checks and strict multi-frame arm checks where arm bones were detected.

The combined regular-species runtime result is 1,025/1,025 mechanically passing, with zero current rig/deformation failures. This does not clear the fallback repository's missing redistribution license and does not replace per-model human visual approval.

## Focused regression checks

- `pnpm exec vitest run tests/pokemon-materials.test.ts tests/model-normalization.test.ts tests/model-motion.test.ts`: 15/15 passed after the final instance-disposal check.
- `pnpm exec tsc --noEmit --pretty false`: passed.
- `pnpm exec tsx scripts/inspect-pokemon-rigging.ts artifacts/research/model-quality/source-rig-inventory.json artifacts/research/model-quality/generated-model-motion.ts`: 971/971 primary source files inspected.
