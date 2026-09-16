# Texture pixels and runtime appearance — 2026-09-17

The previous GLB structure and deformation audit did **not** establish visual correctness. The reported Corviknight defect was real, despite its model, UVs and images all being present.

## Reproduced defect and corrections

- Corviknight (#823) contains three embedded images. Its `BodyA` image has alpha 31–64/255 and `BodyBEnv` alpha 32–155/255, while all three materials declare BLEND. The body consequently becomes translucent and overlapping inner surfaces show through. The runtime now treats these audited opaque anatomical surfaces as opaque while keeping the original color images, UVs, geometry and skinning. Its armored feathers retain metalness; eyes do not become metal.
- A pinned-source allowlist covers 95 material names on 42 species. This includes opaque images unnecessarily assigned BLEND and the erroneous body-alpha cases #480, #817, #819–823 and #828. It applies to both standard PBR and source unlit materials without changing the shader family.
- Explicit opacity below one, separate alpha maps and actual vertex alpha are preserved. Unreviewed textured surfaces are unchanged. Smoke, flames, jelly, glass and ice are not globally made opaque.
- Fractional authored metallic coatings are not glTF's omitted-factor default of one. They are now retained, including Registeel's `Material.004` coating (0.839096). Named/audited metal and metallic maps remain preserved.

No source model/image bytes were rewritten or added to the deployment payload. There is no polygon reduction, texture downscaling or replacement by flat color in these fixes.

## Evidence and limits

`scripts/audit-model-textures.ts` decoded all 3,400 embedded images in the 1,025 pinned models. There were no decode failures. The receipt includes model SHA-256, image dimensions, full pixel-alpha ranges and material/image bindings:

`artifacts/model-appearance/texture-audit.json`

`scripts/inspect-model-appearance.ts review-all idle-review` rendered 106 models: all 42 alpha-review species and all 64 models without source images. The production GLTF loader, authored rig path, selected idle clip, material normalizer, WebGPU renderer and daylight environment were used. All 106 submitted without captured GPU validation or page exceptions. Individual reports and captures are under `artifacts/model-appearance/{id}/idle-review`; nine contact sheets are alongside them. A separate bind-pose set is `runtime-review`. A render submission without an exception is **not** visual approval.

The visual review still has unresolved source-quality findings:

- Ten primary models use material/vertex colors rather than source texture images: #187, #201, #328, #343, #358, #378, #379, #871, #907 and #913. These render colored geometry; an absent image is not automatically a missing-file failure.
- All 54 HOME fallbacks still lack source textures. Their existing sprite-derived flat palettes are not equivalent to original textures. Face details and region-specific colors are visibly absent or inaccurate on several models. They are **not** marked appearance-complete by this audit.
- The idle contact sheets also flag primary-source geometry/pose concerns, notably #891 and #914, plus visible accessory/source-part issues on #820/#838. These are separate from the repaired alpha bug and are not cleared by earlier mechanical deformation checks.
- The remaining 919 models have pixel/structural coverage, not a new per-model visual sign-off. No claim of “all textures/rigs fixed” is made.

Source repositories, pinned revisions and unresolved fallback redistribution rights remain as documented in [all-generations readiness](all-generations-readiness-2026-09-16.md). No additional source assets are redistributed.

## Regression checks

- Material tests cover original-map/UV preservation, Corviknight metal/alpha separation, explicit opacity/alpha maps, vertex alpha, unlit surfaces and fractional coatings.
- `tests/ui/model-materials.spec.ts` loads the real #823 bytes and asserts three textured opaque surfaces, two metal body materials, dielectric eyes and no captured render errors.
- `tests/ui/webgpu-resources.spec.ts` submits changing route geometries with the reported index counts (3024, 2880, 3264, 3552, 3120, 2112). A fresh mesh identity avoids retaining old WebGPU buffer bindings. The candidate passes; the isolated old implementation did not reproduce the user's driver failure, so this is a defensive lifetime fix, not a claim of an exact hardware-error reproduction.
- Model-cache eviction no longer explicitly closes shared ImageBitmaps that a deferred renderer upload can still use. Texture/geometry disposal remains; release/reacquire pruning is deferred by one microtask.
