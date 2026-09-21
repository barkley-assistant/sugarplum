# screens/114 — evidence captures for sugarplum #114

Throwaway evidence branch (the same convention as `screens/112`, `screens/92`).
Nothing here is product code; the fix lands on `fix/currency-other-code` (PR).

## What is captured

The **edit form** of an item whose stored currency is *not* in the preset list
(GBP/USD/EUR) — the defect surface — at **360 / 390 / 430 / 768 / 1280** in
**light and dark** (1x CSS pixels, full page):

| surface | files | count |
|---|---|---|
| edit form, `Seeded SEK item` (349.00 SEK) — the fix | `edit-sek-<theme>-<width>.png` | 10 |
| edit form, `Preset GBP item` (12.34 GBP) — regression spot | `edit-gbp-<theme>-{390,1280}.png` | 4 |
| `/add`, manual disclosure open, Other picked — regression spot | `add-other-<theme>-390.png` | 2 |

16 captures per side.

## How the two sides were produced

- `before/` — a clean build of `main` @ `031fc34` (the `ItemForm.tsx` change
  stashed), served on `127.0.0.1:34997` with its own database.
- `after/` — a build of `fix/currency-other-code` head, served on
  `127.0.0.1:34998` with its own database.

Both runs used the same harness, the same bootstrap admin, the same two seeded
items (created through `POST /api/wishlist/items`), the same viewport list and
colour schemes, and the same settle step (page animations finished + 250 ms)
before each shot — so the two columns are directly comparable. `measurements.json`
is the raw runtime probe behind the table below.

## Measured state (runtime probe, both sides)

| capture | before: select / code visible / code value / fields | after |
|---|---|---|
| `edit-sek-*` @ 360/390/430/768/1280 | `Other` / **false** / `null` / 3 | `Other` / **true** / **`SEK`** / 4 |
| `edit-gbp-*` @ 390/1280 | `GBP` / false / `null` / 3 | unchanged |
| `add-other-390` | `Other` / true / `""` / 4 | unchanged |

The issue's own probe was `selectValue: "Other"`, `codeVisible: 0`,
`codeValue: null` — the before column reproduces it exactly; the after column
inverts it. `docOverflow` is `false` on every capture on both sides.

Field widths inside the title/price/currency row (the #97 grammar):

| width | before | after |
|---|---|---|
| 360 / 390 / 430 | title spans the row; price = currency (158/173/193) | + code input spanning the row (328/358/398) |
| 768 | 356 / 178 / 178 | 280 / 140 / 140 / 140 |
| 1280 | 348 / 174 / 174 | 274 / 137 / 137 / 137 |

i.e. the 4-field state reached **by data** renders exactly the shape e2e test 24
pins when the same 4th field is opened by hand.

## Diff matrix (`diff-matrix.txt`)

Per-capture differing-pixel counts between the two columns:

- all 4 **GBP** captures and both **/add** captures: **0 differing pixels**
  (the preset path and the add flow are byte-identical);
- **SEK desktop** (768/1280, both themes): 6.6k–6.7k px, all inside the row band
  `y 203–268` — Title gives up its 2:1:1 share for the 2:1:1:1 grammar and the
  code field appears;
- **SEK mobile** (360/390/430, both themes): 42.9k–49.3k px from `y 365` down —
  the code field takes its own full-width row, so the fields below it move down;
  no capture overflows horizontally.

## Reproduce

The harness is scratch-only and not committed; the two sides are reproducible
from this branch's README by rebuilding each side, serving it with its own
`SUGARPLUM_DB_PATH`/port, seeding the two items and re-running the capture at
the widths above. The e2e spec (`e2e/app.spec.ts` test 29) asserts the same
round-trip without pixels.
