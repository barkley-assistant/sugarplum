# screens/127 — evidence captures for sugarplum #127

Throwaway evidence branch (same convention as `screens/121`, `screens/133`,
`screens/113`, `screens/130`). Nothing here is product code; the change lands on
`fix/desktop-nits` as three commits. This branch is never merged.

## What is captured

44 captures per side (1× CSS pixels), covering every changed surface:

| fixture | seed | files | count |
|---|---|---|---|
| Feed row More-actions, desktop popover | one title-only manual item (no scrape) | `menu-popover-<768/1280>-<scheme>.png` | 4 |
| Feed row More-actions, mobile sheet | same | `menu-sheet-<360/390/430>-<scheme>.png` | 6 |
| Item-page More-actions, desktop popover | same | `detail-menu-popover-<768/1280>-<scheme>.png` | 4 |
| Item-page More-actions, mobile sheet | same | `detail-menu-sheet-<360/390/430>-<scheme>.png` | 6 |
| `/add`, untouched | same | `add-pristine-<360/390/430/768/1280>-<scheme>.png` | 10 |
| `/add` with a link typed | same | `add-draft-<360/390/430/768/1280>-<scheme>.png` | 10 |
| The Discard guard | same | `discard-dialog-<390/1280>-<scheme>.png` | 4 |

Widths **360 / 390 / 430 / 768 / 1280**, schemes **light + dark**. The popover
only exists at ≥ 640px and the sheet only below it, so each container is
captured at the widths where it is the real surface. The seed is title-only on
purpose: with no URL the menu inventory is deterministic (no `Copy product
link` row, no fetch-state-dependent `Re-check price` / `Retry fetch` entry),
which is the exact state #127's walkthrough was filed against.

## What changed, read off the live DOM

`measurements.json` (per side) records the runtime probe for every capture:
menu inventory, `.overflow-separator` count, danger-row count, the first row's
and first divider's Y, the form-actions labels, `document.title`, the submit
label, whether the header "Back to list" link is present, the guard dialog's
title and the scrollWidth/clientWidth overflow check. The deltas:

| capture | field | before (`main` @ c74a35a) | after (`fix/desktop-nits`) |
|---|---|---|---|
| `menu-popover-768/1280-*` | dividers | 1 (Delete only) | 2 (purchased cluster + Delete) |
| `menu-sheet-360/390/430-*` | dividers | 2 | 3 |
| `detail-menu-*` | dividers | 1 popover / 2 sheet | unchanged — see below |
| `add-pristine-*` | form actions | `Cancel` | *(none)* |
| `add-draft-*` | form actions | `Cancel` | `Discard` |
| `discard-dialog-390/1280-*` | dialog title | *(none — the exit navigated straight to `/`)* | `Discard this item?`, path stays `/add` |
| all 88 captures | scrollWidth/clientWidth | 0 overflow failures | 0 overflow failures |

Two honest notes about the numbers:

1. **The detail menu's divider count does not move.** Its purchased cluster
   *leads* the menu (the probe item has no URL, so there is no `Copy product
   link` row above it), and the `section` flag draws no divider above the
   menu's first row — a divider there would separate nothing. The plan's D.4
   arithmetic predicted 2 → 3 for the detail menu at 390px, assuming a leading
   divider; the implemented shape suppresses it, so `4f`'s separator pin (2)
   still holds unchanged and test 36 pins the detail menu at 1 (popover) with
   the cluster's own order. The grouping is pinned where it is real: the feed
   row menu, both containers.
2. `discard-dialog-*` on `main` is a capture of the *feed*: on `main` the bare
   `Cancel` navigates immediately, so there is no dialog to photograph. The
   probe records that difference (`dialogTitle: null`, path `/`) — that is the
   before side of the guard.

## How the two sides were produced

- `before/` — clean build of `main` @ `c74a35a` in a detached worktree
  (`scratch/screens-127/main`).
- `after/` — build of `fix/desktop-nits` head `51a109c`.

Both sides ran the same harness (`.hermes/scripts/screens-127.ts`, gitignored
and kept out of the repo): the PROD-mode web bundle, a dev-mode server on a
temp DB + random port with the same bootstrap admin, the same one-item seed
through the real HTTP API, the same viewport list and
`colorScheme`/`reducedMotion` context options. Each side got its own temp DB,
images dir and port, so the columns are directly comparable.
