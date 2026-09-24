# sugarplum: Product Scraping & Price Comparison Research

**Date:** 2026-09-14 · **Stack:** Bun 1.4 + bun:sqlite + React SPA · **Context:** Private 2-person wishlist tracker, low-traffic, dependency-light

Every claim below is verified by fetching a real page or endpoint. Citations use `[source-url]` with the verified data inline.

---

## Q1: PRODUCT SCRAPE — extracting {title, price, image, source-site-name}

### (a) Which major retailers ship OG / JSON-LD on product pages?

**Method:** Fetched real product pages via (1) server-side `urllib` with a desktop UA and (2) a real headless browser, then extracted `<meta property="og:*">`, `<meta name="twitter:*">`, `<meta property="product:*">`, and `<script type="application/ld+json">` containing a `Product` / `ProductGroup` schema.

| Retailer | Server fetch | Browser fetch | og:title | og:image | og:price:amount | Product JSON-LD w/ offers.price | Citation |
|---|---|---|---|---|---|---|---|
| **Amazon** (amazon.com) | 200, captcha page | captcha page | ✗ | ✗ | ✗ | ✗ | [https://www.amazon.com/dp/B0D6XT2P2H] — body is `validateCaptcha` form, 3.7KB, no meta |
| **Walmart** | 404/timeout | "Robot or human?" captcha | ✗ | ✗ | ✗ | ✗ | [https://www.walmart.com/ip/.../3560077218] — title "🐴 Robot or human?" in browser |
| **Best Buy** | timeout | chrome-error (timeout) | ✗ | ✗ | ✗ | ✗ | [https://www.bestbuy.com/site/.../6498424.p] — timed out in both server and browser |
| **Target** | 200, SSR placeholder | 200, SSR placeholder | "undefined" | ✗ | ✗ | ✗ | [https://www.target.com/p/.../A-89777515] — og:type=product but og:title="undefined", no JSON-LD, Next.js data-next-head |
| **eBay** | 403 AkamaiGHost | "Error Page \| eBay" | ✗ | ✗ | ✗ | ✗ | [https://www.ebay.com/itm/405053930875] — Server: AkamaiGHost, "robot" flag in body |
| **Etsy** | 403 DataDome | "etsy.com" (blocked) | ✗ | ✗ | ✗ | ✗ | [https://www.etsy.com/listing/1784046504/...] — Server: DataDome, 537 bytes |
| **John Lewis** | 404 | chrome-error | ✗ | ✗ | ✗ | ✗ | [https://www.johnlewis.com/lego-architecture-.../p5358535] — 404, only og:site_name present |
| **Argos** | 403 "Access Denied" | "Access Denied" | ✗ | ✗ | ✗ | ✗ | [https://www.argos.co.uk/product/8720237] — 403, 429 bytes |
| **IKEA** | 200, redirected to category | category page | "Products" | ✗ | ✗ | ✗ | [https://www.ikea.com/us/en/p/kallax-...-80275887/] — redirected to /cat/products-products/ |
| **Decathlon** (Shopify) | **200** ✅ | **200** ✅ | ✅ | ✅ | ✅ ($99.99) | ✅ (ProductGroup→Variant offers.price) | [https://www.decathlon.com/products/simond-500-extend-40-60-l-duffel-bag-156359] |
| **ColourPop** (Shopify) | **200** ✅ | **200** ✅ | ✅ | ✅ | ✅ (£25.00) | ✅ (Product, offers.price=25.00, currency=GBP) | [https://colourpop.com/products/daybreak-and-moonlight-fresh-kiss-trio] |
| **Death Wish Coffee** (Shopify) | **200** ✅ | not tested | ✅ | ✅ | ✅ ($19.99) | ✅ (Product, offers.price=19.99, USD) | [https://www.deathwishcoffee.com/products/death-wish-coffee] |
| **Uncommon Goods** | 200 | 200 | ✗ | ✗ | ✗ | ✗ (WebSite schema only, not Product) | [https://www.uncommongoods.com/product/handmade-ceramic-mug/51223] |
| **Steam** | 200 | not tested | ✅ (truncated) | ✅ | ✗ | ✗ | [https://store.steampowered.com/app/1086940/Baldurs_Gate_3/] — og:title="Save 30% on Baldur's Gate 3", og:image present, no price in meta |

**Key finding:** Every major retailer on the user's target list (Amazon, Walmart, Best Buy, Target, eBay, Etsy, John Lewis, Argos) bot-walls server-side fetches AND headless browser fetches. The meta tags / JSON-LD we need either don't exist in the blocked HTML or can't be reached. **Shopify-based stores (Decathlon, ColourPop, Death Wish Coffee) ship complete OG + JSON-LD metadata in the initial server-rendered HTML** and don't bot-wall. This is the realistically scrapeable surface.

### (b) Single npm dependency evaluation for meta/JSON-LD extraction

| Package | Latest | Last release | Deps | Bun-fit | Verdict |
|---|---|---|---|---|---|
| **metascraper** | 5.57.0 (Aug 2026) | actively maintained, weekly releases, 142K weekly downloads | `cheerio`, `@metascraper/helpers` → pulls `jsdom`, `re2` (native), `chrono-node`, `lodash`, `entities`, `normalize-url`, ~25 transitive deps | works but heavy; `re2` is a native module | [https://registry.npmjs.org/metascraper] — **avoid for sugarplum**: the `@metascraper/helpers` dependency tree is the opposite of dependency-light, and `re2`/`jsdom` add native-compilation surface Bun doesn't need |
| **unfurl.js** | 6.4.0 (Feb 2024) | **repo archived** Apr 2024, 498 stars, 44 versions, no updates in 2.5 years | `node-fetch`, `htmlparser2`, `lodash` | would work in Bun but is abandoned | [https://api.github.com/repos/jacktuck/unfurl] `archived: true` — **avoid**, unmaintained |

**Neither is worth adding.** Bun ships `HTMLRewriter` (based on Cloudflare's lol-html) which is a streaming CSS-selector-based HTML parser with element + text handlers — exactly suited for `<meta>` attribute extraction and `<script type="application/ld+json">` text accumulation. The official Bun docs include a [meta-tag extraction guide](https://bun.sh/guides/html-rewriter/extract-social-meta) showing the exact pattern. **Zero dependencies needed.**

JSON-LD extraction via HTMLRewriter: register `.on('script[type="application/ld+json"]', { text(t) { chunks.push(t.text); if (t.lastInTextNode) { tryParse(chunks.join('')); } } })` — text content arrives in chunks; concatenate until `lastInTextNode`, then `JSON.parse`. Verified pattern from [https://bun.sh/docs/runtime/html-rewriter] "Text Operations" section.

### (c) Realistic failure modes

| Failure mode | Affects | Does meta/JSON-LD sidestep it? |
|---|---|---|
| **Akamai / DataDome / PerimeterX bot walls** | Amazon (captcha), Walmart (captcha), eBay (AkamaiGHost 403), Etsy (DataDome 403), Argos (Access Denied 403), Best Buy (timeout) | **No.** These return a blocked/captcha HTML page with no product meta. Verified: Amazon's served body is a `validateCaptcha` form [https://www.amazon.com/dp/B0D6XT2P2H]; eBay's body title is "Error Page \| eBay" [https://www.ebay.com/itm/405053930875]. The scraper never sees the product page. |
| **Cookie-consent interstitials (EU sites)** | Argos, John Lewis (when not 403'd) | **Partially.** og: meta and JSON-LD are in `<head>` and usually present regardless of consent banner. But these sites also bot-wall, so the interstitial is moot. |
| **SSR placeholder / lazy-loaded prices** | Target (og:title="undefined"), Next.js sites where meta is hydrated client-side | **No.** Target ships `og:type=product` but `og:title="undefined"` and no JSON-LD in the initial HTML [https://www.target.com/p/.../A-89777515]. The real metadata only appears after client hydration. A server fetch can't see it. |
| **Lazy-loaded images** | Some React/Next.js stores | **Yes, if og:image exists.** Shopify stores put the product image URL in `og:image` server-side. |
| **Redirect to category/homepage** | IKEA | **No.** IKEA redirects product URLs to a category page when it detects a non-browser fetch [https://www.ikea.com/us/en/p/kallax-...-80275887/] → final URL `/cat/products-products/`. |

**Implication:** For the bot-walled retailers, there is no lightweight server-side solution. The wishlist user pasting an Amazon link will get a graceful "couldn't extract — please enter title/price manually" fallback. This is acceptable for a private two-person app.

### (d) Image extraction pipeline (beyond og:image)

Ordered fallback:
1. `og:image` — present on Shopify stores, Steam, most sites with meta. [https://colourpop.com/products/...] ships `og:image=http://colourpop.com/cdn/shop/files/...jpg`.
2. **Product JSON-LD `image` field** — Shopify Product schema includes `image: "https://...cdn/shop/files/...jpg"` [https://colourpop.com/...] JSON-LD block. For `ProductGroup`, check `hasVariant[].image`.
3. **Twitter `twitter:image`** — rarely present (ColourPop, Decathlon: absent). Don't rely on it.
4. **`<link rel="icon">` / favicon** — last-resort fallback so the wishlist entry always has *some* visual. Verified present on Decathlon (`//www.decathlon.com/cdn/shop/files/favicon-large.png`), Death Wish, ColourPop. Resolve relative URLs with `new URL(favicon, pageUrl)`.

---

## Q2: PRICE COMPARISON ("cheapest price elsewhere")

### (a) Free, no-API-key candidates

| Source | Works from server? | Returns prices? | Bot-walled? | Citation |
|---|---|---|---|---|
| **Google Shopping (direct scrape)** | No — Google aggressively bot-walls | N/A | Yes | Not directly tested (known behavior); Google Shopping returns 429/503 to non-browser fetches and even blocks headless browsers with "unusual traffic" captchas |
| **SearXNG (self-hosted, http://192.168.0.200:35000)** | **Yes** — JSON API, `?format=json` | **Partially** — prices appear in result snippets but not structured | No (self-hosted) | [http://192.168.0.200:35000/search?q=LEGO+21042+Statue+of+Liberty+buy&format=json] — 47 results, 4 with parseable prices (£50, $35, $120, £82.59) |
| **PriceRunner / PriceSpy (scraping result URLs)** | Not tested individually — but these are themselves price-comparison sites that would need per-site scraping | Unknown | Likely | SearXNG returned PriceRunner (£96.05) and PriceSpy URLs as results; scraping them would be a second hop with its own bot-wall risk |

### (b) SearXNG detailed evaluation (verified against the live instance)

**JSON API works from server context:** `GET http://192.168.0.200:35000/search?q=<query>&format=json` returns `{"results": [...]}` with `{title, url, content, engine}` fields. Response time: 0.6–0.95s per query. [http://192.168.0.200:35000/search?q=AirPods+Pro+2&format=json] — 200, 40 results.

**Engines active:** `google cse` (20 results) and `brave` contribute. The `shopping` category returned **0 results** — the Google Shopping engine is not enabled on this instance. Only `general` category works.

**Price extraction from snippets:** Prices appear as substrings in `title` + `content`, e.g. `"LEGO Architecture 21042 Statue of Liberty - John Lewis & Partners"` with `£50.` in the snippet, or `"LEGO Architecture Statue of Liberty ... : Target"` with `$35`. A regex `[$£€]\d+\.?\d{0,2}` extracts them. [http://192.168.0.200:35000/search?q=LEGO+21042+Statue+of+Liberty+buy&format=json] found: Target $35, John Lewis £50, Brickset $120 (review site — noise), Toy Street £82.59.

**Signal-to-noise assessment (verified):**
- **Death Wish Coffee 16oz:** 40 results, 6 with prices — but prices range £32.72 (EveryMarket UK), $16.16 (TechBargains), $4, $1 (grocery store listings for a different product format). Mixed currencies, mixed products, mixed formats. [http://192.168.0.200:35000/search?q=Death+Wish+Coffee+16oz+Dark+Roast+buy&format=json]
- **ColourPop Daybreak trio:** 37 results, 25 with prices — but $10 results are *different ColourPop products* (collections page, lip care page), $35 is a different trio ("Get Rich"), £23.14 / £2.94 are eBay reseller listings. The actual product ($25.00 from the product page) does not appear with a price in search. [http://192.168.0.200:35000/search?q=ColourPop+Daybreak+and+Moonlight+Fresh+Kiss+Trio+buy&format=json]
- **Secret History (book):** 46 results, 5 with prices — £3.25 (eBay used), $20 (ThriftBooks), £25 (HMV), $35 (Target hardcover — different edition). Different editions/formats混ed. [http://192.168.0.200:35000/search?q=The+Secret+History+Donna+Tartt+paperback+buy&format=json]

**Problems:**
1. Prices are unstructured snippets, not a structured field — must regex-parse.
2. Mixed currencies (£, $, €) with no currency normalization.
3. High noise: same search returns the product's own listing, review sites (Brickset), category pages, different variants/editions, and eBay reseller listings.
4. No way to confirm "same product" without fetching each result URL (which then hits bot walls).
5. The `shopping` category is disabled; only `general` returns results, and general search is not product-optimized.

### (c) Honest verdict on price comparison

**Price comparison is NOT a v1 feature. It is a best-effort "we saw it for £X elsewhere" hint at best, and probably not worth shipping in v1.**

Reasons:
- SearXNG returns prices in snippets but the signal-to-noise is too poor for reliable "cheapest price" claims. A £3.25 eBay used-book result next to a $35 Target hardcover is not a meaningful comparison.
- The only structured-price sources (Google Shopping API, PriceRunner API, PriceSpy API) all require API keys and/or payment.
- Self-hosting a price comparison engine is out of scope for a 2-person wishlist app.
- The product scrape itself (Q1) already fails for the biggest retailers, so "search elsewhere for the same product" would often start from a manually-entered title, making any price comparison even less reliable.

**If attempted later (post-v1):** The only viable path is SearXNG + regex price extraction from snippets, displayed as "Search found these listings (unverified):" with a disclaimer. It would be a curiosity feature, not a reliable price tracker.

---

## RECOMMENDATION

### Scrape pipeline (exact steps, ordered)

```
1. fetch(url, { headers: { "User-Agent": "Mozilla/5.0 ...", "Accept": "text/html", "Accept-Encoding": "gzip" } })
   → if status != 200 or body < 2KB: fall through to manual entry
   → detect bot walls: if body contains "captcha" / "Access Denied" / "validateCaptcha" / DataDome: abort, fall through

2. new HTMLRewriter()
     .on('meta[property^="og:"]', { element(el) → og[property] = content })
     .on('meta[property^="product:"]', { element(el) → product[property] = content })
     .on('meta[name^="twitter:"]', { element(el) → twitter[name] = content })
     .on('script[type="application/ld+json"]', { 
         element(el) → start buffer,
         text(t) → buffer += t.text; if t.lastInTextNode → JSON.parse(buffer), push to jsonld[]
     })
     .on('link[rel~="icon"], link[rel="shortcut icon"]', { element(el) → favicon = el.getAttribute("href") })
     .on('title', { text(t) → titleTag = t.text (take first chunk) })
   .transform(response).blob()  // or .text()

3. Extract:
   title       = og["og:title"] ?? twitter["twitter:title"] ?? jsonldProduct.name ?? titleTag
   price       = og["og:price:amount"] ?? product["product:price:amount"] ?? jsonldProduct.offers.price ?? jsonldVariant.offers.price
   currency    = og["og:price:currency"] ?? product["product:price:currency"] ?? jsonldProduct.offers.priceCurrency
   image       = og["og:image"] ?? jsonldProduct.image ?? jsonldVariant.image ?? favicon (resolved absolute)
   siteName    = og["og:site_name"] ?? new URL(url).hostname.replace("www.","")

4. JSON-LD Product walk: for each jsonld block, recursively search for @type ∈ {Product, ProductGroup};
   if ProductGroup: check hasVariant[0].offers.price as fallback.
   Normalize image URLs: if starts with "//", prepend "https:"; if relative, resolve against page URL.

5. Return { title, price, currency, image, siteName, sourceUrl: url } or { error: "could not extract" }
```

**Dependencies to add:** NONE. Use Bun's built-in `HTMLRewriter` [https://bun.sh/docs/runtime/html-rewriter] + `fetch` + `JSON.parse`.

**Dependencies to avoid:**
- `metascraper` — pulls cheerio + jsdom + re2 (native) + 25 transitive deps, unnecessary for this scope.
- `unfurl.js` — repo archived April 2024, unmaintained.
- Any Puppeteer/Playwright — no browser automation available on the target server, and the biggest retailers block headless browsers anyway.

**Expected coverage:** Shopify-based stores (Decathlon, ColourPop, Death Wish, indie Shopify stores) → full extraction. Steam, Bandcamp, most blogs/indie sites → title + image, no price. Amazon, Walmart, eBay, Etsy, Best Buy, Target, Argos, John Lewis, IKEA → graceful failure (bot wall), user enters manually.

> **Superseded for Amazon (2026-09-15):** a plain fetch passes Amazon's wall
> from this host and the served HTML carries product data in id-anchored DOM
> blocks — see §"2026-09-15 Amazon ground truth" below. The 2026-09-14 row
> below is kept as history.

### Price comparison verdict

**Not a v1 feature. Ship the product scrape first; revisit price comparison only if users actively request it, and then only as an unverified "SearXNG found these listings" hint with a disclaimer — never as a reliable "cheapest price" claim.**

---

## Verification log

All claims verified by fetching live pages/endpoints on 2026-09-14:

- Amazon: `urllib` fetch → 3.7KB captcha form
- Walmart: browser → "Robot or human?" captcha
- Best Buy: server + browser → timeout
- Target: server → 135KB, og:title="undefined", no JSON-LD
- eBay: server → 403 AkamaiGHost
- Etsy: server → 403 DataDome
- John Lewis: server → 404
- Argos: server → 403 "Access Denied"
- IKEA: server → redirected to category page
- Decathlon (Shopify): server → 200, og:price:amount=99.99, JSON-LD ProductGroup
- ColourPop (Shopify): server + browser → 200, og:price:amount=25.00, JSON-LD Product offers.price=25.00
- Death Wish Coffee (Shopify): server → 200, og:price:amount=19.99, JSON-LD Product offers.price=19.99
- Uncommon Goods: server → 200, WebSite JSON-LD only (no Product)
- Steam: server → 200, og:title + og:image, no price meta
- SearXNG: `GET http://192.168.0.200:35000/search?format=json&q=...` → 200, 20-47 results, prices parseable from snippets, 0.6-0.95s response
- metascraper: npm registry → v5.57.0, deps include cheerio + @metascraper/helpers (jsdom, re2, chrono-node)
- unfurl.js: GitHub API → `archived: true`, last push 2024-04-09
- Bun HTMLRewriter: [https://bun.sh/docs/runtime/html-rewriter] + [https://bun.sh/guides/html-rewriter/extract-social-meta]

---

## 2026-09-15 Amazon ground truth (wave 12)

Measured on this host against `www.amazon.co.uk` with the REAL pipeline
(`bun run scripts/amazon-probe.ts`) and the REAL stealth helper. Re-verify any
time with `bash scripts/amazon-smoke.sh` — live Amazon, never in CI.

| # | Fact |
|---|------|
| F1 | Plain `fetchPage` gets a **200 with the full real page** (2.4–2.7MB) — no captcha, no bot wall from this IP. Both probe ASINs: `ok strategy=plain`, ~1.6–2.1s, no stealth needed. |
| F2 | Amazon ships **zero** `og:*` metas, **zero** JSON-LD and **zero** microdata on any transport (plain and stealth pages alike). |
| F3 | `<title>` is always present and clean; `img#landingImage[data-old-hires]` carries the SL1500 hi-res gallery image. |
| F4 | Price presence is **ASIN-dependent**. With a featured offer the offer floor sits in `#aod-ingress-link` ("New (19) from £19.00") and `#corePrice*`; without one there is **no main-ASIN price anywhere** — `#corePrice_desktop` renders EMPTY and the buybox is "See All Buying Options". B0DLGMVR4C → `price=1900 cur=GBP`; B0BPCCKL3N → `price=null` (honest). |
| F5 | Waiting does not help: a live DOM poll every 2s for 27s never saw the buybox appear; page bytes static after 5.7s. (planning probe, `/tmp/wait-probe.py`) |
| F6 | Every other `.a-price` on the page belongs to a DIFFERENT ASIN: a recommendation carousel EARLIER in the document (£24.88) and a sponsored `sp_detail` carousel LATER (£21.99, ASIN B0HCJFVT3Z). Anchoring to `#aod-ingress-link` / `div[id^=corePrice]` ids keeps them out — **and the capture must be disarmed on the element's end tag**, or the empty buybox block leaks the sponsored price into the result (observed on the real page until that fix landed; `tests/fixtures/amazon-dp*.html` now encode both traps). |
| F7 | `/gp/offer-listing/<asin>` redirects back to `/dp/…?aod=1` and the AOD ajax endpoints return 404 unauthenticated — chasing offers is a dead end. (planning probe) |

Shipped in wave 12: a generic (site-agnostic) DOM fallback tier in
`src/server/scraper/parse.ts`; `amazon.co.uk/.com/.de` registry entries in
`src/server/scraper/overrides.ts` (plain-first with a stealth fallback — flip
the order in one line if the IP reputation changes); and a labelled SearXNG
price/image backstop for items whose page yields no price or no image.

**Stealth transport returns the same shape.** The 2026-09-15 smoke run also
fetched both probe ASINs through the stealth helper (`invisible_playwright`,
`ok=True status=200`, 2.36MB / 2.50MB pages) and extraction produced the exact
same title, price and image as the plain pass. The extraction is therefore
transport-independent: plain-first is a latency choice (~1.6–1.9s vs a browser
launch), not a correctness one.

Honest limits: when Amazon has no featured offer the price is genuinely absent,
so the item stays price-less with a hint at best; the `#aod-ingress-link`
number is the cheapest NEW offer floor, not necessarily the buybox price; and
the `amazon.*` markup shapes were verified on `.co.uk` only (the generic
extractor degrades to title-only elsewhere, never to a wrong value).

---

## 2026-09-15 Steam ground truth (wave 14)

Measured on this host against `store.steampowered.com` with the production
Firefox UA and the REAL pipeline (`bun run scripts/steam-probe.ts`). Re-verify
any time with that probe — live Steam, never in CI. Saved pages from the probe
run: `/tmp/steam-live-*.html` (transient).

The issue's two hypotheses were both wrong: `og:title` is *not* clean, and
there is *no* embedded JSON/JSON-LD price on a Steam app page. Measured facts:

| # | Fact |
|---|------|
| S1 | **Title pollution lives in `og:title` itself.** During a sale both `<title>` and `og:title` read `Save 30% on Baldur's Gate 3 on Steam`; without a sale they read `Risk of Rain 2 on Steam`. Steam ships **zero** `application/ld+json` blocks and no `og:price:*`, so re-prioritizing metadata tiers cannot clean the title — a strip is required. |
| S2 | Steam's site token sits in a **nonstandard `og:site`** meta (`content="Steam"`), not `og:site_name`. The siteName chain now reads `og:site_name` → `og:site` → hostname. |
| S3 | **Mature apps 302 to `/agecheck/app/<id>/`** — a ~52KB shell with a promo-laden `og:title`/`og:image` and **no purchase block, no `data-price-final`, no `apphub_AppName`**. This is what a plain scrape gets for age-gated games (title, no price). Sending `Cookie: birthtime=347077200; lastagecheckage=1-0-1980` returns the full ~150–230KB purchase page — verified through `fetchPage` and end-to-end via the probe (`strategy=custom-headers`). |
| S4 | **Price = the FIRST `div.game_area_purchase_game` block.** Every later block is DLC/bundle with a different price (the anchoring trap, encoded in `tests/fixtures/steam-discounted.html`). Three measured shapes: discounted → `.discount_final_price` (BG3 `£34.99`, `data-price-final="3499"`); plain → `.game_purchase_price.price` (Cyberpunk 2077 / ELDEN RING `£49.99`, `data-price-final="4999"`); free-to-play → `game_purchase_price` with **no** `data-price-final` and text `Free To Play` (Dota 2) → price **null**, not 0. |
| S5 | **`HTMLRewriter` does NOT decode entities in text nodes.** A price node written `&pound;34.99` arrives as the literal string `&pound;34.99`. Live Steam markup carries a literal `£`, but entity-encoded price text is a real shape (and what the fixtures encode), so the Steam tier decodes the currency entities + numeric character references before parsing. |
| S6 | **The `/akamai/` bot-wall pattern was a false positive.** Steam pages that reference `*.akamai.steamstatic.com` assets (Chrome-UA transport) were classified `botwall` on every page; the pattern was also dead weight for eBay, whose block page (403, "Error Page \| eBay", 1.8KB) contains no "akamai" in the body — AkamaiGHost is a response *header* `detectBotWall` never reads. Pattern removed; eBay is still caught by the 403 → `reason:"http"` path. |

Shipped in wave 14: a **generic** promo-prefix/site-suffix strip
(`stripStoreTitleNoise`, applied to the chosen title candidate using only the
declared `og:site(_name)` token — no hostname checks); `og:site` admitted to the
siteName chain; a Steam purchase-block DOM tier in `parse.ts` (first block only,
fills nulls only, after the Amazon tier); a `store.steampowered.com` registry
entry (`custom-headers` with the age cookie → `plain` fallback); and the akamai
pattern deletion.

Live probe output for the wave-14 manual proof (2026-09-15, from this host):

```
$ bun run scripts/steam-probe.ts https://store.steampowered.com/app/1086940/Baldurs_Gate_3/
ok strategy=custom-headers ms=357 title="Baldur's Gate 3" price=3499 cur=GBP site=Steam image=https://shared.fastly.steamstatic.com/...

$ bun run scripts/steam-probe.ts https://store.steampowered.com/app/1091500/Cyberpunk_2077/
ok strategy=custom-headers ms=301 title="Cyberpunk 2077" price=4999 cur=GBP site=Steam image=https://shared.fastly.steamstatic.com/...

$ bun run scripts/steam-probe.ts https://store.steampowered.com/app/570/Dota_2/
ok strategy=custom-headers ms=361 title="Dota 2" price=null cur=null site=Steam image=https://shared.fastly.steamstatic.com/...
```

Honest limits: currency coverage stays £/€/$ (Steam regional prices in ₽/¥/R$
→ null price, never a wrong one); free-to-play games report no price by design;
Steam's store edge returned intermittent HTTP 500s with an empty body for some
app ids during the probe run (e.g. `/app/632360/`), which surfaces as
`reason:"http"` after both strategies — a Steam-side flake, reproduced without
our headers; already-stored items whose title was polluted before this wave are
not rewritten (re-add or edit them); and if Steam renames the purchase-block
classes the tier degrades to title-only rather than to a wrong price.

---

## 2026-09-24 VideoGamePerfection AggregateOffer (#159)

`videogameperfection.com` product pages ship Yoast SEO JSON-LD: one `@graph`
block containing a `BreadcrumbList` and a `Product` whose `offers` is an ARRAY
holding one `AggregateOffer` with `lowPrice`/`highPrice`/`offerCount`/
`priceCurrency` (all strings). The parser read `offers.price`, which is
undefined on an array — the JSON-LD tier silently contributed nothing and the
item stored no direct price, even though the transport never failed. Fixed by
shape-tolerant offer selection in `findProductNode` (lowest valid price;
AggregateOffer.lowPrice), with no hostname branch. Fixture:
`tests/fixtures/vgp-aggregate-offer.html` (295.00 EUR).

Transport ground truth, measured 2026-09-24 from the deploy host with the
production plain UA: six VGP product URLs all returned HTTP 200 with 285-449 KB
bodies (`server: Sucuri/Cloudproxy` is a CDN, not a challenge), and
`scrapeProduct` resolved `strategy: "plain"` in one step. NO entry was added to
`SITE_OVERRIDES`: the issue's "Sucuri 403" was vantage-point-specific, and an
override would force a browser launch on a host that plain-fetches fine (and
would stop the host from learning, per #103). If VGP ever does start blocking,
the default chain's escalation plus the learned-override promotion covers it.
