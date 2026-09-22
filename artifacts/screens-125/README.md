# screens/125 — evidence captures for sugarplum #125

Throwaway evidence branch (same convention as `screens/127`, `screens/133`,
`screens/121`, `screens/130`). Nothing here is product code; the change lands on
`feat/desktop-header-consistency` as two commits. This branch is never merged.

## What is captured

**70 captures per side** — 7 surfaces × widths 360/390/430/768/1280 × light +
dark, 1× CSS pixels:

| surface | path | seed |
|---|---|---|
| feed | `/` | 4 admin items (one marked purchased), 2 items for the second user |
| item view | `/items/:id` | first admin item (price, notes, tags) |
| add | `/add` | same |
| edit | `/items/:id/edit` | same |
| settings | `/settings` | admin, user-management opt-in ON |
| settings users | `/settings/users` | same |
| settings new user | `/settings/users/new` | same |

Both sides run against the **same seeded SQLite database** (a copy for the
before side), so every difference below is the change, not the data. The two
users are `Admin` (4 items) and `Rowan` (2 items) — the second list is what the
context bar's switcher offers.

- `before/` = `main` @ e891c11, built in a worktree and served on its own port.
- `after/` = `feat/desktop-header-consistency` @ 5ed91cc — the branch head the
  capture run used. The commit after it (`ca3865f`) is test-only (a spec 24
  de-flake), so no capture here is stale.

`measurements.json` (per side) records the runtime probe for every capture:
topbar height, cluster visibility + button inventory, Back-to-list presence,
the compact bar's trigger/count text, the full heading ladder, the
scrollWidth/clientWidth overflow check and the unclipped offender count.

## What changed, read off the live DOM

| capture | field | before | after |
|---|---|---|---|
| feed, all widths | cluster / bar / topbar height | `Add item + Share my list`, no bar, 67/66px | **identical** (feed untouched) |
| item view @≥768 | cluster | *(none — bare topbar)* | `Back to list + Add item + Share my list` |
| item view, all widths | compact bar | *(none)* | `Admin's wishlist / 4 items` |
| item view, all widths | topbar height | 52px | 67px (360–768) / 66px (1280) |
| `/add` @≥768 | cluster | *(none)* | `Share my list` only (Add suppressed, D3) |
| edit / settings / settings-users / settings-user-new @≥768 | cluster | *(none)* | `Add item + Share my list` |
| every non-feed surface, all widths | compact bar | *(none)* | `Admin's wishlist / 4 items` |
| all 70 captures, both sides | overflow / offenders | 0 / 0 | 0 / 0 |

60 of the 70 captures differ; the 10 feed captures are probe-identical, which is
the "the feed does not move" claim (issue scope line).

Heading ladders after (light, 1280 — identical at 360):

```
/                    h1:sugarplum > h2:Admin's wishlist > h3:<items>
/items/:id           h1:sugarplum > h2:Admin's wishlist > h2:<item> > h3:Price history|Notes|Tags|More information
/add                 h1:sugarplum > h1:Add item > h2:Admin's wishlist
/items/:id/edit      h1:sugarplum > h1:Edit item > h2:Admin's wishlist
/settings            h1:sugarplum > h2:Account & Preferences > h2:Admin's wishlist > h3:Account|Change password|Preferences
/settings/users      h1:sugarplum > h2:Users > h2:Admin's wishlist
/settings/users/new  h1:sugarplum > h2:New user > h2:Admin's wishlist
```

No level is skipped on any surface (`settings.spec` test 10's rule), which is
why the compact bar is an `h2` rather than the plan's `h3` — see deviation 1 in
the PR body.

## Known limits of this evidence

The capture session had no working vision provider (401), so no capture was
looked at pixel-by-pixel. The visual claims rest on the per-capture runtime
probe above plus a separate geometry probe on the live DOM (item view 768/1280,
`/settings` 1280, `/add` 1280): the cluster sits inside the topbar's right edge
without touching the brand, the Back-to-list chip is 94×44 at the cluster's
left, and the context bar's top is at/below the topbar's bottom on every one of
them. The full serial e2e suite (90 tests, including the #116 geometry pin 28
and the 360px overflow sweep in 4e) is the behavioural evidence.
