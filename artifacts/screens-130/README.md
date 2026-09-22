# screens/130 — evidence captures for sugarplum #130

Throwaway evidence branch (same convention as `screens/119`, `screens/126`).
Nothing here is product code; the change lands on `feat/feed-row-consistency`.

## What is captured

44 captures per side (1x CSS pixels, viewport-height frames):

| surface | files | count |
|---|---|---|
| owner feed (no price / at lowest / above lowest / wrapped title) | `owner-feed-<width>-<scheme>.png` | 10 |
| owner item page hero | `owner-detail-<width>-<scheme>.png` | 10 |
| owner reorder mode | `owner-reorder-390-<scheme>.png` | 2 |
| guest (other-user) feed | `guest-feed-<width>-<scheme>.png` | 10 |
| guest detail sheet | `guest-detail-390-<scheme>.png` | 2 |
| anonymous share feed | `share-feed-<width>-<scheme>.png` | 10 |

Widths **360 / 390 / 430 / 768 / 1280**, schemes **light + dark**.

## How the two sides were produced

- `before/` — clean build of `main` @ `0435ee3`.
- `after/` — build of `feat/feed-row-consistency` head.

Both runs used the same harness, the same bootstrap admin, and the same four
rows seeded through the real API: three scraped from a local fixture server (so
the thumbnails are real PNGs — 480x320 landscape, 320x480 portrait, 480x480
square, each with a 6px edge border so a crop is visible) plus one manual
title-only row. The second scraped row is patched up after its first
observation, which is the only way to build a real "above its lowest" row (the
ledger minimum can never exceed the current price). Each side ran on its own
temp DB, images dir and port. Same viewport list, colour schemes and settle
step, so the two columns are directly comparable.

`_measurements-<side>.json` holds the raw runtime probe behind the tables below.

## Measured state (runtime probe, both sides)

| probe | before | after |
|---|---|---|
| no-price row: `.price-unavailable` | absent — the price slot renders as an empty cell | present: glyph `—`, accessible name "Price unavailable", price type size and line height |
| no-price row height @390 | 108px | 119.3px (the placeholder keeps the slot) |
| at-lowest rows (Aurora £48.00, apron £34.00) `.price-meta` | `Lowest £48.00` / `Lowest £34.00` — the line repeats the price | `At lowest` chip, still exactly one `.price-meta` element |
| above-lowest row (kettle £139.50) `.price-meta` | `Lowest £129.50` | `Lowest £129.50` (unchanged) with its delta line |
| guest feed `.price-meta` | absent — the public projection carried no ledger | identical text to the owner feed on the same rows |
| guest detail sheet | no ledger line | `Lowest £20.00`-grammar line (asserted in e2e), no drawn graph |
| share feed `.price-meta` count | 0 | 0 (unchanged; #133 owns share-feed parity) |
| feed thumb `object-fit` / `padding` | `cover` / `0px` | `contain` / `6px`, frame still 72px (96px ≥1024px) |
| item-page hero `object-fit` | `cover` | `contain` |
| kebab centre − thumb centre | 14.00px on every row at 360/390/430/768 (already 0 at 1280) | 0.00px everywhere |
| document horizontal overflow | 0 of 44 captures | 0 of 44 captures |

## Matrices

- `probe-matrix.txt` — the per-row probe values that differ between the sides
  (rows with no differing value are omitted).
- `pixel-matrix.txt` — per-capture differing-pixel count, percentage and bbox.
  Captures are top-aligned onto the taller canvas before diffing; every capture
  keeps the same canvas size on both sides.

## Reproduce

The harness is scratch-only and not committed. Rebuild each side, serve each
with its own `SUGARPLUM_DB_PATH` / `SUGARPLUM_IMAGES_DIR` / port and
`SUGARPLUM_ALLOW_PRIVATE_FETCH=1`, seed the four rows through the API, then
re-run the capture at the widths and colour schemes above. `e2e/app.spec.ts`
test 33 asserts the same contract without pixels: placeholder rhythm and
accessible name, chip-vs-line, kebab-vs-thumb geometry on one-line and wrapped
rows, letterbox fit/pad inside an unchanged frame, guest parity including the
detail sheet, the share placeholder with zero meta lines, and 360/390 overflow.
