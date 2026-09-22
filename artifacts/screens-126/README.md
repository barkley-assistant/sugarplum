# screens/126 — evidence captures for sugarplum #126

Throwaway evidence branch (same convention as `screens/112`, `screens/114`).
Nothing here is product code; the fix lands on `feat/detail-spacing` (PR).

## What is captured

The two detail surfaces that share the changed `.detail-*` classes — the OWNER
item page and the GUEST detail sheet (other-user wishlist) / anonymous share
sheet — at **360 / 390 / 430 / 768 / 1280** in **light and dark** (1x CSS
pixels, full page):

| surface | files | count |
|---|---|---|
| owner item page, full item (`Detail probe`: url, notes, tags, price history) | `owner-full-<theme>-<width>.png` | 10 |
| owner item page, manual no-url item (`Manual probe`) | `owner-manual-<theme>-<width>.png` | 10 |
| guest detail sheet, other-user wishlist (`Peer probe`) | `peer-sheet-<theme>-<width>.png` | 10 |
| anonymous share sheet (`Detail probe` through a share link) | `share-sheet-<theme>-<width>.png` | 10 |

40 captures per side.

## How the two sides were produced

- `before/` — a clean build of `main` @ `3dfd788` (the #126 change not applied),
  served on `127.0.0.1:34972` with its own database.
- `after/` — a build of `feat/detail-spacing` head, served on `127.0.0.1:34971`
  with its own database.

Both runs used the same harness, the same bootstrap admin, the same seeded
surfaces (created through the real API: `POST /api/auth/login`,
`POST /api/users`, `POST /api/wishlist/items`, `PATCH` for the second price
observation, `POST /api/share`), the same viewport list, colour schemes and
settle step (fonts ready + 300 ms, `prefers-reduced-motion: reduce`), so the two
columns are directly comparable. For the sheet surfaces the viewport grows only
in HEIGHT when the 90dvh sheet would clip — the width under test is exact.
`_measurements-<side>.json` holds the raw runtime probe behind the table below.

## Measured state (runtime probe, both sides)

Identical on all 40 rows:

| probe | before | after |
|---|---|---|
| `.detail-scroll` computed `gap` | `7px` | `16px` |
| `.detail-card` computed `padding` | `14px 16px` | `16px` |
| `.detail-hero-info` computed `gap` | `4px` | `8px` |
| `.detail-actions` computed `gap` | `10px` | `12px` |
| `.detail-more-card > .detail-card-heading` `margin-bottom` | `4px` | `8px` |
| `a.detail-open-btn` count | 1 (0 on the no-url item) | unchanged |
| links whose text starts `View on` | **1** | **0** |
| document horizontal overflow | false | false |
| sheet inner scroll clip (px) | 0 | 0 |
| rendered section-to-section gaps | `7,7,6,7,7,7` | `16,16,15,16,16,16` |

The rendered gaps are the flex `gap` rounded per section boundary (15px where a
fractional offset rounds down); the 4px→8px / 10px→12px / 4px→8px moves are the
hero stack, the CTA pair and the more-card heading step.

Element-clip probe: the only entries are the pre-existing `.visually-hidden`
utility nodes (and one SVG at ≥768px) — **identical sets before and after**, so
the pass introduced no new clipping.

## Diff matrix (`diff-matrix.txt`)

Per-capture differing-pixel counts between the two columns. `fullPage` captures
grow when the rhythm loosens, so both sides are padded to the taller canvas
(top-aligned, page background) before diffing; the height change is reported per
row.

- **owner-full**: +41 to +46px taller (the 16px section step, the 16px card
  padding and the 8px hero stack); the diff bbox runs from the hero stack down
  through the footer, and at ≥430px includes the top of the page (the header
  offset shifts by the card/hero growth above the fold).
- **owner-manual / peer-sheet**: same canvas height, diffs confined to the
  content band (y 157-822 on the manual page; y 227-833 on the mobile sheets,
  y 52-600 in the desktop drawer).
- **share-sheet**: +30 to +47px taller, diff confined to the sheet band.

Every capture in the matrix shows the same two changes: one external CTA in the
hero and a "More information" card without the duplicated retailer row.

## Reproduce

The harness is scratch-only and not committed; the two sides are reproducible
from this README by rebuilding each side (`main` @ `3dfd788` and
`feat/detail-spacing`), serving each with its own `SUGARPLUM_DB_PATH`/port,
seeding the four surfaces through the API and re-running the capture at the
widths and colour schemes above. The e2e spec (`e2e/app.spec.ts` tests 4d, 15f,
27) asserts the same contract without pixels.
