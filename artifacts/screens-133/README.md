# screens/133 — evidence captures for sugarplum #133

Throwaway evidence branch (same convention as `screens/113`, `screens/130`,
`screens/126`, `screens/119`, `screens/102`). Nothing here is product code; the
change lands on `feat/guest-share-view` as a single commit. This branch is never
merged.

## What is captured

The ONLY changed surface is the anonymous share view (`SharePage.tsx`) plus one
string and one CSS rule. 23 captures per side (1x CSS pixels, full page):

| fixture | seed | files | count |
|---|---|---|---|
| Guest feed | three rows — no price, at its lowest (with a product URL), raised above its lowest | `feed-<width>-<scheme>.png` | 10 |
| Row menu OPEN — bottom Sheet (< 640px) | the at-lowest row's ⋮ | `menu-sheet-<width>-<scheme>.png` | 6 |
| Row menu OPEN — anchored popover (>= 640px) | the at-lowest row's ⋮ | `menu-popover-<width>-<scheme>.png` | 4 |
| The owner's own copy | same seed, `viewerIsOwner` | `owner-<width>-light.png` | 2 |
| Empty list (guest) | a second user with no items | `empty-390-light.png` | 1 |

Widths **360 / 390 / 430 / 768 / 1280**, schemes **light + dark**
(the menu kind is the width's real one: Sheet below 640px, popover above).
All captures are anonymous (logged-out) except the two `owner-*` ones.

## How the two sides were produced

- `before/` — clean build of `main` @ `0dbbe7d` (detached worktree).
- `after/` — build of `feat/guest-share-view` head.

Both sides ran the same harness (`capture.ts`, kept out of the repo): the
PROD-mode web bundle, a dev-mode server on a temp DB + random port with the same
bootstrap admin, the same seeding through the real HTTP API, the same viewport
list, the same `colorScheme`/`reducedMotion` context options. Each side got its
own temp DB, images dir and port, so the two columns are directly comparable and
no cache or database state is shared.

`before/measurements.json` and `after/measurements.json` are the raw runtime
probe behind the tables below (`probe-matrix.txt` is the diff of the two).

## Measured state (runtime probe, both sides)

| probe | before | after |
|---|---|---|
| `.share-tagline` lines | 1 (`Private wishlists, shared with people you trust.`) | **0** |
| `.share-note` lines | 1 (`Shared list — no account needed`) | 1 (unchanged) |
| sign-in hook | absent | `Sign in to create your own wishlist` → `href="/login?next=/"`, below the list, 6.81:1 light / 6.94:1 dark (AA needs 4.5:1) |
| hook in the topbar | — | `false` (page content, not account chrome) |
| at-lowest row price meta | `[]` | `["At lowest"]` (the `#130` chip) |
| above-lowest row price meta | `[]` | `["Lowest £25.00"]` |
| no-price row | dash placeholder, no meta | unchanged (dash placeholder, no meta) |
| `.price-delta` on share rows | 0 | 0 (the delta line stays owner-side) |
| row ⋮ menu (Sheet, < 640px) | `["Mark as purchased", "Cancel"]` | `["Open product", "Copy link", "Mark as purchased", "Cancel"]` |
| row ⋮ menu (popover, >= 640px) | `["Mark as purchased"]` | `["Open product", "Copy link", "Mark as purchased"]` |
| rows still carrying the ⋮ | 3 of 3 | 3 of 3 (the trigger is unchanged) |
| owner's own copy | no hook, `You are viewing your own shared list.`, no ⋮ | identical (no hook, note, no ⋮) |
| empty list | no hook | hook present |
| document horizontal overflow | `false` on all 23 | `false` on all 23 |

## Pixel matrix

`pixel-matrix.txt` — per-capture differing-pixel count, percentage and bbox
(images are top-aligned onto the overlapping canvas before diffing).

Every capture differs, because the changed surfaces sit on every capture: the
header band (one tagline line out), the price line of at least one row, and the
page-end hook. The diff stays inside those bands; the row geometry, the thumbs,
the topbar and the widths are untouched:

| capture | Δh | differing | bbox |
|---|---|---|---|
| `feed-360-light` | 0 | 10.05% | y 165-568 (the header band, two price lines, the hook) |
| `feed-390-light` | 0 | 9.32% | y 165-568 |
| `feed-430-light` | 0 | 8.51% | y 165-568 |
| `feed-768-light` | 0 | 4.94% | y 165-568 |
| `feed-1280-light` | 0 | 3.37% | y 165-573 |
| `menu-sheet-390-light` | 0 | 20.16% | x 0-389, y 165-776 (menu rows + scrim + price/hook bands) |
| `menu-popover-1280-light` | 0 | 10.76% | y 165-585 (popover rows) |
| `owner-390-light` | 0 | 8.85% | y 223-613 (no hook, no menu: header + price bands only) |
| `empty-390-light` | 0 | 2.44% | y 199-328 (one line out, one line in) |

Dark captures match their light counterparts within 0.3 points
(e.g. `feed-390-dark` 9.44% vs 9.32%). No capture changes width, and
`scrollWidth == clientWidth` on both sides at every width.

## OCR — an independent read of the rendered pixels

`ocr.txt` (tesseract, `--psm 4`) reads the same eight capture pairs the table
above describes. The key lines, verbatim:

- `before/feed-390-light` → `Shared list — no account needed` **and**
  `Private wishlists, shared with people you trust.`, then `£25.00` / `£30.00`
  with no meta, and no line after the rows.
- `after/feed-390-light` → `Shared list — no account needed`, **no** marketing
  line, `£25.00 At lowest`, `£30.00 Lowest £25.00`, and
  `Sign in to create your own wishlist` as the last line of the page.
- `before/menu-sheet-390-light` → `Mark as purchased` alone.
- `after/menu-sheet-390-light` / `after/menu-popover-1280-light` →
  `Open product`, `Copy link`, `Mark as purchased`.
- `before/owner-390-light` → two taglines and no hook;
  `after/owner-390-light` → one tagline, `At lowest`, `Lowest £25.00`, **no
  hook** (the `viewerIsOwner` gate).
- `before/empty-390-light` → two taglines; `after/empty-390-light` → one
  tagline **and the hook still present on an empty list**.

Same reads in dark (the scheme only moves the palette).

## Contrast

The hook keeps the app's standard link colour (`--plum-600`, remapped in dark);
it is muted copy, not a new link treatment. Measured against its painted
background on the real captures: **6.81:1 light / 6.94:1 dark** — the same
numbers spec 35 asserts at >= 4.5:1.
