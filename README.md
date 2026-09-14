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

## Gates

```
bun run typecheck
bun run lint
bun test tests/
bun run build
```

## Roadmap

Later waves add the product scraper, PWA install + share target, price
history, and deployment.