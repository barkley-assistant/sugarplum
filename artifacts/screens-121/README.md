# screens/121 — evidence captures for sugarplum #121

Throwaway evidence branch (same convention as `screens/113`, `screens/130`,
`screens/126`, `screens/119`, `screens/102`). Nothing here is product code; the
change lands on `fix/add-edit-heading-copy` as four commits. This branch is never
merged.

## What is captured

The ONLY changed surfaces are the two form pages (`/add`, `/items/:id/edit`) —
one heading token each, the `/add` document title, one string-key retirement.
24 captures per side (full page, 1x CSS pixels):

| fixture | seed | files | count |
|---|---|---|---|
| Add page, default state | one manual item (no scrape needed) | `add-<width>-<scheme>.png` | 10 |
| Add page, "Add details manually" open | same | `add-manual-<width>-<scheme>.png` | 4 |
| Edit page, item loaded | same item | `edit-<width>-<scheme>.png` | 10 |

Widths **360 / 390 / 430 / 768 / 1280**, schemes **light + dark** — the label
is theme-invariant, so the pairs exist to prove the pair renders under both
palettes and that nothing wraps or overflows at the narrow widths.

Busy states (`Adding…` / `Saving…`) are NOT captured: they are unchanged by this
ticket (labels live in `ItemForm.tsx` by mode) and reaching them needs a stalled
request, which the plan marks optional.

## How the two sides were produced

- `before/` — clean build of `main` @ `43909f6` in a detached worktree
  (`scratch/screens-121/before-repo`).
- `after/` — build of `fix/add-edit-heading-copy` head (`6ad9082`).

Both sides ran the same harness (`.hermes/scripts/screens-121.ts`, gitignored and
kept out of the repo): the PROD-mode web bundle, a dev-mode server on a temp DB +
random port with the same bootstrap admin, the same one-item seed through the real
HTTP API, the same viewport list and `colorScheme`/`reducedMotion` context
options. Each side got its own temp DB, images dir and port, so the columns are
directly comparable.

`before/measurements.json` and `after/measurements.json` are the raw runtime
probe behind the tables below (`probe-matrix.txt` is the field diff of the two).

## Measured state (runtime probe, both sides)

| probe | before | after |
|---|---|---|
| `/add` h1 (page title), every width + scheme | `Add to Sugarplum` | **`Add item`** |
| `/add` document.title | `Add · sugarplum` | **`Add item · sugarplum`** |
| `/add` submit label | `Add item` | `Add item` (unchanged) |
| `/add` form-actions | `["Cancel"]` | unchanged |
| `/edit` h1 (page title) | `Edit` | **`Edit item`** |
| `/edit` document.title | `Edit item · sugarplum` | unchanged (already the pair) |
| `/edit` submit label | `Save` | `Save` (unchanged) |
| `/edit` form-actions | `["Save", "Cancel"]` | unchanged |
| literal `Add to Sugarplum` anywhere in the rendered body text | `true` on the 14 add captures | **`false` on all 24** |
| page-title line count (all captures) | `[1]` | `[1]` |
| page-title box at 360px (w × h) | `328 × 28.6` | `328 × 28.6` (identical geometry) |
| horizontal overflow (`scrollWidth > clientWidth`) | `0 / 24` | `0 / 24` |
| brand h1 (AppShell) | `sugarplum` | `sugarplum` (untouched, still first h1) |

## Pixel matrix

`pixel-matrix.txt` — per-capture differing-pixel count, percentage and bbox
(images are top-aligned onto the overlapping canvas before diffing).

24/24 captures differ, and every diff is confined to the heading band — the
title text itself, at `y 73-94` on the add captures and `y 73-89` on the edit
captures. No capture changes height (`Δh = 0` across the set: 844 CSS px each),
which is the "no reflow, no wrap" statement in numbers. Differing share is
0.05-0.54% of the canvas, the same one line of text in light and dark.

| capture | Δh | differing | bbox |
|---|---|---|---|
| `add-360-light` | 0 | 1637 px (0.54%) | x 64-206, y 73-94 |
| `add-1280-light` | 0 | 1637 px (0.15%) | x 328-470, y 73-94 |
| `add-manual-390-light` | 0 | 1637 px (0.50%) | x 64-206, y 73-94 |
| `edit-360-light` | 0 | 497 px (0.16%) | x 64-109, y 73-89 |
| `edit-1280-light` | 0 | 497 px (0.05%) | x 328-373, y 73-89 |
| `edit-390-dark` | 0 | 514 px (0.16%) | x 64-109, y 73-89 |

Dark captures match their light counterparts within a few pixels (same glyphs,
other palette). The document-title change is not visible in these images at all —
browser chrome is not part of a page screenshot; it is covered by the probe's
`docTitle` row above and by the two re-anchored e2e pins.

## OCR — an independent read of the rendered pixels

`ocr.txt` (tesseract, `--psm 4`) reads both sides of every capture. The
discriminating lines, verbatim:

- `before/add-390-light` → `Add to Sugarplum` present, `Add item` (the submit
  button) present.
- `after/add-390-light` → `Add item` present, **`Add to Sugarplum` absent**.
- `before/edit-390-light` → a bare `Edit` line present, `Edit item` absent.
- `after/edit-390-light` → `Edit item` present, **bare `Edit` line absent**.
- `before/add-manual-390-light` / `after/add-manual-390-light` → same swap with
  the manual fields open, so the heading survives the taller page unchanged.

Same reads in dark (the scheme only moves the palette).

## Cross-check

The two re-anchored e2e pins are the machine acceptance test and read the same
strings off the DOM: `e2e/app.spec.ts:455` (`heading "Add item"`, spec 3c) and
`e2e/app.spec.ts:866` (`heading "Edit item"`, spec 4i). Both pass in the full
serial suite (88 passed) on this branch and on a fresh clone of
`origin/fix/add-edit-heading-copy`.
