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
| `SUGARPLUM_SESSION_TTL_DAYS` | `30` | Session lifetime |
| `SUGARPLUM_ADMIN_USERNAME` | — | Bootstrap admin username (required) |
| `SUGARPLUM_ADMIN_PASSWORD` | — | Bootstrap admin password (required) |
| `SUGARPLUM_ADMIN_DISPLAY_NAME` | — | Bootstrap admin display name |
| `SUGARPLUM_DEV` | `0` | `1` disables the Secure cookie flag (plain-HTTP LAN dev) |
| `SUGARPLUM_IMAGES_DIR` | `./data/images` | Where downloaded product images are stored (created on demand) |
| `SUGARPLUM_USER_AGENT` | Firefox desktop UA | User agent the scraper uses to fetch product pages |
| `SUGARPLUM_ENRICH_CONCURRENCY` | `2` | Max concurrent background enrichment jobs (clamped 1..8) |
| `SUGARPLUM_SEARXNG_URL` | unset | Optional self-hosted SearXNG instance for best-effort price hints (unset disables the fallback) |

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

Price snapshots are recorded to the item's price history whenever a scrape or
a hint succeeds; a history UI ships in a later wave. If a fetch is interrupted
(restart, crash), the item is marked failed on the next boot and can be
retried from the app.

## Gates

```
bun run typecheck
bun run lint
bun test tests/
bun run build
```

## Roadmap

Later waves add the PWA install + share target, the price-history UI, and
deployment.