# #131 before/after captures (throwaway evidence branch)

Not for merge: this branch exists so the #131 PR body can render these images.

- `before/` — the same scratch instance at the merge base (main @ 5d65dda)
- `after/` — the same instance with the #131 diff applied
- `diff-matrix.txt` — per-capture pixel-diff counts

Harness: Playwright, 2x device scale (files here are halved to 1x), one seeded
instance per side (admin with 6 items, a 40-character display name with 3 items,
one share link), same harness and viewports, both colour schemes.

Byte-identical (`0 px changed`): feed @768/@1280, share @768/@1280, detail
@390/@1280, login @1280 — the desktop composition is untouched.
