# Combat forms release

## Included

- Korean display names for all 115 Alola/Mega combat form records; stable form identifiers and saved identities stay unchanged.
- Exact GLB selection in the open world and team detail: all 18 Alola forms and 64 of 97 Mega forms.
- Original HOME Unity color maps restored by material identity, including UV wrapping, opacity and Alolan Muk's second color layer. Model and texture source commits and hashes are recorded in `src/data/pokemon-*-manifest.json` and `pokemon-form-textures.json`.
- Tera crystal materials are instance-local; crowns follow the model's head. Tera Blast is available through compatible species' move layout, changes type/category in battle, and uses the same effective move data in ranked responses. Eligible weak Tera-type moves receive the 60-power floor.
- Regional abilities survive save validation; Rust and browser catalogs include Tera Blast compatibility.

## Evidence

- Production build and TypeScript validation passed locally. Focused data, gameplay, naming and material tests passed. The full local unit run had one filesystem hashing timeout under concurrent rendering; the same data suite passed twice when rerun.
- All 18 Alola and 64 Mega GLBs were rendered in the shared WebGPU model fixture. Source geometry and corrected Alola texture renders were inspected; models are not accepted from download status alone.
- Browser scenarios cover actual open-world form geometry, team portraits, Tera Blast editing, Tera crown/material attachment, and two-account ranked transformation persistence.

## Remaining boundaries

- 33 Mega forms without verified 3D assets are unavailable: excluded from transformation choices and rejected by browser and ranked-server activation. The 3D sprite fallback has been removed. Candidate archive pages are known, but source access is blocked by a browser security challenge; those models are not represented as runtime-ready.
- Mega Floette and Mega Zygarde have HP differences from their default species that need a separate mechanics audit.
- Models/textures use pinned external source URLs, following the existing runtime loading path. No model binaries are redistributed by this change. Repository licensing does not establish clearance for the underlying Pokemon assets; the manifests retain the unresolved rights status.

Deployment completion is recorded only after the production workflow and live commit/health checks pass.
