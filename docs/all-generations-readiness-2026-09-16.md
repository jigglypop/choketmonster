# All-generations model and region readiness — 2026-09-16

This receipt separates locally inspected bytes, deformation-tested runtime models, and regions that are safe to expose. A repository URL or a syntactically valid GLB does not count as a playable species.

## Model sources and integrity

The primary source is `Pokemon-3D-api/assets` at commit `429de1288cea0d43f5b4f56305d2276e94239d65`. The repository's current `main` head was rechecked on 2026-09-16 and is still that commit. The fixed tree contains usable regular models for 971 of 1,025 National Dex species: the existing 151 Kanto models and 820 inspected post-Kanto GLBs totaling 305,962,400 bytes. Every inspected file has a local SHA-256 in `src/data/pokemon-models-manifest.json`.

The primary repository is MIT for its pipeline, but its README says the Pokemon models belong to Nintendo, Creatures, and GAME FREAK. This project therefore keeps the existing external-source runtime strategy and does not add the downloaded archive to `public`, `dist`, or source control.

Primary-source gaps remain for these 54 species:

`850, 851, 852, 853, 854, 859, 860, 861, 863, 864, 866, 868, 873, 878, 879, 882, 883, 918, 919, 931, 935, 936, 938, 939, 940, 944, 950, 951, 952, 953, 954, 955, 956, 961, 963, 964, 968, 969, 970, 971, 972, 976, 977, 986, 988, 989, 991, 992, 993, 1011, 1012, 1013, 1022, 1024`.

The fallback source is `Lilothestitch16/Pokemon-HOME-GLB-Models` at commit `27703273836f38f0e185976d955b1fbfb15448af`. A resumable downloader revalidated all 54 files (30,275,196 bytes) against Git blob SHA-1 and SHA-256. All 54 have source skins and geometry, but zero source animations, zero embedded or external images, zero texture objects, and zero material texture references. The pinned repository has no license file. Downloaded bytes remain in ignored `data/local` and are not copied into `public`, `dist`, or source control. Runtime follows the established external-source strategy and resolves the pinned owner URLs directly; every entry is marked `research-fallback` and `source-license-unverified`. `src/data/pokemon-home-research-manifest.json` records every selected path, digest, structural inspection, and the rights boundary.

Other public candidates checked:

- `Sudhanshu-Ambastha/Pokemon-3D` at `eaccd7e5e9522623d6d41249131a0aeb676388da` has the same 54 regular-species gaps.
- `dnnyngyen/codex-pokepets` at `3bff0e1def268a3504f9cba1bec467a5d901d20b` provides rendered animated sprites, not 3D geometry.
- `Naaylla/pokemons-3D` at `9a723e37ab4341a5c9d67390ad49bc94812f4131` contains one Bulbasaur GLB and no license.
- `Lilothestitch16/Pokemon-HOME-Unity-Models` at `7b18d1a3e22df48329220ea99c4d2a6617d72345` is an unlicensed extracted Unity project. The 49,616 returned blobs contain no GLB, glTF, FBX, or OBJ files, and the recursive tree is truncated, so it is not a reviewable runtime source.
- A current GitHub source search found no author-licensed, textured, complete Generation 8–9 GLB collection that closes these gaps. This is a source-rights and texture blocker for distribution, not a local geometry or authored-motion blocker.

## Rig and motion verification

`regional-authored-v4` preserves source animations. When a model has no usable source clip, it adds explicitly marked `CM_idle`, `CM_walk`, `CM_attack`, and `CM_damage` clips. Version 4 derives each upper arm's lowering axis from its real bind segment instead of assuming left/right model axes. The strict pose audit requires both upper arms to point downward in at least two of three samples in both idle and walk. Verification also samples each clip at 13 times, checks finite poses and skin weights, and requires vertex deformation after removing rigid object motion.

| National range | Primary geometry | Primary runtime deformation | Remaining primary gaps |
|---|---:|---:|---:|
| 252–386 Hoenn | 135/135 | 135/135 | 0 |
| 387–493 Sinnoh | 107/107 | 107/107 | 0 |
| 494–649 Unova | 156/156 | 156/156 | 0 |
| 650–721 Kalos | 72/72 | 72/72 | 0 |
| 722–809 Alola | 88/88 | 88/88 | 0 |
| 810–905 Galar/Hisui-era species | 79/96 | 79/79 available | 17 |
| 906–1025 Paldea-era species | 83/120 | 83/83 available | 37 |

The 54 fallback GLBs pass the same four authored-clip deformation checks locally: 54/54 have complete weights, finite sampled poses, non-rigid vertex movement, and the strict multi-frame arm check where arm bones are detected. Their original source skeletons and joint tables remain valid and are reused. A separate authored appearance pass quantizes six colors from each pinned PokeAPI front sprite, maps body/eye/mouth material names to stable colors, disables metallic response, and assigns a per-material flat UV texture. This is labelled `authored-derived-palette-not-source-texture`; it does not claim to reconstruct source textures. The source GLBs and sprites remain unchanged.

`scripts/verify-home-model-rigging.ts` produces `artifacts/research/home-model-rigging/verification.json`, 162 bind/idle/walk PNGs, six contact sheets, and a local `index.html`. `scripts/verify-home-runtime-catalog.ts` proves all 1,025 IDs resolve, all 54 cached fallback bytes still match SHA-256, and representatives 852, 936, and 1024 load from the pinned external URLs through the production catalog and GLTF loader with v4 rig and authored UV material metadata.

## Region exposure

Kanto, Johto, Hoenn, Sinnoh, Unova, Kalos, and Alola are the only selectable regions. Kalos and Alola use authored location graphs, terrain sampling, collision boundaries, safe arrivals, fixed encounter tables, eight gym/trial stages, and five-stage leagues. Their maps and campaigns are integrated with client and Rust save/realtime validation.

Galar, Hisui, and Paldea now have authored atlas/campaign/encounter candidates and remain subject to the final browser gate:

- Galar has 17 primary-source gaps filled through the explicit external fallback. Its 79 primary models and all 17 fallbacks pass runtime rig checks; PokeAPI provides 102 Sword encounter pools covering 115 species.
- Hisui native species 899-905 pass a focused 7/7 primary geometry, skin, and source-animation audit. Supplemental encounters store National Dex IDs and deliberately render regular forms. `regionalFormsVerified` remains 0; no base-form GLB is labelled as a Hisuian variant.
- Paldea has 37 primary-source gaps filled through the explicit external fallback. Its 83 primary models and all 37 fallbacks pass runtime rig checks. The pinned PokeAPI Scarlet/Violet encounter data contains zero pools, so the authored supplemental distribution stays labelled as reconstruction.

Region selection is controlled by the combined model, terrain/collision, encounter, and browser traversal/save-recovery gate. Existing saves and atlas identifiers remain accepted even when a region is hidden.

## Encounter runtime contract

Raw morning/day/night source tables and saved time fields remain intact. Runtime pools normalize each source period to mass 100 and merge distinct periods with equal period weight, so every original time-specific species remains obtainable without tripling an all-day table. Supplemental rare rules are available in every period. Town source pools and town supplemental anchors are excluded from wild spawning; their species remain reachable through non-town source or rare assignments.

The runtime entry points are:

- `regionalRuntimePools(region, worldLocationId, period, biome?)`
- `expansionRuntimePools(region, locationId, method, period)`
- `chooseRegionalEncounter(...)` and `chooseExpansionEncounter(...)`, which consume those combined pools and all-time rare rules.

## Verification summary

- TypeScript: `pnpm exec tsc --noEmit --pretty false` passed.
- Rust realtime: 11/11 tests passed, including Kalos/Alola scenes and species 809 acceptance.
- Rust save validation: 18/18 focused tests passed, including five expansion campaign records and sequential Kalos/Alola gates.
- Region/data regression set: 38/38 tests passed.
- Full expansion campaign battle sequence: 2/2 tests passed through Alola.
- Rigging v4: primary 971/971 and external fallback 54/54 passed, for runtime catalog coverage 1,025/1,025. Strict representative humanoid pose audit: 23/23.
- Runtime catalog: 1,025/1,025 IDs resolve; 54/54 fallback SHA-256 checks passed; three external Chromium loads passed with authored materials and v4 rig metadata.

The 971 count remains primary-source coverage. Runtime reaches 1,025/1,025 through pinned external fallback URLs and authored code without redistributing the 54 GLBs. The fallback repository's absent license remains an explicit provenance limitation and is not presented as cleared redistribution rights.
