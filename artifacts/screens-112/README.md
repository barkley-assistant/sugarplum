# screens/112 — evidence captures for sugarplum #112

Throwaway evidence branch (the same convention as `screens/70`, `screens/116`).
Nothing here is product code; the fix lands on `fix/add-manual-hover` (PR).

## What is captured

`/add`, the "Add details manually" disclosure row, at **360 / 390 / 430 / 768 /
1280** in **light and dark** (1x CSS pixels, full page):

| state | file |
|---|---|
| collapsed, pointer parked (resting) | `add-collapsed-rest-<theme>-<width>.png` |
| collapsed, pointer on the row (hover) | `add-collapsed-hover-<theme>-<width>.png` |
| manual form expanded, pointer on the row (hover) | `add-expanded-hover-<theme>-<width>.png` |
| primary "Add item" CTA hovered (issue non-negotiable) | `add-cta-hover-<theme>-390.png` |

32 captures per side.

## How the two sides were produced

- `before/` — a clean build of `origin/main` @ c2525c2 (`git worktree add`,
  `bun run build`), served on its own port with its own database.
- `after/` — a build of `fix/add-manual-hover` head @ e07db92.

Both runs used the same harness, the same bootstrap admin, the same viewport
list, and the same "park the pointer, hover, settle the 150 ms color
transition" sequence, so the two columns are directly comparable.

## Measured state (settled computed style, both sides)

| | before (origin/main) | after (fix) |
|---|---|---|
| hover `background-color`, light | `rgb(91, 33, 182)` (plum-700) | `rgba(0, 0, 0, 0)` |
| hover `background-color`, dark | `rgb(109, 78, 209)` (plum-700) | `rgba(0, 0, 0, 0)` |
| hover label contrast, light | **1.16:1** | **6.81:1** |
| hover label contrast, dark | **2.66:1** | **6.94:1** |
| hover `border-top-color`, light / dark | plum-700 (repainted) | `rgb(228, 228, 231)` / `rgb(42, 36, 56)` (`--border`) |
| "Add item" CTA hover background | `rgb(91, 33, 182)` / `rgb(109, 78, 209)` | unchanged |

The before numbers are the issue's own measured values, reproduced on a real
`origin/main` build.

## Diff matrix (`diff-matrix.txt`)

Per-capture differing-pixel counts between the two columns:

- all 10 **resting** captures: **0 differing pixels** (the fix touches no
  resting state);
- the 20 **hover** captures differ only inside the disclosure row band
  (y 267–311, plus the region below it when the form is open) — the violet bar
  becoming the page background + hairline;
- the 2 **CTA-hover** captures: 33–34 pixels, all ±1 channel steps on glyph
  antialiasing fringes (verified by coordinate dump), never a fill or layout
  change.
