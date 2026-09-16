# Hisui progression and locked entrances

## Root cause

Brava Arena awarded investigation badge 2 but required badge 2 to enter. The
same self-lock affected the remaining six challenges. Existing tests granted all
8 badges before checking terrain, so they could not detect sequential deadlocks.

## Changes

- Challenges 2–8 now require the previous challenge's badge, not their own reward.
- Existing saves, locations, terrain and campaign rewards are preserved.
- Hisui road lock markers are generated at actual location-ownership boundaries.
  Long hub roads do not necessarily lock at their geometric midpoints.
- The atlas remains the authority for collision. These markers add no second
  physics wall; Kanto's existing physical gates retain their collision.
- Locked gates use an orange barrier, yellow bars, a lock icon, earned/required
  counts and the named prerequisite. Nearby labels stay within the mobile viewport.
- Locked map markers and list rows explain the prerequisite when selected instead
  of silently ignoring input. Ordinary reachable markers retain map navigation.

## Verification

- New regression first reproduced Brava Arena's `2 <= 1` self-lock failure.
- Stage-by-stage pathfinding: all 64 challenges across the eight authored expansion
  regions pass with only the preceding badges, using runtime terrain and locks.
- Itinerary connectivity is checked at each stage; Hisui visual gate positions are
  checked immediately on both sides before/after their required badge.
- Real Chrome/WebGPU: badge 1 save walks from Crimson Mirelands into Brava Arena and
  starts the second challenge. Locked map rows explain the second badge requirement.
- Real Chrome/WebGPU: the Moonview gate shows its requirement with 3 badges, opens
  with 4, and remains open after save/reload. Desktop and 390px mobile labels are
  fully within the viewport, with screenshots inspected.
- Screenshots: `artifacts/hisui-progression-final/` (walking/challenge),
  `artifacts/hisui-gate-clamped/` (final gate labels).

This verifies traversal and starting challenges, not winning every battle in a
browser. No claims about unrelated model texture completeness are implied.

## Temple investigation → Survey Corps finals follow-up

A separate UI deadlock remained at the final investigation. `temple-of-sinnoh`
hosts both badge 8 and all five Survey Corps finals. The exploration panel
always prioritized the location's gym, even when already cleared, hiding both
the next trainer button and its click handler. The engine's next-trainer logic
was correct; engine-only progression tests could not detect this UI failure.

- The next available local final now takes precedence over a completed gym.
  Before badge 8, the investigation remains the actionable challenge. Existing
  badges, final stages and in-progress battles are not rewritten.
- The final investigation victory dialog explicitly points to Mi-do in the same
  temple's exploration settings. Hisui arrival guidance says Survey Corps finals,
  not a League. Completed later regions now name the next unlocked region;
  Hisui completion points to Paldea.
- A real Chrome/WebGPU regression first failed because
  `#world-trainer-challenge` did not exist. After the fix, all five finals can be
  started through that button. First/final battles survive save/reload.
- A near-victory investigation fixture executes its last battle turn, earns
  badge 8, closes the reward dialog and immediately exposes Mi-do. This also
  survives save/reload.
- A near-victory Volo fixture executes its last battle turn, unlocks Paldea,
  travels there through the map, claims Sprigatito and reloads into Paldea with
  the real #906 model and no duplicate starter prompt.
- These near-victory fixtures verify UI handoffs and saved progress, not full
  combat balance or winning the entire campaign from a new save. All three
  browser scenarios pass; 20 related campaign/wayfinder unit tests pass.

Evidence: `artifacts/hisui-final-before/`, `artifacts/hisui-final-handoff/`,
`artifacts/hisui-paldea-handoff/`.
