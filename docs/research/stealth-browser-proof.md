# Stealth-browser scrape proof (operator-verified 2026-09-15, residential IP)

## TL;DR — the Incapsula wall on Smyths Toys IS beatable
`invisible_playwright` (C++-patched Firefox, feder-cr) gets a full real
product page from this host with complete metadata, no proxy required.

## Evidence (real product: LEGO City 60456 Police Boat Chase, p/248662)
- Plain curl / API probes / headless Chromium (Playwright MCP): 403 or
  1KB Incapsula challenge interstitial (`/_Incapsula_Resource?` +
  `distil_referrer` + obfuscated challenge script)
- `invisible_playwright` headless=True + `--no-sandbox` +
  `--disable-dev-shm-usage`: **558KB real page**
- Extracted (JSON-LD Product block, offers is an ARRAY):
  - name: LEGO City 60456 Police Boat Chase Toy with a Floatable Speedboat and Dinghy
  - price: 21.99 GBP (offers[].price / priceCurrency)
  - image: https://image.smythstoys.com/original/800/desktop/248662.jpg
  - sku: 248662, availability: InStock
- og:title / og:image / og:type=product / og:site_name also present

## Environment facts for the plan
- Container blocks user namespaces: `--no-sandbox` required (EPERM
  `unshare(CLONE_NEWPID)` otherwise)
- Headed mode needs DISPLAY; headless works fine
- Package: `pip install invisible-playwright` + one-time
  `python -m invisible_playwright fetch` (~238MB engine, cached under
  ~/.cache/invisible-playwright)
- ~200-field Bayesian fingerprint per session, humanized input (Bezier
  mouse), seed-reproducible
- No proxy needed from the residential IP — the IP reputation is NOT the
  problem here; the headless fingerprint was

## Architecture implications for issue #13
1. Site-override framework gains a THIRD strategy: `stealth-browser`
   (invisible_playwright), on-demand per hostname
2. Challenge-solve-once + cookie persistence: browser solves the wall
   once, harvests cookies, later scrapes use server fetch WITH those
   cookies (cheap, fast) — browser only spins up when the wall appears
3. Memory cost: a Firefox engine session ~250-400MB — only on demand,
   bounded concurrency (1 at a time), on a small host that's fine
4. This is NOT per-site hacks — it's a generic capability that beats the
   whole class of JS-challenge walls (Incapsula, Akamai-lite, etc.)
5. Cost per scrape: one browser launch (~2-6s) when needed; cache the
   session/cookies per hostname to amortize
