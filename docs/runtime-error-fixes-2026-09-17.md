# Runtime error fixes — 2026-09-17

## `No morning encounter`

Reproduced `No morning encounter at galar:east-lake-axewell:lake`. The same mismatch exists at `galar-route-9:lake`. This is not a morning-only restriction: both are rare-only aquatic habitats. Spawn-position eligibility included supplemental species on every turn, while actual selection permits those supplements only on each twentieth spawn. A normal turn could therefore choose a position with no eligible source slot and throw.

Spawn eligibility now receives the exact spawn serial and uses the same rare-cycle condition as selection. The complete habitat catalog still includes those rare species, and morning/day/night tables remain combined. Nothing is replaced with random out-of-region encounters, and rare weighting is not inflated to hide an empty source pool.

`tests/encounter-spawn-cycle.test.ts` checks both affected places over all three periods and normal/rare turns; enumerates eligible habitats throughout all eight expansion regions; and runs streaming, respawns, snapshot and restore beside the Galar lake with a saved morning clock. Existing owned creatures and their brain state are not reset.

## Save 422 and neural cache 428

The Rust ability-effect validation omitted five client partial-effect categories: insomnia, vital-spirit, comatose, soundproof and good-as-gold. The shared meaning is restored with server tests. The production API verification fixture now includes canonical insomnia and soundproof individuals.

The browser sends a complete durable brain checkpoint on a cold connection, then omits it only after acknowledging a warm remote head. A 428 retries the same checkpoint/history/request IDs. Incomplete checkpoint lineage is reported without deleting or restarting learned memory. The browser regression verifies cold reload, warm-cache loss and preservation of corrupt one-sided local records.

Windows App Control prevented execution of the newly built local Rust test binary. Compilation succeeded, but local compilation is not a test-pass claim. The release workflow now runs the save-validation tests on Linux before deploying the server.

## Code and UI cleanup

The header retains its ball logo and accessible home label without visible title text. Unreferenced legacy field-panel/session/bindings, GPU probe, worker, old server launcher/Vite plugin, obsolete CSS and the unused 2D world renderer were removed. The live save store, lab brain renderer and production field runtime remain.

Unused-local/parameter TypeScript checks and a Knip file/dependency entry-point configuration guard against reintroducing dead modules. Indexed trainer/evolution lookups, linear nearest-target selection, reused camera offsets and fewer temporary view-window arrays reduce redundant work without changing model detail, terrain textures, simulation random draws or movement speed. These are code-level reductions, not a measured FPS guarantee. The large main bundle remains an open startup-performance item.

The deprecated TSL timer was replaced by `time`; the ignored Windows adapter preference is omitted. Browser checks cover account conflict preservation, the live world/route renderer, desktop/mobile dex/map controls and real GLB material rendering.
