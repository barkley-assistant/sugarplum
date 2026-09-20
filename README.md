# sugarplum

A small, private wishlist tracker for two people: paste a link, the server
fetches the product (title, price, image, source), and the lists are shared
between accounts. Mobile-first PWA built on Bun.

## Quickstart

1. `cp .env.example .env` and set the admin variables:
   `SUGARPLUM_ADMIN_USERNAME`, `SUGARPLUM_ADMIN_PASSWORD`,
   `SUGARPLUM_ADMIN_DISPLAY_NAME`.
2. `bun install`
3. `bun run dev` — the printed URL is where you log in.

On first boot the server creates the bootstrap admin from the environment.
After that, user management (create users, reset passwords, deactivate) is
done in the app's admin panel.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SUGARPLUM_PORT` | `3499` | HTTP port |
| `SUGARPLUM_HOST` | `127.0.0.1` | Bind host |
| `SUGARPLUM_DB_PATH` | `./data/sugarplum.db` | SQLite database location |
| `SUGARPLUM_SESSION_TTL_DAYS` | `30` | Session idle window: sessions renew on use, so this bounds idleness, not lifetime |
| `SUGARPLUM_ADMIN_USERNAME` | — | Bootstrap admin username (required) |
| `SUGARPLUM_ADMIN_PASSWORD` | — | Bootstrap admin password (required) |
| `SUGARPLUM_ADMIN_DISPLAY_NAME` | — | Bootstrap admin display name |
| `SUGARPLUM_DEV` | `0` | `1` disables the Secure cookie flag (plain-HTTP LAN dev) |
| `SUGARPLUM_IMAGES_DIR` | `./data/images` | Where downloaded product images are stored (created on demand) |
| `SUGARPLUM_USER_AGENT` | Firefox desktop UA | User agent the scraper uses to fetch product pages |
| `SUGARPLUM_ENRICH_CONCURRENCY` | `2` | Max concurrent background enrichment jobs (clamped 1..8) |
| `SUGARPLUM_SEARXNG_URL` | unset | Optional self-hosted SearXNG instance for best-effort price hints (unset disables the fallback) |
| `SUGARPLUM_STEALTH_DISABLED` | `0` | `1` disables the stealth-browser strategy (chain falls back to plain-only) |
| `SUGARPLUM_STEALTH_TIMEOUT_MS` | `60000` | Whole-scrape budget for the stealth-browser strategy |
| `SUGARPLUM_STEALTH_PROFILES_DIR` | `./data/stealth-profiles` | Per-host Firefox profile dirs (gitignored; self-healing) |
| `SUGARPLUM_STEALTH_VENV_PY` | `<repo>/../.stealth-venv/bin/python` | Path to the stealth venv python (deploy.sh provisions it) |
| `SUGARPLUM_TRACK_INTERVAL_MS` | `86400000` | Daily tracking pass interval (24h) |
| `SUGARPLUM_TRACK_INITIAL_DELAY_MS` | `60000` | Delay before the first tracking pass after boot |
| `SUGARPLUM_TRACK_STAGGER_MS` | `900000` | Stagger between items in a tracking pass (15min) |
| `SUGARPLUM_TRACK_SERIES_CAP` | `90` | Max observations in the 90-day price series (clamped 1..365) |

## Paste-a-link

Paste a product link into the add form (title optional): the item appears
immediately as "Fetching details…", and a background job fetches the page and
fills in the title, price, image, and source site. Pasting a link is the
primary add flow; manual entry remains the fallback.

What gets extracted depends on the shop:

- Shopify-family stores (ColourPop, Decathlon, Death Wish Coffee, most indie
  stores) ship OpenGraph + JSON-LD metadata server-side, so they get the full
  extraction: title, price, currency, product image (downloaded and served
  locally), and site name.
- Steam, blogs, and most indie sites give title + image but usually no price.
- Amazon, Walmart, eBay, Etsy, Best Buy, Target, Argos, John Lewis, and IKEA
  bot-wall server-side fetches, so the item stays visibly "Details
  unavailable" with a Retry button. That is the honest, graceful state — add
  the details manually, or (if configured) let the optional SearXNG fallback
  show an unverified "~£25.00 (via search)" price hint.
- Smyths Toys (and any future Imperva / Distil-class JS-challenge site) is
  served via the `stealth-browser` strategy: a per-host persistent Firefox
  profile solves the challenge once, then later scrapes reuse the cookies
  and fingerprint identity. Walled-site support is per-site opt-in — adding
  one is a single reviewed entry in `src/server/scraper/overrides.ts` (no
  core-scraper edits).

## Prices

Every price observation is appended to the item's history: scraped prices, the
best-effort search hint, and prices you type yourself (marked as your own).
The card shows the current price with the lowest seen and the price the item
was added at, plus a plain "Down £2.50 since added" line when it moved —
delta lines are only drawn when both observations share a currency.

- **Re-check price** re-fetches the item's link. A re-check may replace a
  price the app fetched; it never overwrites a price you typed, and every
  observation is kept.
- **Prices seen elsewhere (unverified)** runs an on-demand SearXNG lookup for
  up to three candidate prices derived from the item's title. These are raw
  search snippets — different editions, resellers and currencies mixed
  together — so the UI labels them unverified and never calls anything
  "cheapest". Nothing is stored.
- **Found it cheaper at** is your own link: the page you found is the
  evidence, so no automatic price is claimed for it.
- **Show unverified price hints** in the user menu is the honesty gate. With
  it off, no price hints are fetched or attached at all (the image fallback
  is a separate feature and keeps working).
- **Daily tracking** re-checks each tracked item once a day (staggered across
  the day so bot-walled shops are never hammered) and appends a snapshot to
  the same history. Items are skipped when they have no link, are already
  being fetched, or were tracked in the last 24 hours. A failed re-check
  leaves the last known price untouched.
- **Price history in item details**: items with at least two same-currency
  observations show a compact 30/90-day graph with an honest label (Below
  30-day average, Trending down — could wait, At 30-day low, Near 30-day
  high). Informational only — never a recommendation to buy now.
- **Track prices daily** in Settings opts out of the background pass. The
  history already collected stays visible.

If a fetch is interrupted (restart, crash), an item that has no data yet is
marked failed and can be retried from the app; an item that already has data
stays usable.

## Gates

```
bun run typecheck
bun run lint
bun test tests/
bun run build
```

## Deployment

`sugarplum` ships as a single Bun process, so "deploy" is boring in the best
way:

```bash
bash scripts/deploy.sh
```

That pins the `main` branch, pulls, installs with the frozen lockfile, builds
the web bundle, restarts the `sugarplum.service` user unit, and health-waits
on `http://127.0.0.1:34995/api/health` up to 20×1s. A template systemd unit
lives at `packaging/systemd/sugarplum.service` — it runs
`bun run src/server/index.ts` via `mise exec` and reads
`~/.config/sugarplum/.env`:

```bash
cp packaging/systemd/sugarplum.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now sugarplum.service
```

First boot: `deploy.sh` seeds `~/.config/sugarplum/.env` (port + bind host)
and exits 3; fill in the three admin variables, install the unit, and re-run
`deploy.sh`. The production env template is `.env.production.example`. The
full operator manual (access, backup, update, rollback, restore, tunnel
cutover) lives in `docs/operations.md`.

## Roadmap

Later waves add the PWA install + share target and the price-history UI.

## Source

https://github.com/barkley-assistant/sugarplum
