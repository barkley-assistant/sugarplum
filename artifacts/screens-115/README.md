# screens/115 — evidence captures for sugarplum #115

Throwaway evidence branch (same convention as `screens/114`, `screens/112`,
`screens/92`). Nothing here is product code; the fix lands on
`fix/danger-button-contrast` (PR).

## What is captured

Every surface that renders a danger affordance, at **360 / 390 / 430 / 768 /
1280** in **light and dark** (1x CSS pixels, viewport):

| surface | what is hovered | files | count |
|---|---|---|---|
| `menu` | feed row kebab → the danger **Delete** row (`.menu-item-danger`) | `menu-<state>-<theme>-<width>.png` | 14 |
| `confirm` | row Delete → the confirm **Delete** button (`button.danger`) | `confirm-<state>-<theme>-<width>.png` | 14 |
| `share` | share popover/sheet → **Revoke link** (`button.danger`) | `share-<state>-<theme>-<width>.png` | 14 |
| `admin` | /settings/users row → **Delete** (`button.danger`) | `admin-<state>-<theme>-<width>.png` | 14 |

56 captures per side. `state=hover` for all five widths (40 per side, the
state the fix changes); `state=rest` additionally at 390 and 1280 (16 per
side) so the untouched rest state is on record too. Below 640px the overflow
menu and the share panel render as bottom sheets, so the mobile widths capture
the same classes on the sheet surface.

## How the two sides were produced

- `before/` — clean `main` @ `a1a6b00`, built (`SUGARPLUM_DEV=0 bun run
  build:web`) and served on `127.0.0.1:34974` with its own temp database.
- `after/` — `fix/danger-button-contrast` @ `7dd1543`, served on
  `127.0.0.1:34973` with its own temp database.

Same harness, same bootstrap admin, same seeded item (`Danger probe`,
12.00 GBP), same live share link, same throwaway admin user
(`danger-probe-guest`), same viewport list and colour schemes. Before every
shot the page's animations are settled (all `document.getAnimations()`
finished + 250 ms), so no capture is a mid-transition frame.
`measurements.json` is the raw runtime probe behind the tables below.

## Measured state (runtime probe, both sides)

Label colour / first opaque background behind it / WCAG ratio, hovered:

| surface | scheme | before | after |
|---|---|---|---|
| menu, confirm, share, admin (all four) | light | `rgb(220, 38, 38)` on `rgb(254, 242, 242)` — **4.415:1** | `rgb(185, 28, 28)` on `rgb(254, 242, 242)` — **5.915:1** |
| menu, confirm, share, admin (all four) | dark | `rgb(248, 113, 113)` on `rgb(43, 21, 23)` — 6.211:1 | `rgb(252, 165, 165)` on `rgb(43, 21, 23)` — **9.052:1** |

Rest state (unchanged by this fix, identical in both columns): light
`rgb(220, 38, 38)` on `rgb(255, 255, 255)` — 4.829:1; dark
`rgb(248, 113, 113)` on `rgb(27, 22, 35)` — 6.403:1, and on the mobile
overflow sheet's `--surface-3` (`rgb(36, 27, 49)`) — 5.949:1.

The before column reproduces the issue exactly (4.41:1 light on hover); the
after column clears AA on every surface at every width in both schemes. All 40
hover captures report the same pair per scheme — the fix is one token pair
consumed by the two hover rules, so there is no per-surface drift to see.

## Diff matrix (`diff-matrix.txt`)

Per-capture differing-pixel counts between the two columns:

- **All 40 hover captures differ only in the label glyphs** — bounding boxes
  of 300–1200 px over a 10–70 px-wide band (e.g. `confirm-hover-light-390`:
  302 px inside `(287, 449, 332, 461)`, the six glyphs of "Delete"). No other
  pixel of the frame moves: the hover tint, the border, the layout and the
  surrounding chrome are byte-identical.
- **Rest captures are byte-identical** except two harness artefacts, both
  outside the fix:
  - `share-rest-*`: 180–468 px inside the share-link `<input>` — the link
    URL/token text, which is a different random token (and port) on each side
    by construction.
  - `admin-rest-dark-390`: 20 px, all on the left/right edge columns of the
    narrow admin card (x 16–17 and 371–373, y 220–225), each differing by ±1
    in a single channel — sub-pixel edge anti-aliasing of the horizontally
    scrolled table, not a colour change.

## Reproduce

The harness is a throwaway script (kept out of the repo): boot the server on a
temp DB, seed one item + one share link + one throwaway user, then for each
surface/width/theme open the overlay, hover the danger control, settle and
screenshot; `bun run test:e2e`'s test 30 asserts the same pairs on every run.
