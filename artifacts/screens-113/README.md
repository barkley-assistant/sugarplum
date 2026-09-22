# screens/113 — evidence captures for sugarplum #113

Throwaway evidence branch (same convention as `screens/130`, `screens/126`,
`screens/119`). Nothing here is product code; the change lands on
`feat/cheaper-link-detail` as commit `d8a023f`.

## What is captured

The ONLY changed surface is the owner item page (`ItemPage.tsx`). 30 captures
per side (1x CSS pixels, full-page frames):

| fixture | rows | files | count |
|---|---|---|---|
| `cheaper-full` | scraped item (real thumbnail, site name, price ledger) + saved `cheaperUrl` + notes + tags — the full card | `cheaper-full-<width>-<scheme>.png` | 10 |
| `cheaper-manual` | manual item, **no product url**, saved `cheaperUrl` — cheaper row under the single-CTA hero | `cheaper-manual-<width>-<scheme>.png` | 10 |
| `no-cheaper` | scraped item, **no** `cheaperUrl` — the pre-#113 shape (regression baseline) | `no-cheaper-<width>-<scheme>.png` | 10 |

Widths **360 / 390 / 430 / 768 / 1280**, schemes **light + dark**.

## How the two sides were produced

- `before/` — clean build of `main` @ `2f85ba3`.
- `after/` — build of `feat/cheaper-link-detail` head `d8a023f`.

Both sides ran the same harness, the same bootstrap admin, the same fixture
server (a local HTTP server serving the seeded product page + a real 480x320
PNG thumbnail), the same three fixtures seeded through the real API, the same
viewport list and the same `emulateMedia({ colorScheme })` step. Each side got
its own temp DB, images dir and port, so the two columns are directly
comparable and no cache or database state is shared.

`_measurements-*.json` is inside `before/measurements.json` and
`after/measurements.json`: the raw runtime probe (per capture) behind the
tables below.

## Measured state (runtime probe, both sides)

| probe | before | after |
|---|---|---|
| `.detail-more-card` children | `[heading, hints]` | `[heading, detail-row, hints]` |
| cheaper row present | absent on all 30 captures | present on the 20 captures that have a saved link; absent on the 10 `no-cheaper` ones |
| row label | — | `Found it cheaper at elsewhere.example.com` / `… at supplies.example.net` |
| row `href` | — | the saved URL verbatim (`https://elsewhere.example.com/cheaper-apron`) |
| row handoff attrs (`tag` / `target` / `rel` / `referrerpolicy`) | — | `A` / `_blank` / `noopener noreferrer` / `no-referrer` |
| row anatomy (svg count / trailing chevron last) | — | 2 svg (leading external-link + trailing chevron), trailing = last child |
| row height | — | 44px (one line) at 768 / 1280; 65px (label wraps to two lines) at 360 / 390 / 430 |
| row `min-height` / divider | — | `44px` (the #116 touch floor) / 1px `border-top` |
| row ABOVE the hints toggle | — | `true` on all 20 (row bottom <= toggle top) |
| `.detail-more-card` height | 106px | 150px (one line) / 171px (wrapped) |
| document horizontal overflow | 0 of 30 | 0 of 30 |

## Pixel matrix

`pixel-matrix.txt` — per-capture differing-pixel count, percentage and bbox.
Captures are top-aligned onto the overlapping canvas before diffing.

- `no-cheaper-*` (10 captures, both schemes, all five widths): **0 differing
  pixels** — byte-for-byte identical rendering when the field is unset, i.e.
  nothing regressed for items without a saved cheaper link.
- `cheaper-full-*` / `cheaper-manual-*` (20 captures): the diff is confined to
  the More information card band (`y 489–908`, `x 16–999` depending on width,
  never the full width of the page) and the page grows by exactly the new row
  (`Δh 41px` at 768/1280, `Δh 65px` at 360/390/430 where the label wraps).

## Independent render checks (not pixel-diff)

- **OCR (tesseract, `--psm 6`) on the after captures** reads
  `More information` → `Found it cheaper at elsewhereexam…` → (toggle) in both
  schemes at 390, and reads no such line in `before/` or in `after/no-cheaper`.
- **WCAG contrast of the new row** (same algorithm as e2e spec 12, measured at
  390): label `17.72:1` light (`rgb(24,24,27)` on white) / `16.36:1` dark
  (`rgb(247,245,250)` on `rgb(27,22,35)`); trailing chevron `5.28:1` /
  `5.69:1`. The 1px divider measures `1.27:1` / `1.19:1` — it is the shared
  `--border` token every `.detail-row` / hints-toggle divider already uses
  (decorative separator, unchanged by this ticket).

## What the row is (and is not)

The row reuses the pre-#126 "View on" `.detail-row` anatomy verbatim: leading
external-link icon, label, trailing chevron, 44px floor, divider above the
hints toggle. Its label colour is the standard row text colour (`--text`, not
the plum link colour): it reads as a tappable *row*, exactly like the "Check
prices elsewhere" disclosure it sits above, rather than as a third hero CTA.
The hero keeps exactly one `Open product` (`asserted in e2e 34`), and the
saved link is a **different** href.

Owner-only: the guest projections (`PublicItem`, `ShareItem`, both guest
detail sheets) never carry `cheaperUrl`, and e2e 34 probes the absence at the
RENDER level on both guest surfaces (other-user sheet and anonymous share
sheet) as well as the wire-level tests that already pinned the split.

## Reproduce

The harness is scratch-only and not committed. It boots the real server on a
temp DB (`SUGARPLUM_DEV=1`, temp `SUGARPLUM_DB_PATH` / `SUGARPLUM_IMAGES_DIR`,
random port, `SUGARPLUM_ALLOW_PRIVATE_FETCH=1`), seeds the three fixtures
through the API, then screenshots `/items/:id` at the widths and colour
schemes above. Rebuild each side first
(`SUGARPLUM_DEV=1 bun run build:web`), because the server serves `dist/public`.

`e2e/app.spec.ts` test 34 asserts the same contract without pixels: the row's
label + href, the #102 handoff attributes, row order above the hints toggle,
absence when the field is unset, the edit-form clear/re-set round trip,
360/390/430 no-overflow, a long-host wrap, and render-level absence on both
guest surfaces.
