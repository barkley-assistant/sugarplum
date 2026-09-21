# #116 before/after captures (throwaway evidence branch)

Not for merge: this branch exists so the #116 PR body can render these images.

- `after/` — the branch (`fix/touch-targets`), dist rebuilt from its `styles.css`
- `before/` — the same build plus an adopted stylesheet restating main's
  pre-change declarations (CSP `style-src 'self'` blocks inline `<style>`;
  `document.adoptedStyleSheets` is the documented workaround)
- `real-main/` — 6 surfaces captured against a clean build of `origin/main`'s
  `styles.css`, used to validate the `before/` method
- `diff-matrix.txt` — per-capture differing-pixel counts + the avatar-AA note

Harness: Playwright, `deviceScaleFactor: 1` (CSS pixels), 180 ms settle,
animations disabled, one seeded instance (probe admin, 3 tagged items, one
marked purchased, one share link, `showUserManagement` on only while the
admin screens are captured), both colour schemes, 360/390/430/768/1280.

Surfaces (56 per side): feed-own ×5 widths, feed with a long display name,
settings ×5, users ×4, new-user ×2, item detail ×5, add, edit, anonymous share
×2, login ×2 — each in light and dark.

Pixel-diff summary: 30 of 56 captures are byte-identical; every non-identical
capture except the 78–81 px avatar antialiasing noise (documented in
`diff-matrix.txt`) is one of the four intended control changes — the 44 px
filter chips, the 44 px Reorder/Done action, the 44 px admin/reset row actions,
and the 44 px new-user checkbox row with its 20 px box.
