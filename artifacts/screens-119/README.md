# screens/119 — evidence captures for sugarplum #119

Throwaway evidence branch (same convention as `screens/118`, `screens/115`,
`screens/114`, `screens/112`, `screens/92`). Nothing here is product code; the
fix lands on `fix/thumbnail-slot` (PR).

## What is captured

19 captures per side — the three `ProductRow` surfaces plus reorder mode:

| surface | widths | schemes | files |
|---|---|---|---|
| owner feed | 360 / 390 / 430 / 768 / 1280 | light + dark | `owner-<theme>-<width>.png` |
| guest (other-user) feed | 390 / 1280 | light + dark | `guest-<theme>-<width>.png` |
| anonymous share view | 390 / 1280 | light + dark | `share-<theme>-<width>.png` |
| reorder mode (owner) | 390 | light | `reorder-light-390.png` |

The list is deliberately **mixed** — that is the bug: a bare row next to an
imaged row. Seeds (identical on both sides):

| item | state | why |
|---|---|---|
| `Running socks` | scrape failed (`fetchState: "failed"`, no image) | the issue's own failed row |
| `Fresh Kiss Trio` | scraped from the repo's og:meta fixture with a real, decodable JPEG | the indented row |
| `Manual mug`, `Desk lamp` | manual adds (`fetchState: "complete"`, no image) | "never had an image" |

## How the two sides were produced

- `before/` — clean `main` @ `03b2b3c` (the three source files stashed),
  built `SUGARPLUM_DEV=0 bun run build:web`, own temp DB, own port.
- `after/` — `fix/thumbnail-slot` @ `208b1a3`, own temp DB, own port.

Same harness (`capture.mjs`), same bootstrap admin, same seeds, same viewport
list, same colour schemes, animations settled before every shot (all
`document.getAnimations()` finished + 250 ms). The harness picks a free port and
refuses to run against a port that already serves a healthy app, so a stale
listener can never serve a capture.

## Measured state (runtime DOM probe, both sides)

`measurements-before.json` / `measurements-after.json` are the raw probe output
behind this table (per row: frame kind, frame box, title x). `x` is the title
column's `getBoundingClientRect().left`; "spread" is max − min across the rows:

| surface | width | before (title x) | after (title x) | spread before → after |
|---|---|---|---|---|
| owner feed | 360 / 390 / 430 / 768 | bare rows `40`, imaged row `112` | every row `112` | 72px → **0** |
| owner feed | 1280 | bare rows `150`, imaged row `246` | every row `246` | 96px → **0** |
| reorder mode | 390 | bare rows `96`, imaged row `168` | every row `168` | 72px → **0** |
| guest feed | 390 / 1280 | `40` vs `112` / `150` vs `246` | all equal | 72 / 96px → **0** |
| share view | 390 / 1280 | `40` vs `112` / `150` vs `246` | all equal | 72 / 96px → **0** |

Frame boxes after the fix: the imaged row `.product-img` and every bare row
`.product-img-fallback` are 72×72 (mobile) and 96×96 (≥1024px) — the same token,
so the column is reserved rather than empty. Before the fix the bare rows have
**no frame element at all** (`frame: null`), which is why the column collapsed.

`docOverflow` is `false` on all 38 captures (no horizontal page overflow at any
width, both sides) — the fixed 72/96px track does not push a 360px row over.

## Diff matrix (`diff-matrix.txt`)

Per-capture differing-pixel counts between the two columns:

| surface | captures | differ | differing pixels |
|---|---|---|---|
| `owner` | 10 | 10 | 34,338 – 58,591 |
| `guest` | 4 | 4 | 33,407 – 74,653 |
| `share` | 4 | 4 | 30,761 – 54,767 |
| `reorder` | 1 | 1 | 37,061 |

Every diff bounding box starts *below* the first row (`y ≥ 177`) and spans the
row's own width: no pixel changes in the header, the heading, the filter chips
or the bottom bar, and on the 1280 captures the shift reaches the price/actions
column exactly as a 96px re-indent of the row content should. The change is the
row block, not the page.

`top-band-check.py` measures that directly: the top 170px of all 19 captures
(header, heading, chip band) are **byte-identical** between the two columns
(`above-170px-changed=0`, bbox `None`), and no diff bbox reaches the bottom bar.

## Reproduce

```
bun capture.mjs <outDir> [port]   # builds the working tree, boots it on a temp DB
python3 diff-matrix.py            # expects before/ and after/ beside it
python3 top-band-check.py         # the "nothing above the rows moved" check
```
