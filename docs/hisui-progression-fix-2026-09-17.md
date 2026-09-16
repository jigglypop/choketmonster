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
