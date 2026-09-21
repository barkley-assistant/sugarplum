# screens/118 — evidence captures for sugarplum #118

Throwaway evidence branch (same convention as `screens/115`, `screens/114`,
`screens/112`, `screens/92`). Nothing here is product code; the fix lands on
`fix/price-history-caption` (PR).

## What is captured

Three price-history card states plus the anonymous share sheet, at
**360 / 390 / 430 / 768 / 1280** in **light and dark** (1x CSS pixels,
viewport, history card scrolled into view):

| surface | state | files | count |
|---|---|---|---|
| `drawn` | drawn chart, **no derivable trend** (two same-day observations — the #118 state) | `drawn-<theme>-<width>.png` | 10 |
| `signal` | drawn chart with a real signal (three-day series ending at its low → "At 30-day low") | `signal-<theme>-<width>.png` | 10 |
| `empty` | no chart drawn (a single observation) | `empty-<theme>-<width>.png` | 10 |
| `share-drawn` | the same no-trend chart inside the anonymous share sheet, 390 only | `share-drawn-<theme>-390.png` | 2 |

32 captures per side.

## How the two sides were produced

- `before/` — clean `main` @ `dc78424`, built (`SUGARPLUM_DEV=1 bun run
  build:web`) and served on `127.0.0.1:34983` with its own temp database.
- `after/` — `fix/price-history-caption` @ `890fc1b`, served on
  `127.0.0.1:34981` with its own temp database.

Same harness (`capture.mjs`), same bootstrap admin, same seeded items, same
viewport list and colour schemes. Animations are settled before every shot
(all `document.getAnimations()` finished + 250 ms).

Seeds (identical on both sides):

| item | history | why |
|---|---|---|
| `Trendless probe` | 10.00 then a same-day 7.50 (two rows, one calendar day) | `deriveTrend` returns `insufficient` for a same-day pair; the chart still draws |
| `Signal probe` | 9.00 (now) + two backdated rows, 12.00 @ -20d and 11.00 @ -10d, inserted into the temp DB only | a real derived advice, so the regression is visible |
| `Empty probe` | a single 7.25 row | `series.length < 2` → nothing drawable → the empty state |

## Measured state (runtime DOM probe, both sides)

`measurements-before.json` / `measurements-after.json` are the raw probe
output behind this table (caption text, graph presence, empty-state text per
capture):

| state | before (`main` @ dc78424) | after (head @ 890fc1b) |
|---|---|---|
| drawn, no trend | chart drawn + caption **"Not enough history yet"** | chart drawn + caption **"Watching for a trend"** |
| drawn, real signal | chart drawn + "At 30-day low" | chart drawn + "At 30-day low" (unchanged) |
| empty | no chart + "Not enough history yet" | no chart + "Not enough history yet" (unchanged) |
| share sheet, no trend | chart drawn + "Not enough history yet" | chart drawn + "Watching for a trend" |

The `before` column reproduces the issue exactly; the `after` column is the
fix. Every width and both schemes report the same text — the caption is one
string from one helper, so there is no per-width drift to see.

## Diff matrix (`diff-matrix.txt`)

Per-capture differing-pixel counts between the two columns:

| surface | captures | differ | differing pixels | bbox |
|---|---|---|---|---|
| `drawn` | 10 | 10 | 973 each | ~122x12 px band where the caption glyphs sit |
| `share-drawn` | 2 | 2 | 817 / 826 | ~120x12 px caption band |
| `empty` | 10 | 0 | 0 | — |
| `signal` | 10 | 0 | 0 | — |

The empty state and the real-signal caption are **byte-identical** across the
two sides, and the only pixels that move are the caption's own glyphs — the
blast radius of the fix is the caption copy alone (no layout, no chart, no
spacing).

## Reproduce

```
bun capture.mjs <outDir> <port>   # boots the repo's server on a temp DB
python3 diff-matrix.py            # expects before/ and after/ beside it
```
