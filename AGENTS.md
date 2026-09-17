# AGENTS.md — sugarplum project conventions

Private two-person wishlist tracker. Paste a link → the server fetches the
product (title, price, image, source) → wishlists you can share with each
other. PWA, mobile-first, Bun-native.

## Stack (fixed — do not drift)

- Runtime/server: Bun (latest stable, pinned via global mise
  `~/.config/mise/config.toml`; the systemd unit runs through `mise exec`),
  `Bun.serve({ routes })`. TypeScript runs directly; no build step for the server.
- Frontend: React SPA via Bun HTML imports (`src/web/index.html` is the
  entry; the bundler walks it). No Next.js, no Vite, no separate tsconfig.
- Database: `bun:sqlite`, WAL mode enabled, schema in
  `src/server/db/migrations.ts` (idempotent, versioned).
- Tests: `bun test` for unit/integration (`tests/` only — never glob
  Playwright specs), Playwright in `e2e/` for browser flows.
- Types: one root `tsconfig.json` whose `include` covers every TS
  directory. `bunx tsc --noEmit` is the canonical type gate.
- Lint: ESLint + typescript-eslint via `eslint.config.js` (flat config),
  `bun run lint` is the gate.
- Dependencies: no version ranges in `package.json` — install latest
  stable; `bun.lock` is the reproducibility artifact. Keep all
  dependencies and the toolchain (bun, typescript, eslint, playwright,
  react) up to date — bump to the newest stable version whenever one
  ships, and verify the gates before merging.

## Layout

```
src/server/    Bun.serve, routes, db, auth, scraper, jobs
src/web/       SPA (index.html, app.tsx, components, styles)
src/shared/    types shared by server + client
tests/         bun test unit/integration
e2e/           Playwright specs (kept OUT of tests/)
scripts/       dev wrapper, deploy.sh, probes
```

## Auth model

Multi-user: N users, per-user wishlists. NOT hardcoded to two users —
the app currently happens to be used by two people, but the model is
general. Sessions: HttpOnly + Secure + SameSite=Lax cookies,
server-side session table. Password hashing: `scrypt` via `node:crypto`
(the one legit node:crypto import). Every non-auth route requires a
valid session — there is no public surface except the login page and
`/api/health`.

User management: a SUPER-EASY basic admin surface — create a user, list
users, deactivate/remove a user, reset a password. Bootstrap admin is
env-configured on first boot; everything after that is managed in-app.
No email flows, no invites, no complex roles. Keep it lightweight.

## Secrets

Secrets live in env only (SESSION_SECRET, user credentials, etc.).
.env is gitignored; .env.example documents every var with no real
values. Never log secret material.

## Git conventions

- Conventional commits, subject <= 72 chars, no trailers in the subject.
- Commit author identity: `Barkley Assistant <barkley@agentmail.to>`.
- No personal information anywhere — no real names, emails, or
  usernames beyond the bot identity above. This repo is public.
- `Closes #N` goes in the PR body only, never the subject.
- Plan/handoff artifacts (`.hermes/`) are never committed. Stage files
  explicitly; never `git add -A`.
- Leave the checkout on `main` when you finish — never park it on a
  feature branch.

## Gates (all must pass before a PR is ready)

```
bun test tests/          # unit + integration
bunx tsc --noEmit        # types
bun run lint             # eslint (when configured)
bun run build            # production web bundle
```

Serialize heavy gates (do not run two full suites in parallel — small
host, OOM risk). Fresh-clone rule: a branch is not done until
git clone -> bun install --frozen-lockfile -> gates pass on the clone.

## Product rules

- Design language: professional product. NO Christmas theme, NO emojis
  in the UI, no decorative whimsy. Clean, neutral, confident — think
  Linear/Notion-grade polish.
- Mobile-first: every UI change is verified at 360-430px widths as well
  as desktop. No horizontal page overflow, ever.
- PWA: installable, offline app shell, icons + manifest + iOS meta tags
  maintained as the UI evolves. Web Share Target (Android) is the
  primary add flow alongside paste-a-link.
- Drag-and-drop ordering is a first-class feature: manual order
  persists per user, filter chips do not destroy it.
- Adding an item is a paste-a-link flow first; manual entry is the
  fallback, not the default.
- Failures degrade gracefully: a scrape that can't fetch price/image
  still creates the item with what it has + a visible "incomplete"
  state, never a dead end.
