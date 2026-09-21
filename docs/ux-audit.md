# UX audit — full product pass

> Tracked in issue #92. Audited at `main @ 5138f0d` on 2026-09-21. Method: a seeded
> state matrix on a throwaway temp-DB server, both colour schemes, 390/1280 with
> 360/768/1024 spot checks, Playwright-driven captures plus targeted runtime probes
> (DOM measurement, API response inspection, keyboard walks).
>
> Severity: **High** = a flow is broken or blocked; **Medium** = friction, misleading
> feedback or a trust-eroding inconsistency; **Low** = polish, copy or guidance. The
> `accessibility` label is orthogonal to severity.
>
> Every finding below is filed as its own issue — see the findings index in section 2
> and the filing manifest in section 6. Screenshots referenced as `screens/92:<file>`
> live on the throwaway evidence branch in
> `artifacts/screens-92/` and resolve at
> `https://raw.githubusercontent.com/barkley-assistant/sugarplum/screens/92/artifacts/screens-92/<file>`.

## 1. Scope and method

### 1.1 Surfaces covered

| # | Surface | Route / trigger |
|---|---|---|
| S1 | Feed — own list | `/` |
| S2 | Feed — another user's list | list switcher |
| S3 | Mobile bottom action bar | every authenticated route < 640px |
| S4 | Desktop top bar | ≥ 640px |
| S5 | Add | `/add`, plus the share-target prefill |
| S6 | Item detail — owner | `/items/:id` |
| S7 | Edit | `/items/:id/edit` |
| S8 | Guest detail sheet | another user's row |
| S9 | Anonymous share view | `/share/:token` |
| S10 | Share management | share popover ≥ 640px / sheet < 640px |
| S11 | Settings — Account & Preferences | `/settings` |
| S12 | Settings — Users (admin, opt-in) | `/settings/users` |
| S13 | Settings — New user (admin, opt-in) | `/settings/users/new` |
| S14 | Login | `/login` |
| S15 | Cross-cutting chrome | toasts, confirms, skeletons, empty states, offline shell, reduced motion |

### 1.2 Seeded state matrix

Everything was created through public API seams on a temp DB; the audit never writes
SQL. Personas are neutral (`admin` bootstrap plus members `robin` and `casey`).

Complete item with image · pending enrichment · failed enrichment · owner-marked
purchased · share-marked purchased (anonymous) · claimed by another user · claimed by
you · recorded price history with delta · non-preset currency (SEK via *Other*) · two
tags on different items · notes · saved "found it cheaper at" link · empty own list ·
empty filtered state · revoked share token · inactive user.

### 1.3 How the walkthrough was run

* A throwaway harness (`.hermes/ux-audit/`, gitignored — never part of the product)
  boots the real server with `SUGARPLUM_DEV=1` on a temp DB and a production web
  bundle, exactly as the e2e global setup does, and seeds the matrix above over HTTP.
* 122 sweep captures (S1–S15 × 390/1280 × light/dark, plus 360 for the bottom bar
  and share sheet, 768/1024 for the desktop share popover) and 46 focused captures
  (hover states, confirm dialogs, offline toasts, reduced motion, filtered-empty,
  reorder mode, skeletons) — 139 distinct frames on the evidence branch.
* Universal instrumentation ran on every frame: document overflow and individually
  escaping elements, computed-colour contrast for every text-bearing node, control
  hit-area measurement, accessible-name checks, `alt` presence, running animations,
  console errors and failed requests, and `/api/auth/me` call counting.
* Targeted probes covered what a frame cannot: keyboard tab order and focus return,
  Escape/outside-click dismissal, Enter on a confirm (activation count), manual
  ordering persistence, filter-under-order behaviour, drag reorder persistence,
  offline mutation copy, offline deep-link rendering, share-target prefill through
  the login hop, the share rate-limit copy, and the privacy invariants (section 4).
* The mockup comparison used `docs/amethyst-mockups/` as the reference bar (S1/S6).

### 1.4 What this audit did not cover

* Chromium only — Firefox/WebKit were not exercised.
* Scraping behaviour itself (the eBay bot-wall / site-override domain) is tracked
  separately in #103 and was not re-audited; only the app's surfacing of scrape
  results (pending/failed/hint states) was.
* The external-link handoff question in #102 was not re-litigated; link markup was
  checked (`<a target="_blank" rel="noreferrer">` at every product link).
* The deployed site. The audit judges `main @ 5138f0d`; the deployment may be ahead.

## 2. Findings index

| Issue | Surface | Severity | Type | Finding |
|---|---|---|---|---|
| [#112](https://github.com/barkley-assistant/sugarplum/issues/112) | S5 Add | Medium | bug + accessibility | "Add details manually" turns violet on hover and becomes unreadable (1.16:1 light) |
| [#113](https://github.com/barkley-assistant/sugarplum/issues/113) | S6 Detail | Medium | enhancement | The owner's saved "found it cheaper at" link is never shown outside the edit form |
| [#114](https://github.com/barkley-assistant/sugarplum/issues/114) | S7 Edit | Low | bug | A non-preset currency reads "Other" on the edit form with no code field at all |
| [#115](https://github.com/barkley-assistant/sugarplum/issues/115) | S3/S10 | Low | accessibility | Danger buttons drop below AA contrast on hover (4.41:1 light) |
| [#116](https://github.com/barkley-assistant/sugarplum/issues/116) | S1/S2/S10/S12/S13 | Low | accessibility | Primary mobile controls sit below the 44px touch-target guidance |
| [#117](https://github.com/barkley-assistant/sugarplum/issues/117) | S15 | Low | enhancement | Offline writes report a generic action failure with no offline framing |
| [#118](https://github.com/barkley-assistant/sugarplum/issues/118) | S6 | Low | enhancement | "Not enough history yet" renders under a fully drawn price chart |
| [#119](https://github.com/barkley-assistant/sugarplum/issues/119) | S1 | Low | enhancement | Rows without an image lose the thumbnail column and break row alignment |
| [#120](https://github.com/barkley-assistant/sugarplum/issues/120) | S14 | Low | enhancement | Login has no password reveal toggle |
| [#121](https://github.com/barkley-assistant/sugarplum/issues/121) | S5/S7 | Low | enhancement | Add/edit heading copy is asymmetric ("Add to Sugarplum" vs "Edit") |

## 3. Surface-by-surface

### 3.1 S1 — Feed (own list)

**Verified OK**

* Row anatomy renders and stays legible at 390: thumbnail, title, site, price,
  "Lowest …", delta badge, row actions.
* The delta badge is not colour-only — it carries an arrow glyph and the text
  "£5.50 since added" (`screens/92:s01-feed-own-390-light.png`).
* Owner-purchased rows show a struck-through title plus a "Bought by you" mark.
* Pending rows show the "Fetching details…" badge with a reserved image placeholder;
  failed rows show "Details unavailable"; a non-preset currency formats correctly
  ("349.00 SEK").
* Filter chips (All + one per tag) render, wrap at 360/390, and the filtered-empty
  state offers Clear (`screens/92:s15-filtered-empty-390-light.png`).
* Manual ordering: `PUT /api/wishlist/order` → 200, DOM follows on reload
  (`orderFollowed: true`), and the manual order survives an active filter chip
  (`orderKept: true`).
* Row overflow menu: opens on Enter, state-correct items (Edit, Re-check price, Copy
  product link, Mark as purchased, Reset purchased mark, Delete), Escape closes it and
  focus returns to the trigger.
* Empty own list renders its empty state with the Add action: "Nothing saved yet."
  / "Paste a product link to start your list." plus the Add item button
  (`screens/92:s01-feed-own-empty-390-light.png`).
* No document overflow at 390/1280 (see 5.1); zero running animations under
  `prefers-reduced-motion: reduce`.

**Findings**

* **F-8 → #119** (Low, enhancement). Rows without an image lose the thumbnail column:
  measured on the live feed, a row with an image has a 72px thumb track and its title
  starts at x=112, while rows without one collapse the track to 0px and their titles
  start at x=40 — titles, prices and deltas no longer line up down the list.
  Root cause: `src/web/components/ItemCard.tsx:226-232` passes `image` only when
  `imagePath` exists (or the pending placeholder), and `ProductRow.tsx:56` renders
  that node directly into the grid defined at `src/web/styles.css:1999-2011`.
  Evidence: `screens/92:s01-feed-own-390-light.png`,
  `screens/92:s01-feed-own-1280-dark.png`.
* **F-5 → #116** (Low, accessibility). Filter chips measure 36px tall and the
  Reorder/Done control 36px; see the cross-surface roll-up in section 5.5.

### 3.2 S2 — Feed (another user's list)

**Verified OK**

* Switching lists marks the current one; the other list renders with its own items
  and count (`screens/92:s02-feed-other-390-light.png`).
* Claim state is booleans only: the other-user payload exposes `claimed` /
  `claimedByYou` and no claimant identity, and both states were observed
  (`claimed: true, claimedByYou: false` and `true/true`). Badge rendering for both
  states, and the owner's own list showing no claim text at all, are pinned by
  `e2e/app.spec.ts` (claim-state assertions around the "Claimed by you" badge).
* No owner-only affordances render for another user's list: no Reorder, no Edit /
  Re-check / Delete row actions, no hints disclosure.
* Empty other-user list renders its own copy with no Add action.

**Findings** — none beyond the cross-surface touch-target item (#116).

### 3.3 S3 — Mobile bottom action bar

**Verified OK**

* The bar renders on `/`, `/add`, `/settings` and `/items/:id`, and is absent on
  `/share/:token` (anonymous) — `bar/share/... bottomBar: 0`.
* The bar's Share opens the share sheet on a non-feed route (`/items/:id`), so the
  list-level share link is reachable from anywhere.
* A toast raised while the bar is visible sits above it, not behind it:
  toast box 702–772, bar top 787 (`aboveBar: true`), with the bar's safe-area padding
  intact.
* 360px and 390px frames show no overflow and no clipped labels
  (`screens/92:s03-bottom-bar-share-360-light.png`).

**Findings** — the bar's own controls are measured in #116.

### 3.4 S4 — Desktop top bar

**Verified OK**

* Header cluster (Add, Share, user menu) renders at 768/1024/1280.
* The share popover opens from the header, closes on Escape and returns focus to the
  trigger (`focusBackOnTrigger: "Share my list"`), and closes on outside click.
* Confirmation dialogs stack above the open popover without z-index artefacts
  (`screens/92:s10-share-revoke-confirm-1280-light.png`).

**Findings** — the popover's danger control is covered by #115.

### 3.5 S5 — Add

**Verified OK**

* Paste-a-link first: the link field is the primary control and the submit label
  ("Add item") matches the action.
* Manual disclosure opens and closes; its state is captured either way
  (`screens/92:s05-add-manual-390-light.png`, `screens/92:s05-add-390-light.png`).
* Share-target prefill survives the login hop: `/add?url=…&title=Widget` on a
  cookieless context lands on `/login?next=%2Fadd%3Furl%3D…%26title%3DWidget`, and
  after signing in the Link and Title fields are prefilled and the manual section is
  open (`urlValue: "https://example.com/widget"`, `manualOpen: 1`).
* Validation: submitting empty keeps the user on `/add` and shows
  "Add a title or a link." with the form intact.
* A scrape that returns nothing still creates the item: the pending row appears with
  the "Fetching details…" badge and a reserved image slot, and the failed row keeps
  its content with a "Details unavailable" badge instead of a dead end.

**Findings**

* **F-1 → #112** (Medium, bug + accessibility). Hovering "Add details manually"
  turns the disclosure into a solid violet bar while the label keeps its quiet grey:
  measured contrast **1.16:1 (light)** and **2.66:1 (dark)**, against 4.5:1 for body
  text. At rest it is a correct quiet row. Root cause: `src/web/styles.css:76`/`:82`
  style *every* bare `button` plum, and `.add-disclose` (`styles.css:1407`) resets
  `background: none` at rest with no `:hover` override — the pseudo-class selector
  out-specifies the class. Evidence: `screens/92:s05-add-manual-hover-390-light.png`,
  `screens/92:s05-add-manual-hover-390-dark.png`.
* **F-10 → #121** (Low, enhancement). `/add` is headed "Add to Sugarplum"; the same
  form on `/items/:id/edit` is headed a bare "Edit" while its submit says "Save"
  (`AddPage.tsx:62` vs `ItemEditPage.tsx:86`). Evidence:
  `screens/92:s05-add-390-light.png` vs `screens/92:s07-edit-390-light.png`.

### 3.6 S6 — Item detail (owner)

**Verified OK**

* Hero, title, site, price, lowest price and delta render at both widths in both
  themes; a purchased item shows the struck-through title and "Bought by you".
* Price-history card: the 30d/90d window toggle persists across reload
  (`localStorage: "90d"`, `aria-pressed: true`).
* Notes and tags cards render only when present.
* More information: the "view on" link is present; the hints disclosure is
  owner-only and its error branch (503 when no search backend is configured)
  renders an error state rather than an empty panel
  (`screens/92:s06-detail-hints-error-390-light.png`).
* Footer provenance (added date, source host) renders.
* A failed item still renders the full page from stored data.

**Findings**

* **F-2 → #113** (Medium, enhancement). `cheaperUrl` is captured on add/edit, stored,
  returned by the API and projected onto the owner item, but no owner surface renders
  it: the detail page has no cheaper text and no link to it
  (`detailHasCheaperText: false`, `detailHasCheaperHref: false`) while the edit form
  holds the saved value. Evidence: `screens/92:s06-detail-cheaper-390-light.png`,
  `screens/92:s07-edit-390-light.png`.
* **F-7 → #118** (Low, enhancement). An item with recorded points draws the full
  chart (line, tooltip, window toggle) and is captioned "Not enough history yet",
  because the caption falls back to the insufficient-history string whenever the
  server-side trend is null (`src/web/components/PriceHistoryCard.tsx:107-109`;
  observed `trend.advice: "insufficient"` with the graph drawn). Evidence:
  `screens/92:s06-detail-history-390-light.png`,
  `screens/92:s06-detail-history-1280-dark.png`.

### 3.7 S7 — Edit

**Verified OK**

* The full form prefills title, price, tags (comma-joined), notes and the saved
  cheaper link.
* Save round-trips to the detail page; Cancel returns to the detail page.
* Clearing the cheaper link saves `null` (`patchStatus: 200`,
  `cheaperUrlAfter: null`) — no stale URL survives.
* The non-preset currency case is safe on an unchanged save: the detail page still
  formats SEK after saving the form untouched (see F-3 for the visibility gap).

**Findings**

* **F-3 → #114** (Low, bug). Editing an item whose currency is not a preset shows
  "Other" in the currency select and **no code field at all** — the free-text input
  is not rendered, so the stored code is invisible and cannot be corrected without
  re-selecting "Other". Root cause: `src/web/components/ItemForm.tsx:39-40` initialises
  `currency` from the item and `otherCurrency` to `""`, while `:122` projects the
  select value to "Other" for non-presets and the code input renders only when the
  *state* equals "Other". No data loss: an unchanged save omits the empty currency and
  the detail page still renders "349.00 SEK"
  (`screens/92:s06-detail-sek-390-light.png`). Evidence:
  `screens/92:s07-edit-sek-390-light.png`, `screens/92:s07-edit-sek-1280-dark.png`.
* **F-10 → #121** — heading copy asymmetry, as in 3.5.

### 3.8 S8 — Guest detail sheet (another user's item)

**Verified OK**

* Opens from another user's row, as a sheet on mobile and a drawer at ≥1024px;
  Escape and overlay dismiss it and focus returns to the row.
* Informational parity with the owner page after #90: price history, lowest/delta,
  notes, tags, more-information and footer provenance all render.
* No owner actions: no edit, re-check, reset, delete or hints toggle.
* Nothing owner-private crosses the boundary — the guest payload is the booleans-only
  projection (see INV-P3/INV-P3b in section 4). Evidence:
  `screens/92:s08-guest-sheet-390-light.png`,
  `screens/92:s08-guest-sheet-1280-dark.png`.

**Findings** — none.

### 3.9 S9 — Anonymous share view

**Verified OK**

* Renders with no login wall, no bottom bar, and **zero** `/api/auth/me` requests —
  the anonymous visitor never boots the authenticated shell (INV-P8).
* Header shows the owner's list name and item count; the shared-by note renders.
* Rows show a purchased badge where marked, otherwise the "Mark as purchased" action;
  the confirm copy states that the mark tells other viewers and is not shown to the
  list owner.
* Rate limiting is surfaced with its dedicated copy, not a generic failure: five
  marks return 200 and the next one, driven through the real UI, shows
  "Too many attempts. Try again later."
* An invalid/revoked token renders the error state with no chrome leak
  (`screens/92:s09-share-anon-invalid-390-light.png`).
* When the owner views their own share link, every row reports `purchased: false`
  (INV-P2) — the owner never sees anonymous marks.
* Images are served through the token-scoped path
  (`/api/share/<token>/items/<id>/image`), never the session-scoped one (INV-P4).

**Findings** — none.

### 3.10 S10 — Share management (owner)

**Verified OK**

* Opens from the feed as a popover at ≥640px and a sheet below 640px
  (`screens/92:s10-share-menu-mobile-390-light.png`,
  `screens/92:s10-share-menu-desktop-768-light.png`).
* Creating a link returns the URL; the panel distinguishes regenerate (the old link
  stops working) and revoke, each behind its own confirmation
  (`screens/92:s10-share-revoke-confirm-1280-light.png`).
* The panel's privacy copy matches the runtime behaviour verified in INV-P2.

**Findings**

* **F-4 → #115** (Low, accessibility). A danger button's hover state drops its label
  below AA: "Revoke link" at rest is `#dc2626` on `#ffffff` = 4.83:1, hovered it is
  `#dc2626` on `#fef2f2` = **4.41:1**. Root cause:
  `src/web/styles.css:137` (`button.danger:hover { background: var(--danger-surface) }`)
  with `--danger`/`--danger-surface` from `src/web/styles/tokens.css`. Dark theme
  passes in both states (6.4:1 → 6.21:1). This applies to every `button.danger`, not
  just the share panel. Evidence:
  `screens/92:s10-share-menu-mobile-390-light.png`.
* **F-5 → #116** — sheet trigger and action measurements, as in section 5.5.

### 3.11 S11 — Settings (Account & Preferences)

**Verified OK**

* Display-name, password and preference controls render at 390/1280 in both themes
  (`screens/92:s11-settings-390-light.png`,
  `screens/92:s11-settings-1280-dark.png`).
* Preferences are server-backed, not cosmetic: a save announces itself with a toast
  (`screens/92:s15-toast-success-390-light.png`) and a save attempted with the network
  cut surfaces "Could not save that setting." rather than silently reverting (F-6).
* The password change / display-name flows and the Users entry's opt-in behaviour are
  covered by the existing suite (`e2e/settings.spec.ts` 2, 5, 6, 14;
  `tests/integration.test.ts` "settings: PUT /api/auth/me/settings opts into admin user
  management").

**Findings** — none.

### 3.12 S12 — Settings: Users (admin, opt-in)

**Verified OK**

* Reachable only with the admin preference enabled; members are bounced and
  `/api/users*` stays 403 regardless of the preference (covered by
  `e2e/settings.spec.ts` 2 and 14, `tests/admin-guard.test.ts`).
* The users table wraps at 390 with no document overflow and row actions stack sanely
  (`screens/92:s12-settings-users-390-light.png`,
  `screens/92:s12-settings-users-1280-dark.png`).
* The reset-password inline form expands from the row action and its inputs are
  labelled via `label[for]` (DOM inspection)
  (`screens/92:s12-settings-users-admin-390-light.png`).
* The last-admin guard surfaces on the Users screen instead of failing silently
  (`e2e/settings.spec.ts` 4; `tests/admin-guard.test.ts` — deleting or deactivating the
  last active admin returns 409 with a clear message).

**Findings**

* **F-5 → #116** — row action buttons measure 41px tall; included in the roll-up.

### 3.13 S13 — Settings: New user (admin, opt-in)

**Verified OK**

* Field widths are consistent with the rest of the form language (#97): every input
  measures 308px at 390 and 978px at 1280 — no half-width outlier.
* Every input is labelled through `label[for]`; the Admin checkbox takes its name
  from its wrapping label (verified by DOM inspection, so the accessibility-tree
  check's "unlabelled" hit there was a false positive of a `label[for]`-only
  heuristic).
* The create-user row shares its slot at every width in both themes and username
  uniqueness is enforced case-insensitively (covered by `e2e/settings.spec.ts` 12 and
  `tests/integration.test.ts` "username uniqueness is case-insensitive").

**Findings**

* **F-5 → #116** — the Admin checkbox row measures 21px of effective height, the one
  sub-24px target found; folded into the roll-up.

### 3.14 S14 — Login

**Verified OK**

* Fits 360px with no overflow; the auth-check skeleton renders before the form
  (`screens/92:s14-login-390-dark.png`).
* Authed visitors are redirected to their `?next=` target instead of seeing the form
  (`e2e/auth.spec.ts` a2, plus the share-target probe: a cookieless `/add?url=…` visit
  lands on `/login?next=…` and returns to the prefilled form after signing in).
* Invalid credentials and the login rate limit return their own copy / status
  (`tests/auth.test.ts` — bad creds → 401, 11th failure → 429 with Retry-After, IP
  backstop).

**Findings**

* **F-9 → #120** (Low, enhancement). The password field has no reveal control
  (`type: "password"`, the only button in the card is "Sign in"), so a typo on a
  phone keyboard cannot be checked without retyping. Evidence:
  `screens/92:s14-login-390-light.png`, `screens/92:s14-login-1280-dark.png`.

### 3.15 S15 — Cross-cutting chrome

Covered in detail in section 5.

## 4. Privacy walkthrough

Re-verified against the running server during the share/claims walkthrough. Every
invariant below was observed, not inferred; no server projection was edited.

| Invariant | Runtime proof | Result |
|---|---|---|
| **INV-P1** — the owner's list projection carries no claim fields | Own-list row keys contain no key matching `claim` (`claimFields: []`) | Holds |
| **INV-P2** — the owner's own share view is always `purchased: false` | `viewerIsOwner: true`, every row `purchased: false`, no `purchasedAt` anywhere in the payload | Holds |
| **INV-P3** — the anonymous share projection is booleans-only | Public row keys are id/title/url/price/currency/notes/tags/site/createdAt/priceStats/imageSource/hasImage/purchased — no owner, hint, cheaper or stats-owner fields | Holds |
| **INV-P3b** — another user's list exposes claim booleans, never identity | Keys include `claimed`/`claimedByYou` only; both claim states observed across rows; no `cheaper`/`hint`/`owner`/`priceStats` leak | Holds |
| **INV-P4** — share images are token-scoped | The anonymous page requests `/api/share/<token>/items/<id>/image`; the session-scoped path never appears | Holds |
| **INV-P5** — an anonymous purchase reset is owner-blind | `DELETE /api/wishlist/items/:id/purchased` → **204** with an empty body | Holds |
| **INV-P6** — owner mark and share mark are separate projections | The owner projection carries `ownerPurchased`; the owner's share view still reports every row `purchased: false` while an anonymous mark exists | Holds |
| **INV-P7** — hints are owner-only | `POST /api/wishlist/items/:id/hints` as a non-owner → **403**; the guest sheet renders no hints toggle | Holds |
| **INV-P8** — no session on the share surface | The anonymous context made **zero** `/api/auth/me` requests and rendered no bottom bar | Holds |

## 5. Cross-cutting chrome (S15)

### 5.1 No horizontal overflow

122 sweep frames plus 46 focused frames across S1–S15 at 360/390/768/1024/1280 in both
themes: **zero** document overflow and zero individually escaping elements.

### 5.2 Keyboard and focus

* An 8-stop Tab walk from the feed reaches the header actions, the user menu, the
  list switcher, Reorder and the filter chips, every stop with a visible focus ring.
* Enter opens the row overflow menu; Escape closes it and returns focus to the
  trigger.
* Escape closes the share popover and returns focus to its trigger; outside click
  closes it.
* Confirmations are `role="alertdialog" aria-modal="true"` with a readable
  `aria-label` ("Delete \"Dog lead\"?"), confirm exactly once on Enter (one DELETE
  request, dialog closed), cancel on Escape without acting, and return focus to the
  row trigger. No double-activation from an Enter-activated trigger.

### 5.3 Accessible names and text alternatives

Every interactive control has an accessible name; images carry `alt` (zero violations
across the sweep, and the apparent exception in the new-user form is the
label-wrapped checkbox described in 3.13).

### 5.4 Reduced motion

With `prefers-reduced-motion: reduce` emulated, the captured frames reported **zero**
running animations (the feed reports 1–2 with motion allowed).

### 5.5 Touch targets

Measured, not guessed (issue #116). WCAG 2.5.8 AA requires 24px, so these are
guidance rather than conformance failures; the 44px guideline is the bar used here.

| Control | Measured height | Where |
|---|---|---|
| Admin checkbox (new user) | 21px | S13 — the only sub-24px target |
| Filter chips | 36px | S1/S2 |
| Reorder / Done | 36px | S1, reorder mode |
| List-switcher trigger | 34px | S1/S2 |
| Admin user-row actions | 41px | S12 |
| Brand lockup (home link) | 28px | shell |

### 5.6 Loading, empty, error and offline states

Pending badge, failed badge with Retry, empty own list, empty other list,
filtered-empty with Clear, hint error state, skeleton frames, offline shell and both
toast variants (success and failure) all render
(`screens/92:s15-skeleton-390-light.png`,
`screens/92:s15-toast-offline-390-light.png`,
`screens/92:s15-filtered-empty-390-dark.png`).

An offline deep link to an item still renders the item from the cached shell, and a
write attempted offline surfaces a toast rather than failing silently — but the copy
is not offline-aware (F-6).

### 5.7 Cross-cutting findings

* **F-6 → #117** (Low, enhancement). With the network cut, deleting an item toasts
  "Could not delete item." and a settings toggle shows "Could not save that setting."
  — action-specific, but identical to a server-side failure, with no connectivity
  hint even though the failure is unambiguously offline. Evidence:
  `screens/92:s15-toast-offline-390-light.png`.
* **F-5 → #116** — touch targets, see 5.5.

## 6. Filing manifest

Ten findings, ten issues — one per finding, none merged, none left unfiled.

| Finding | Issue | Labels | Dedup |
|---|---|---|---|
| F-1 | #112 | `bug`, `accessibility` | Checked #70/#75/#87/#88/#93/#97/#102/#103 — none cover it |
| F-2 | #113 | `enhancement` | #15 (raw URLs on cards) is closed and about URL length; #102 is about handoff, not visibility |
| F-3 | #114 | `bug` | #97 (form widths) closed and unrelated |
| F-4 | #115 | `accessibility` | No existing issue covers danger-button states |
| F-5 | #116 | `accessibility` | #97 touched form widths only |
| F-6 | #117 | `enhancement` | No existing issue covers offline copy |
| F-7 | #118 | `enhancement` | No existing issue covers the history caption |
| F-8 | #119 | `enhancement` | Related to #87 (image flush on rows that *have* an image, closed) but distinct |
| F-9 | #120 | `enhancement` | #63 (auth/login review) is closed and predates this login screen |
| F-10 | #121 | `enhancement` | No existing issue covers heading copy |

No finding fell into the domains of the two open issues that already own whole
subsystems: #102 (external-link handoff — link markup was verified as plain
`target="_blank" rel="noreferrer"` anchors, no defect found) and #103 (eBay scraping —
not re-audited here).

**No in-audit fixes were applied.** No finding met the fixes-during-audit bar
(single contiguous file, copy/label/aria only, no gate impact), and the audit's
deliverable is the review plus the filed queue; every finding above is filed, none is
silently folded into this change.

### 6.1 Leads that did not reproduce (recorded, no issue)

* **Pending-row poll window can stall for 30s** — not reproduced. The plain fetch path
  aborts at 10s (`src/server/scraper/fetch.ts:85`), so a pending row converges well
  inside the 30s episode cap. The only path that could exceed it is the stealth
  browser on a registered host, which the harness cannot provision
  (`SUGARPLUM_STEALTH_VENV_PY`). Residual risk, recorded here; no issue filed because
  the state could not be demonstrated.
* **`displayUrl` is dead code** — no component imports it (only `urlHost` is used) and
  no raw long URL rendered anywhere in the walk. Recorded as a note; not a UX defect.
* **Reorder on another user's list** — impossible: the Reorder action renders only for
  the owner's own list and only with more than one item.
* **Filter chips + reorder** — chips wrap without overflow at 360/390 and entering
  reorder visibly clears the active tag with the chip row hidden, so the tag is
  dropped by design rather than silently lost.

## 7. Screenshot matrix

Every frame below is on the evidence branch under `artifacts/screens-92/`; the
links follow the pattern
`https://raw.githubusercontent.com/barkley-assistant/sugarplum/screens/92/artifacts/screens-92/<name>`.
State variants (pending, failed, purchased, sek, empty, filtered-empty, reorder,
skeleton, toasts, confirms) are listed with the base surface.

Capture note: frames are full-page screenshots, so `position: fixed` chrome (the
confirm scrim, the mobile action bar) only appears over the first viewport height —
a capture artefact, not a layout defect. Where a fixed layer matters (toast above the
action bar) it was measured in the DOM instead of judged from the frame.

| Surface | 390 light / dark | 1280 light / dark | Extra widths | State variants |
|---|---|---|---|---|
| S1 Feed (own) | `s01-feed-own-390-{light,dark}.png` | `s01-feed-own-1280-{light,dark}.png` | — | `s01-feed-own-empty-*`, `s01-feed-own-pending-390-*` |
| S2 Feed (other) | `s02-feed-other-390-{light,dark}.png` | `s02-feed-other-1280-{light,dark}.png` | — | — |
| S3 Bottom bar | `s03-bottom-bar-share-390-{light,dark}.png` | — | `…-360-{light,dark}.png` | — |
| S5 Add | `s05-add-390-*`, `s05-add-manual-390-*`, `s05-add-manual-hover-390-*`, `s05-add-prefill-390-*` | same at `1280` | — | manual open/closed, hover, share-target prefill |
| S6 Detail | `s06-detail-{history,cheaper,purchased,failed,sek}-390-*` | same at `1280` | — | `s06-detail-hints-error-390-*` |
| S7 Edit | `s07-edit-390-*`, `s07-edit-sek-390-*` | same at `1280` | — | non-preset currency |
| S8 Guest sheet | `s08-guest-sheet-390-{light,dark}.png` | `s08-guest-sheet-1280-{light,dark}.png` | — | — |
| S9 Share (anon) | `s09-share-anon-390-*`, `s09-share-anon-invalid-390-*`, `s09-share-owner-390-*` | same at `1280` | — | `s09-share-mark-confirm-390-*` |
| S10 Share panel | `s10-share-menu-mobile-390-*` | `s10-share-menu-desktop-1280-*` | `…-mobile-360-*`, `…-desktop-{768,1024}-*` | `s10-share-revoke-confirm-{390,1280}-*` |
| S11 Settings | `s11-settings-390-{light,dark}.png` | `s11-settings-1280-{light,dark}.png` | — | — |
| S12 Users | `s12-settings-users-390-*`, `s12-settings-users-admin-390-*` | `s12-settings-users-1280-*` | — | reset-password form expanded |
| S13 New user | `s13-settings-new-user-390-{light,dark}.png` | `s13-settings-new-user-1280-{light,dark}.png` | — | `probe-newuser-{light,dark}.png` |
| S14 Login | `s14-login-390-{light,dark}.png` | `s14-login-1280-{light,dark}.png` | — | — |
| S15 Chrome | `s15-{toast-offline,toast-success,confirm-delete,reorder-mode,skeleton,filtered-empty}-390-*` | same at `1280` | — | `s15-reduced-motion-{390,1280}-light.png` |

## 8. Residual risks

1. **Stealth-scrape stall (not reproduced).** See 6.1. A pending row whose enrichment
   runs through the stealth browser could exceed the 30s poll episode; not
   demonstrable in this harness.
2. **Clipboard-denied copy fallback.** The share panel's copy control was not
   exercised with clipboard permission denied, so its fallback is unverified.
3. **Screen-reader announcement.** Live-region behaviour was assessed from markup and
   focus behaviour, not from an assistive-technology run.
4. **Single engine.** All captures are Chromium; Firefox/WebKit rendering was not
   audited.
5. **Point-in-time.** The audit describes `main @ 5138f0d`; later merges can invalidate
   individual observations, and the deployed site may already differ.
