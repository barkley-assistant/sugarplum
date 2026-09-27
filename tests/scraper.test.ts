import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { serve } from "bun";
import {
  extractProduct,
  findAsosProductId,
  parseSymbolPriceToCents,
  pickAsosPrice,
  resolveDomPrice,
  stripStoreTitleNoise,
  type DomPrice,
} from "../src/server/scraper/parse";
import { scrapeProduct } from "../src/server/scraper";
import { fetchPage, detectBotWall, extractMetaRefreshTarget } from "../src/server/scraper/fetch";
import type { StealthRunner } from "../src/server/scraper/stealth";
import type { SearxngFetch } from "../src/server/searxng";

const FIXTURES = join(import.meta.dir, "fixtures");
const PAGE_URL = "https://colourpop.example.com/products/fresh-kiss-trio";

/** Synthetic Akamai bm-verify material — the same values the interstitial
 *  fixture ships (tests/fixtures/bershka-interstitial.html). The token is
 *  obviously synthetic by design: no live token ever enters the repo. */
const BM_TOKEN = "AAQAAAAO_____SYNTHETIC_TOKEN_FOR_TESTS__AAAA";
const BM_TARGET_PATH = `/gb/example-product-c0p000000000.html?colorId=505&bm-verify=${BM_TOKEN}`;
const BM_INTERSTITIAL = "bershka-interstitial.html";
const BM_PDP = "bershka-pdp.html";
const BM_MARKERS = [
  "bm-verify=",
  "/_sec/verify",
  "triggerinterstitialchallenge",
  "/interstitial/ic.html",
];

async function readFixture(name: string) {
  return Bun.file(join(FIXTURES, name)).text();
}

async function parseFixture(name: string, pageUrl = PAGE_URL) {
  return extractProduct(await readFixture(name), pageUrl);
}

describe("extractProduct", () => {
  test("shopify-style: og + JSON-LD Product → full extraction", async () => {
    const p = await parseFixture("shopify.html");
    expect(p.title).toBe("Fresh Kiss Trio");
    expect(p.priceCents).toBe(2500);
    expect(p.currency).toBe("USD");
    expect(p.image).toBe("https://cdn.example.com/trio.jpg");
    expect(p.siteName).toBe("ColourPop");
  });
  test("json-ld product-group: price via hasVariant[0].offers", async () => {
    const p = await parseFixture("productgroup.html");
    expect(p.priceCents).toBe(9999);
    expect(p.currency).toBe("USD");
  });
  test("twitter-only page: twitter:title wins over title tag", async () => {
    const p = await parseFixture("twitter.html");
    expect(p.title).toBe("Steam-ish Title");
    expect(p.image).toBe("https://cdn.example.com/header.jpg");
  });
  test("no-meta page: falls back to <title> + favicon, relative URL resolved absolute", async () => {
    const p = await parseFixture("nometa.html");
    expect(p.title).toBe("Just A Shop");
    expect(p.image).toBe("https://justashop.example.com/favicon.ico");
    expect(p.priceCents).toBeNull();
  });
  test("protocol-relative image url (//cdn…) → https://", async () => {
    const p = await parseFixture("relative-og.html");
    expect(p.image).toBe("https://cdn.example.com/img/a.jpg");
  });
  test("malformed ld+json skipped; offers.price as JSON number parsed", async () => {
    const p = await parseFixture("mixed-ld.html");
    expect(p.priceCents).toBe(1999);
  });
  test("price garbage (og:price:amount='abc') → null, never NaN", async () => {
    const p = await parseFixture("badprice.html");
    expect(p.priceCents).toBeNull();
  });
  test("wave14: og:title with sale banner + ' on Steam' suffix → clean name", async () => {
    const html = `<!DOCTYPE html><html><head>
    <meta property="og:title" content="Save 30% on Baldur's Gate 3 on Steam">
    <meta property="og:site" content="Steam">
    <title>Save 30% on Baldur's Gate 3 on Steam</title>
  </head><body></body></html>`;
    const p = await extractProduct(html, "https://store.steampowered.com/app/1086940/");
    expect(p.title).toBe("Baldur's Gate 3");
    expect(p.siteName).toBe("Steam"); // og:site joins the siteName chain
  });
  test("#90: named entity in og:title is decoded (not stored as &amp;)", async () => {
    const html = `<!DOCTYPE html><html><head>
    <meta property="og:title" content="Toys &amp; Games">
    <meta property="og:site_name" content="Amazon.co.uk">
    <title>Toys &amp; Games</title>
  </head><body></body></html>`;
    const p = await extractProduct(html, "https://www.amazon.co.uk/dp/B0DLGMVR4C");
    expect(p.title).toBe("Toys & Games");
  });
  test("#90: numeric character reference in og:title is decoded", async () => {
    const html = `<!DOCTYPE html><html><head>
    <meta property="og:title" content="Caf&#233; Set &#8364;24">
  </head><body></body></html>`;
    const p = await extractProduct(html, "https://shop.example.com/cafe");
    expect(p.title).toBe("Café Set €24");
  });
});

describe("extractProduct JSON-LD offer shapes (#159)", () => {
  const VGP = "https://videogameperfection.com/products/ossc-pro/";

  test("array-of-AggregateOffer: lowPrice + priceCurrency, title/image intact", async () => {
    const p = await parseFixture("vgp-aggregate-offer.html", VGP);
    expect(p.priceCents).toBe(29500); // lowPrice, NOT highPrice 329.50
    expect(p.priceCents).not.toBe(32950);
    expect(p.currency).toBe("EUR");
    expect(p.title).toBe("Open Source Scan Converter (OSSC) Pro");
    expect(p.image).toBe(
      "https://videogameperfection.com/wp-content/uploads/2023/11/ossc-pro-in-black-case1.webp",
    );
    expect(p.siteName).toBe("VideoGamePerfection.com");
  });

  test("the issue's repro shape (lowPrice 115.00, highPrice 148.49, EUR)", async () => {
    const html = `<!DOCTYPE html><html><head>
      <script type="application/ld+json">
      {"@context":"https://schema.org/","@type":"Product","name":"Retro Cable",
       "offers":[{"@type":"AggregateOffer","lowPrice":"115.00","highPrice":"148.49","offerCount":7,"priceCurrency":"EUR"}]}
      </script></head><body></body></html>`;
    const p = await extractProduct(html, "https://videogameperfection.com/products/cable/");
    expect(p.priceCents).toBe(11500);
    expect(p.currency).toBe("EUR");
  });

  test("array of concrete Offers → LOWEST valid price wins", async () => {
    const html = `<!DOCTYPE html><html><head>
      <script type="application/ld+json">
      {"@context":"https://schema.org/","@type":"Product","name":"Cable",
       "offers":[{"@type":"Offer","price":"20.00","priceCurrency":"EUR"},
                 {"@type":"Offer","price":"15.00","priceCurrency":"EUR"}]}
      </script></head><body></body></html>`;
    const p = await extractProduct(html, VGP);
    expect(p.priceCents).toBe(1500);
    expect(p.currency).toBe("EUR");
  });

  test("AggregateOffer with neither a valid lowPrice nor price → null, never 0/NaN", async () => {
    for (const bad of ["abc", "-5.00", "9999999.00", "", null]) {
      const offers = JSON.stringify([
        { "@type": "AggregateOffer", lowPrice: bad, priceCurrency: "EUR" },
      ]);
      const html = `<!DOCTYPE html><html><head>
        <script type="application/ld+json">
        {"@context":"https://schema.org/","@type":"Product","name":"Cable","offers":${offers}}
        </script></head><body></body></html>`;
      const p = await extractProduct(html, VGP);
      expect(p.priceCents).toBeNull();
      expect(p.currency).toBeNull();
    }
    // Boundary: 0.01 IS a valid price (1 cent) and must be kept, not dropped
    // by the "is it present?" check.
    const boundary = JSON.stringify([
      { "@type": "AggregateOffer", lowPrice: "0.01", priceCurrency: "EUR" },
    ]);
    const bp = await extractProduct(
      `<!DOCTYPE html><html><head><script type="application/ld+json">{"@type":"Product","name":"X","offers":${boundary}}</script></head><body></body></html>`,
      VGP,
    );
    expect(bp.priceCents).toBe(1);
    expect(bp.currency).toBe("EUR");
  });

  test("lowPrice 0.00 (genuinely free) is kept, not treated as missing", async () => {
    const html = `<!DOCTYPE html><html><head>
      <script type="application/ld+json">
      {"@context":"https://schema.org/","@type":"Product","name":"Free Cable",
       "offers":[{"@type":"AggregateOffer","lowPrice":"0.00","highPrice":"0.00","priceCurrency":"EUR"}]}
      </script></head><body></body></html>`;
    const p = await extractProduct(html, VGP);
    expect(p.priceCents).toBe(0);
    expect(p.currency).toBe("EUR");
  });

  test("invalid aggregate does not block the DOM tier (price still found)", async () => {
    // The JSON-LD tier must degrade to "nothing" so the DOM tiers run — the
    // partial-success contract.
    const html = `<!DOCTYPE html><html><head>
      <script type="application/ld+json">
      {"@context":"https://schema.org/","@type":"Product","name":"Cable",
       "offers":[{"@type":"AggregateOffer","lowPrice":"abc","priceCurrency":"EUR"}]}
      </script></head><body>
      <div class="game_area_purchase_game"><div class="game_purchase_price price">&#163;9.99</div></div>
      </body></html>`;
    const p = await extractProduct(html, "https://store.steampowered.com/app/632360/");
    expect(p.priceCents).toBe(999);
    expect(p.currency).toBe("GBP");
  });

  test("object-shaped offers (regression guard for shopify/productgroup)", async () => {
    const html = `<!DOCTYPE html><html><head>
      <script type="application/ld+json">
      {"@context":"https://schema.org/","@type":"Product","name":"Trio","offers":{"price":99.99,"priceCurrency":"USD"}}
      </script></head><body></body></html>`;
    const p = await extractProduct(html, "https://colourpop.example.com/x");
    expect(p.priceCents).toBe(9999);
    expect(p.currency).toBe("USD");
  });

  test("tier-1 still wins: og:price beats the AggregateOffer tier", async () => {
    const base = await Bun.file(join(FIXTURES, "vgp-aggregate-offer.html")).text();
    const html = base.replace(
      "<title>",
      `<meta property="og:price:amount" content="31.15"><meta property="og:price:currency" content="GBP"><title>`,
    );
    const p = await extractProduct(html, VGP);
    expect(p.priceCents).toBe(3115);
    expect(p.currency).toBe("GBP");
  });
});

describe("extractProduct DOM fallback tier (no og/json-ld pages)", () => {
  const AMAZON_DP = "https://www.amazon.co.uk/dp/B0DLGMVR4C";
  const AMAZON_NOOFFER = "https://www.amazon.co.uk/dp/B0BPCCKL3N";

  test("amazon-shaped: aod-ingress price + data-old-hires image, no og/json-ld", async () => {
    const p = await parseFixture("amazon-dp.html", AMAZON_DP);
    expect(p.priceCents).toBe(1900);
    expect(p.currency).toBe("GBP");
    expect(p.image).toBe("https://m.media-amazon.com/images/I/81I0WIRzQ9L._AC_SL1500_.jpg");
    expect(p.title).toBe("Playmobil Pirates Danger from Giant Shark 71793");
  });

  test("no-featured-offer page: picks NO price (other-ASIN carousel widget ignored)", async () => {
    const p = await parseFixture("amazon-dp-nooffer.html", AMAZON_NOOFFER);
    expect(p.priceCents).toBeNull(); // honest: no main-ASIN price exists in the DOM
    expect(p.currency).toBeNull();
    // Both traps explicitly: the carousel BEFORE the (empty) buybox block and
    // the sponsored carousel AFTER it.
    expect(p.priceCents).not.toBe(2488);
    expect(p.priceCents).not.toBe(2199);
    expect(p.image).toMatch(/^https:\/\/m\.media-amazon\.com\/images\/I\//);
    expect(p.title).toContain("LEGO City Explorer Diving Boat");
  });

  test("tier-1 wins when present: og:price beats the .a-price DOM tier", async () => {
    // shopify.html proves tier 1; appending Amazon-shaped price markup guarded
    // by nothing must NOT shadow it (tier 2 only ever fills nulls).
    const base = await Bun.file(join(FIXTURES, "shopify.html")).text();
    const html = `${base}<a id="aod-ingress-link"><span class="a-price"><span class="a-offscreen">£99.99</span></span></a>`;
    const p = await extractProduct(html, PAGE_URL);
    expect(p.priceCents).toBe(2500); // og:price, not 9999
    expect(p.currency).toBe("USD");
  });

  test("first .a-price in the document is NOT the answer (anchor discipline)", async () => {
    // Regression guard for the trap encoded in amazon-dp.html: £24.88 (other
    // ASIN, carousel) precedes the main ASIN's £19.00.
    const p = await parseFixture("amazon-dp.html", AMAZON_DP);
    expect(p.priceCents).not.toBe(2488);
  });
});

describe("extractProduct DOM buying-option condition (#160)", () => {
  const AMAZON_ACCORDION = "https://www.amazon.co.uk/dp/B0DWDDNK1Q";
  const AMAZON_NOATTR = "https://www.amazon.co.uk/dp/B0FPXD23ST";
  const AMAZON_USED_ONLY = "https://www.amazon.co.uk/dp/B0C1USEDON";
  const AMAZON_RENEWED = "https://www.amazon.co.uk/dp/B0RENEWED1";
  const AMAZON_NEW_ONLY = "https://www.amazon.co.uk/dp/B0DLGMVR4C";

  test("mixed accordion: a third-party seller's NEW block wins, the used floor is never returned", async () => {
    const html = await Bun.file(join(FIXTURES, "amazon-dp-mixed-accordion.html")).text();
    // The accepted NEW offer is explicitly NOT sold by Amazon — the condition,
    // not the seller, is the filter.
    expect(html).toContain("Sold by GadgetBay UK");
    const p = await extractProduct(html, AMAZON_ACCORDION);
    expect(p.priceCents).toBe(3497); // the NEW block, not the £26.25 floor
    expect(p.priceCents).not.toBe(2625);
    expect(p.currency).toBe("GBP");
  });

  test("mixed page with no condition attribute: featured offer kept, all-conditions floor rejected", async () => {
    const p = await parseFixture("amazon-dp-mixed-noattr.html", AMAZON_NOATTR);
    expect(p.priceCents).toBe(1300); // the featured corePrice offer
    expect(p.priceCents).not.toBe(1252); // the ingress floor
    expect(p.currency).toBe("GBP");
  });

  test("used-only page: no direct price, even with a new-conditioned ingress", async () => {
    const p = await parseFixture("amazon-dp-used-only.html", AMAZON_USED_ONLY);
    expect(p.priceCents).toBeNull();
    expect(p.currency).toBeNull();
    expect(p.priceCents).not.toBe(1450);
  });

  test("renewed block rejected: the NEW block wins, not the cheaper renewed one", async () => {
    const p = await parseFixture("amazon-dp-mixed-renewed.html", AMAZON_RENEWED);
    expect(p.priceCents).toBe(5299);
    expect(p.priceCents).not.toBe(4799);
    expect(p.currency).toBe("GBP");
  });

  test("existing new-only fixture is unchanged by the condition tier", async () => {
    const p = await parseFixture("amazon-dp.html", AMAZON_NEW_ONLY);
    expect(p.priceCents).toBe(1900);
    expect(p.currency).toBe("GBP");
  });
});

describe("resolveDomPrice (#160 branch table)", () => {
  const none: DomPrice = { text: null, condition: null };

  test("NEW block wins over a cheaper all-conditions ingress", () => {
    const p = resolveDomPrice(
      { text: "£26.25", condition: null },
      "ALL",
      { text: "£34.97", condition: "NEW" },
      true,
    );
    expect(p).toEqual({ cents: 3497, currency: "GBP" });
  });

  test("non-new block → no price, even when the ingress is new-conditioned", () => {
    const p = resolveDomPrice(
      { text: "£14.50", condition: null },
      "NEW",
      { text: "£14.50", condition: "USED" },
      true,
    );
    expect(p).toBeNull();
  });

  test("every non-new condition is rejected, not just USED", () => {
    for (const condition of ["RENEWED", "REFURBISHED", "OPEN_BOX", "UNKNOWN", "PRE_OWNED"]) {
      expect(
        resolveDomPrice(none, "NEW", { text: "£10.00", condition }, true),
      ).toBeNull();
    }
  });

  test("new-only page: the new-conditioned ingress is the price (unchanged behaviour)", () => {
    const p = resolveDomPrice({ text: "£19.00", condition: null }, "NEW", none, false);
    expect(p).toEqual({ cents: 1900, currency: "GBP" });
  });

  test("conditionDeclared false + non-new ingress → the featured corePrice offer", () => {
    const p = resolveDomPrice({ text: "£12.52", condition: null }, "ALL", { text: "£13.00", condition: null }, false);
    expect(p).toEqual({ cents: 1300, currency: "GBP" });
  });

  test("conditionDeclared true with only a null-condition block → no price", () => {
    expect(
      resolveDomPrice({ text: "£12.52", condition: null }, "ALL", { text: "£13.00", condition: null }, true),
    ).toBeNull();
  });

  test("unrecognised condition on the only block: no NEW ingress → no price", () => {
    expect(
      resolveDomPrice(none, "ALL", { text: "£10.00", condition: "COLLECTIBLE_PLUS" }, true),
    ).toBeNull();
  });

  test("unrecognised condition on the only block: NEW ingress still wins", () => {
    const p = resolveDomPrice(
      { text: "£9.50", condition: null },
      "NEW",
      { text: "£10.00", condition: "COLLECTIBLE_PLUS" },
      true,
    );
    expect(p).toEqual({ cents: 950, currency: "GBP" });
  });

  test("no price captured anywhere → null (no price invented)", () => {
    expect(resolveDomPrice(none, null, none, false)).toBeNull();
    expect(resolveDomPrice(none, "NEW", { text: null, condition: "NEW" }, true)).toBeNull();
  });
});

describe("extractProduct Steam tier (wave 14)", () => {
  const STEAM = "https://store.steampowered.com/app/0/x/";

  test("discounted: clean title + first-block discount_final_price", async () => {
    const p = await parseFixture(
      "steam-discounted.html",
      "https://store.steampowered.com/app/1086940/",
    );
    expect(p.title).toBe("Baldur's Gate 3");
    expect(p.priceCents).toBe(3499); // NOT 595 (the DLC block after it)
    expect(p.priceCents).not.toBe(595);
    expect(p.currency).toBe("GBP");
    expect(p.siteName).toBe("Steam");
    expect(p.image).toBe(
      "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg",
    );
  });

  test("plain price: game_purchase_price text, no discount block", async () => {
    const p = await parseFixture("steam-plain.html", "https://store.steampowered.com/app/632360/");
    expect(p.title).toBe("Risk of Rain 2");
    expect(p.priceCents).toBe(1999);
    expect(p.currency).toBe("GBP");
  });

  test("free-to-play: 'Free To Play' text → null price (NOT 0), clean title", async () => {
    const p = await parseFixture("steam-f2p.html", "https://store.steampowered.com/app/570/");
    expect(p.title).toBe("Dota 2");
    expect(p.priceCents).toBeNull();
    expect(p.currency).toBeNull();
  });

  test("agecheck shell: clean title, honest null price, image survives", async () => {
    const p = await parseFixture(
      "steam-agecheck.html",
      "https://store.steampowered.com/agecheck/app/1086940/",
    );
    expect(p.title).toBe("Baldur's Gate 3");
    expect(p.priceCents).toBeNull();
    expect(p.image).toContain("header.jpg");
  });

  test("numeric entity in the price text decodes (&#163;9.99)", async () => {
    const html = `<!DOCTYPE html><html><head>
    <meta property="og:title" content="Tiny Game on Steam">
    <meta property="og:site" content="Steam">
    <title>Tiny Game on Steam</title>
  </head><body>
    <div class="game_area_purchase_game">
      <div class="game_purchase_price price">&#163;9.99</div>
    </div>
  </body></html>`;
    const p = await extractProduct(html, STEAM);
    expect(p.priceCents).toBe(999);
    expect(p.currency).toBe("GBP");
  });

  test("tier-1 still wins: og:price beats the Steam DOM tier", async () => {
    const base = await Bun.file(join(FIXTURES, "steam-plain.html")).text();
    const html = base.replace(
      "<title>",
      `<meta property="og:price:amount" content="12.34"><meta property="og:price:currency" content="USD"><title>`,
    );
    const p = await extractProduct(html, STEAM);
    expect(p.priceCents).toBe(1234);
    expect(p.currency).toBe("USD");
  });
});

describe("extractProduct ASOS embedded payload (#171)", () => {
  const ASOS =
    "https://www.asos.com/dr-martens/dr-martens-zebzag-mule-in-black-suede/prd/206025763";
  const ASOS_NO_ID = "https://www.asos.com/x/y";

  /** A minimal ASOS-shaped page whose ONLY price source is the embedded
   *  assignment. `jsonldId` is the anchor the page declares (null = none). */
  const inline = (payload: string, jsonldId: string | null = "206025763") =>
    `<!DOCTYPE html><html><head><title>X</title>${
      jsonldId === null
        ? ""
        : `<script type="application/ld+json">{"@type":"Product","name":"X","productID":${jsonldId}}</script>`
    }</head><body><script>window.asos.pdp.config.stockPriceResponse = '${payload}';</script></body></html>`;

  const entry = (productId: number, productPrice: unknown) =>
    JSON.stringify({ productId, productPrice });

  const fixtureHtml = () => Bun.file(join(FIXTURES, "asos-pdp.html")).text();
  const stripLd = (html: string) =>
    html.replace(/<script id="[^"]*" type="application\/ld\+json">[\s\S]*?<\/script>/g, "");

  test("captured ASOS page: price from the payload, anchored to the page product", async () => {
    const p = await parseFixture("asos-pdp.html", ASOS);
    expect(p.priceCents).toBe(11000); // £110.00 — the PAGE product
    expect(p.currency).toBe("GBP");
  });

  test("the anchor is load-bearing: the first payload entry is a DIFFERENT product", async () => {
    const p = await parseFixture("asos-pdp.html", ASOS);
    // Entry [0] is productId 205104757 at £29.99 — a recommendation. A
    // first-entry-wins implementation returns 2999 here and fails this test.
    expect(p.priceCents).not.toBe(2999);
    expect(p.priceCents).toBeGreaterThan(0);
  });

  test("title/image/siteName still resolve from the metadata tiers", async () => {
    const p = await parseFixture("asos-pdp.html", ASOS);
    expect(p.title).toBe("Dr Martens ZebZag mule in black suede");
    expect(p.image).toBe(
      "https://images.asos-media.com/products/dr-martens-zebzag-mule-in-black-suede/206025763-1-black",
    );
    expect(p.siteName).toBe("ASOS");
  });

  test("tier 1 wins: og:price:amount beats the ASOS payload tier", async () => {
    const html = (await fixtureHtml()).replace(
      "<title>",
      `<meta property="og:price:amount" content="31.15"><meta property="og:price:currency" content="GBP"><title>`,
    );
    const p = await extractProduct(html, ASOS);
    expect(p.priceCents).toBe(3115);
    expect(p.currency).toBe("GBP");
  });

  test("anchor falls back to /prd/<id> in the URL when the JSON-LD id is unusable", async () => {
    const p = await extractProduct(stripLd(await fixtureHtml()), ASOS);
    expect(p.priceCents).toBe(11000);
    expect(p.currency).toBe("GBP");
  });

  test("no anchor at all → null, never the recommendation's price", async () => {
    const p = await extractProduct(stripLd(await fixtureHtml()), ASOS_NO_ID);
    expect(p.priceCents).toBeNull();
    expect(p.currency).toBeNull();
    expect(p.priceCents).not.toBe(2999);
  });

  test("a payload that lacks the page product → null, never entry[0]", async () => {
    const p = await extractProduct(
      inline(`[${entry(205104757, { current: { value: 29.99, text: "£29.99" }, currency: "GBP" })}]`),
      ASOS,
    );
    expect(p.priceCents).toBeNull();
    expect(p.currency).toBeNull();
  });

  test("empty payload array → null", async () => {
    const p = await extractProduct(inline("[]"), ASOS);
    expect(p.priceCents).toBeNull();
    expect(p.currency).toBeNull();
  });

  test("malformed payload → null, no throw", async () => {
    const html = inline(`[{"productId":`);
    const p = await extractProduct(html, ASOS);
    expect(p.priceCents).toBeNull();
  });

  test("entry without productPrice → null", async () => {
    const p = await extractProduct(inline(`[{"productId":206025763}]`), ASOS);
    expect(p.priceCents).toBeNull();
  });

  test("current.value null falls back to current.text", async () => {
    const p = await extractProduct(
      inline(`[${entry(206025763, { current: { value: null, text: "£110.00" } })}]`),
      ASOS,
    );
    expect(p.priceCents).toBe(11000);
    expect(p.currency).toBe("GBP");
  });

  test("missing productPrice.currency falls back to the symbol in current.text", async () => {
    const p = await extractProduct(
      inline(`[${entry(206025763, { current: { value: 42.5, text: "£42.50" } })}]`),
      ASOS,
    );
    expect(p.priceCents).toBe(4250);
    expect(p.currency).toBe("GBP");
  });

  test("a non-GBP payload keeps its own currency", async () => {
    const p = await extractProduct(
      inline(
        `[${entry(206025763, { current: { value: 19.99, text: "€19.99" }, currency: "EUR" })}]`,
      ),
      ASOS,
    );
    expect(p.priceCents).toBe(1999);
    expect(p.currency).toBe("EUR");
  });

  test("a value above the MAX_CENTS cap is rejected, not clamped", async () => {
    const p = await extractProduct(
      inline(`[${entry(206025763, { current: { value: 9999999 }, currency: "GBP" })}]`),
      ASOS,
    );
    expect(p.priceCents).toBeNull();
  });

  test("the sibling config assignments never match as payloads", async () => {
    const html = `<!DOCTYPE html><html><head><title>X</title>
      <script type="application/ld+json">{"@type":"Product","name":"X","productID":206025763}</script>
      </head><body><script>
      window.asos.pdp.config.stockPriceUrl = '/api/product/catalogue/v4/stockprice?productIds=';
      window.asos.pdp.config.stockPriceApiUrl = '/api/product/catalogue/v4/stockprice?productIds=206025763,205104757';
      window.asos.pdp.config.stockPriceApiTimeout = 5000;
      </script></body></html>`;
    const p = await extractProduct(html, ASOS);
    expect(p.priceCents).toBeNull();
    expect(p.currency).toBeNull();
  });

  test("no existing fixture gains a price from the ASOS tier", async () => {
    // The values each existing test already asserts — the invariant here is
    // "unchanged", not "zero". `undefined` = that test does not assert it.
    const cases: Array<[string, string, number | null, string | null | undefined]> = [
      ["shopify.html", PAGE_URL, 2500, "USD"],
      ["productgroup.html", PAGE_URL, 9999, "USD"],
      ["mixed-ld.html", PAGE_URL, 1999, undefined],
      ["nometa.html", PAGE_URL, null, undefined],
      ["badprice.html", PAGE_URL, null, undefined],
      [
        "vgp-aggregate-offer.html",
        "https://videogameperfection.com/products/ossc-pro/",
        29500,
        "EUR",
      ],
      ["amazon-dp.html", "https://www.amazon.co.uk/dp/B0DLGMVR4C", 1900, "GBP"],
      ["amazon-dp-nooffer.html", "https://www.amazon.co.uk/dp/B0BPCCKL3N", null, null],
      ["amazon-dp-mixed-accordion.html", "https://www.amazon.co.uk/dp/B0DWDDNK1Q", 3497, "GBP"],
      ["amazon-dp-mixed-noattr.html", "https://www.amazon.co.uk/dp/B0FPXD23ST", 1300, "GBP"],
      ["amazon-dp-used-only.html", "https://www.amazon.co.uk/dp/B0C1USEDON", null, null],
      ["amazon-dp-mixed-renewed.html", "https://www.amazon.co.uk/dp/B0RENEWED1", 5299, "GBP"],
      ["steam-discounted.html", "https://store.steampowered.com/app/1086940/", 3499, "GBP"],
      ["steam-plain.html", "https://store.steampowered.com/app/632360/", 1999, "GBP"],
      ["steam-f2p.html", "https://store.steampowered.com/app/570/", null, null],
      [
        "steam-agecheck.html",
        "https://store.steampowered.com/agecheck/app/1086940/",
        null,
        undefined,
      ],
    ];
    for (const [name, url, price, currency] of cases) {
      const p = await parseFixture(name, url);
      expect({ name, price: p.priceCents }).toEqual({ name, price });
      if (currency !== undefined) {
        expect({ name, currency: p.currency }).toEqual({ name, currency });
      }
    }

    // The two fixtures whose existing tests assert image/title only — the ASOS
    // tier must not touch either, so those assertions are the invariant.
    const relativeOg = await parseFixture("relative-og.html");
    expect(relativeOg.image).toBe("https://cdn.example.com/img/a.jpg");
    const twitter = await parseFixture("twitter.html");
    expect(twitter.title).toBe("Steam-ish Title");
    expect(twitter.image).toBe("https://cdn.example.com/header.jpg");
  });
});

describe("ASOS payload picker (#171)", () => {
  const RECOMMENDATION = {
    productId: 205104757,
    productPrice: { current: { value: 29.99, text: "£29.99" }, currency: "GBP" },
  };
  const PAGE_PRODUCT = {
    productId: 206025763,
    productPrice: { current: { value: 110, text: "£110.00" }, currency: "GBP" },
  };

  test("pickAsosPrice selects by anchor, not position", () => {
    expect(pickAsosPrice([RECOMMENDATION, PAGE_PRODUCT], "206025763")).toEqual({
      cents: 11000,
      currency: "GBP",
    });
  });

  test("pickAsosPrice with a null anchor returns null even when the array is non-empty", () => {
    expect(pickAsosPrice([RECOMMENDATION, PAGE_PRODUCT], null)).toBeNull();
  });

  test("pickAsosPrice with a non-matching anchor returns null", () => {
    expect(pickAsosPrice([RECOMMENDATION, PAGE_PRODUCT], "1")).toBeNull();
  });

  test("pickAsosPrice accepts a single object payload", () => {
    expect(pickAsosPrice(PAGE_PRODUCT, "206025763")).toEqual({ cents: 11000, currency: "GBP" });
  });

  test("pickAsosPrice tolerates a numeric productId against a string anchor", () => {
    // The payload keys the id as a JSON number; the JSON-LD anchor is read as
    // a string. Both sides go through String().
    expect(pickAsosPrice([PAGE_PRODUCT], String(206025763))).toEqual({
      cents: 11000,
      currency: "GBP",
    });
  });

  test("pickAsosPrice never throws on garbage", () => {
    for (const payload of [null, "x", 42, {}, [null, 3]]) {
      expect(pickAsosPrice(payload, "206025763")).toBeNull();
    }
  });

  test("pickAsosPrice with no currency anywhere → null currency, not a guess", () => {
    expect(
      pickAsosPrice([{ productId: 206025763, productPrice: { current: { value: 50, text: "" } } }], "206025763"),
    ).toEqual({ cents: 5000, currency: null });
  });

  test("findAsosProductId reads productID, then productId, then sku", () => {
    expect(findAsosProductId({ "@type": "Product", productID: 206025763 })).toBe("206025763");
    expect(findAsosProductId({ "@type": "Product", productId: "123" })).toBe("123");
    expect(findAsosProductId({ "@type": "Product", sku: "134114426" })).toBe("134114426");
  });

  test("findAsosProductId ignores a non-Product node", () => {
    expect(
      findAsosProductId({
        "@type": "BreadcrumbList",
        itemListElement: [{ "@type": "ListItem", position: 1, name: "Home" }],
      }),
    ).toBeNull();
  });
});

describe("parseSymbolPriceToCents", () => {
  test("symbol-prefixed and symbol-suffixed shapes", () => {
    expect(parseSymbolPriceToCents("£19.00")).toEqual({ cents: 1900, currency: "GBP" });
    expect(parseSymbolPriceToCents("£24.88")).toEqual({ cents: 2488, currency: "GBP" });
    expect(parseSymbolPriceToCents("$1,234.50")).toEqual({ cents: 123450, currency: "USD" });
    expect(parseSymbolPriceToCents("19,99 €")).toEqual({ cents: 1999, currency: "EUR" });
    expect(parseSymbolPriceToCents("£1,200")).toEqual({ cents: 120000, currency: "GBP" });
    expect(parseSymbolPriceToCents("  £ 19.00 ")).toEqual({ cents: 1900, currency: "GBP" });
  });

  test("garbage / symbol-less / out-of-range → null (never NaN)", () => {
    expect(parseSymbolPriceToCents("19.00")).toBeNull(); // no currency symbol
    expect(parseSymbolPriceToCents("£")).toBeNull();
    expect(parseSymbolPriceToCents("£abc")).toBeNull();
    expect(parseSymbolPriceToCents("£99,999,999")).toBeNull(); // > MAX_CENTS
    expect(parseSymbolPriceToCents(null)).toBeNull();
    expect(parseSymbolPriceToCents(1900)).toBeNull();
  });
});

describe("stripStoreTitleNoise (wave 14)", () => {
  test("steam sale shape: promo prefix + site suffix both strip", () => {
    expect(stripStoreTitleNoise("Save 30% on Baldur's Gate 3 on Steam", "Steam")).toBe(
      "Baldur's Gate 3",
    );
  });
  test("steam non-sale shape: site suffix strips", () => {
    expect(stripStoreTitleNoise("Risk of Rain 2 on Steam", "Steam")).toBe("Risk of Rain 2");
  });
  test("separator variants", () => {
    expect(stripStoreTitleNoise("Product X | ColourPop", "ColourPop")).toBe("Product X");
    expect(stripStoreTitleNoise("Product X - ColourPop", "ColourPop")).toBe("Product X");
    expect(stripStoreTitleNoise("Product X :: Steam", "Steam")).toBe("Product X");
  });
  test("clean titles are untouched (regression guard for existing fixtures)", () => {
    expect(stripStoreTitleNoise("Fresh Kiss Trio", "ColourPop")).toBe("Fresh Kiss Trio");
    expect(stripStoreTitleNoise("Just A Shop", null)).toBe("Just A Shop");
    expect(
      stripStoreTitleNoise(
        "LEGO City Explorer Diving Boat Toy with Mini-Submarine 60377",
        "amazon",
      ),
    ).toBe("LEGO City Explorer Diving Boat Toy with Mini-Submarine 60377");
  });
  test("no site token → only the promo prefix strips", () => {
    expect(stripStoreTitleNoise("Save 75% on Some Game", null)).toBe("Some Game");
  });
  test("degenerate guards: empty result falls back to input; short tokens ignored", () => {
    expect(stripStoreTitleNoise("Steam", "Steam")).toBe("Steam");
    expect(stripStoreTitleNoise("X on ab", "ab")).toBe("X on ab"); // token < 3 chars
  });
  test("regex metachars in the site token are literal", () => {
    expect(stripStoreTitleNoise("Product X - C++.Shop", "C++.Shop")).toBe("Product X");
  });
});

describe("scrapeProduct", () => {
  test("200 + meta → parsed; request carries configured UA + Accept headers", async () => {
    const seen: { ua: string; accept: string }[] = [];
    const html = await Bun.file(join(FIXTURES, "shopify.html")).text();
    const srv = serve({
      port: 0,
      fetch: (req) => {
        seen.push({
          ua: req.headers.get("user-agent") ?? "",
          accept: req.headers.get("accept") ?? "",
        });
        return new Response(html);
      },
    });
    try {
      const result = await scrapeProduct(`${srv.url}product`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.product.title).toBe("Fresh Kiss Trio");
      expect(seen[0].ua).toBe("UA/1.0");
      expect(seen[0].accept).toContain("text/html");
    } finally {
      srv.stop(true);
    }
  });

  test("bot-wall: 200 + captcha body → { ok:false, reason:'botwall', heuristic:'captcha' }", async () => {
    const html = await Bun.file(join(FIXTURES, "botwall-captcha.html")).text();
    const srv = serve({ port: 0, fetch: () => new Response(html, { status: 200 }) });
    try {
      const result = await scrapeProduct(`${srv.url}product`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("botwall");
      expect(result.heuristic).toBe("captcha");
    } finally {
      srv.stop(true);
    }
  });

  test("bot-wall: 403 + 'Access Denied' body → reason 'botwall' (status AND body consulted)", async () => {
    const html = await Bun.file(join(FIXTURES, "botwall-403.html")).text();
    const srv = serve({ port: 0, fetch: () => new Response(html, { status: 403 }) });
    try {
      const result = await scrapeProduct(`${srv.url}product`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("botwall");
      expect(result.heuristic).toBe("access denied");
    } finally {
      srv.stop(true);
    }
  });

  test("404 / 500 → reason 'http'; connection refused → 'network'", async () => {
    const srv = serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/404") return new Response("nope", { status: 404 });
        if (url.pathname === "/500") return new Response("boom", { status: 500 });
        return new Response("ok");
      },
    });
    try {
      const notFound = await scrapeProduct(`${srv.url}404`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(notFound.ok).toBe(false);
      if (!notFound.ok) expect(notFound.reason).toBe("http");

      const serverError = await scrapeProduct(`${srv.url}500`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(serverError.ok).toBe(false);
      if (!serverError.ok) expect(serverError.reason).toBe("http");
    } finally {
      srv.stop(true);
    }

    // Connection refused: fetch a just-freed port.
    const probe = serve({ port: 0, fetch: () => new Response("ok") });
    const closedUrl = probe.url.href;
    probe.stop(true);
    const refused = await scrapeProduct(closedUrl, { userAgent: "UA/1.0", timeoutMs: 1000, allowPrivate: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("network");
  });

  test("tiny body with no extractable meta → reason 'empty' (research §117)", async () => {
    const srv = serve({ port: 0, fetch: () => new Response("<html><body>hi</body></html>") });
    try {
      const result = await scrapeProduct(`${srv.url}x`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("empty");
    } finally {
      srv.stop(true);
    }
  });

  test("redirect chain: og:image resolves against FINAL url; siteName falls back to final hostname", async () => {
    const srv = serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/start") {
          return new Response(null, { status: 302, headers: { Location: "/final" } });
        }
        return new Response(
          `<!DOCTYPE html><html><head>
            <meta property="og:title" content="Redirected Product">
            <meta property="og:image" content="/img/pic.jpg">
            <title>Redirected Product</title>
          </head><body></body></html>`,
        );
      },
    });
    try {
      const result = await scrapeProduct(`${srv.url}start`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.product.image).toBe(`${srv.url}img/pic.jpg`);
      expect(result.product.siteName).toBe(new URL(srv.url).hostname);
    } finally {
      srv.stop(true);
    }
  });

  test("timeout via AbortSignal.timeout: never-responding server → 'network'", async () => {
    const srv = serve({
      port: 0,
      fetch: async () => {
        await new Promise(() => {});
        return new Response("never");
      },
    });
    try {
      const result = await scrapeProduct(`${srv.url}hang`, { userAgent: "UA/1.0", timeoutMs: 300, allowPrivate: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("network");
    } finally {
      srv.stop(true);
    }
  });

  test("mid-body stall: headers sent, stream enqueues partial HTML then never closes → 'network', NOT a throw (regression: res.text() was outside the try/catch)", async () => {
    const srv = serve({
      port: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<html><head><title>partial"));
            // never close() — the body stalls after the headers
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    try {
      const result = await scrapeProduct(`${srv.url}stall`, { userAgent: "UA/1.0", timeoutMs: 300, allowPrivate: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("network");
    } finally {
      srv.stop(true);
    }
  });
});

describe("scrapeProduct SSRF guard (private ranges)", () => {
  const PRIVATE_LITERALS = [
    "http://127.0.0.1:9/product", // loopback
    "http://10.0.0.5:80/x", // 10.0.0.0/8
    "http://172.16.0.1:80/x", // 172.16.0.0/12 lower edge
    "http://172.31.255.254:80/x", // 172.16.0.0/12 upper edge
    "http://192.168.1.1:80/x", // 192.168.0.0/16
    "http://169.254.0.1:80/x", // 169.254.0.0/16 link-local
    "http://[::1]:8080/x", // IPv6 loopback
    "http://[fc00::1]:8080/x", // fc00::/7 lower edge
    "http://[fd12:3456:789a::1]:8080/x", // fc00::/7 (fdxx)
    "http://[::ffff:127.0.0.1]:8080/x", // IPv4-mapped loopback must not bypass
  ];

  test.each(PRIVATE_LITERALS)("literal private URL %s → { ok:false, reason:'private-ip' } before any fetch", async (url) => {
    const result = await scrapeProduct(url, { userAgent: "UA/1.0" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("private-ip");
  });

  test("public literal IP host still fetches (fetchImpl stub — no real network)", async () => {
    const html = await Bun.file(join(FIXTURES, "shopify.html")).text();
    const seen: string[] = [];
    const fetchImpl: SearxngFetch = async (input) => {
      seen.push(String(input));
      return new Response(html);
    };
    const result = await scrapeProduct("http://93.184.216.34:80/product", { userAgent: "UA/1.0", fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.product.title).toBe("Fresh Kiss Trio");
    expect(seen).toEqual(["http://93.184.216.34:80/product"]);
  });

  test("redirect target on a literal private IP → 'private-ip' (post-fetch final-URL check)", async () => {
    const fetchImpl: SearxngFetch = async () => {
      const res = new Response("<html></html>", { status: 200 });
      Object.defineProperty(res, "url", { value: "http://127.0.0.1:8080/admin" });
      return res;
    };
    const result = await scrapeProduct("https://public.example.com/p", { userAgent: "UA/1.0", fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("private-ip");
  });

  test("hostname that resolves to a private address → 'private-ip' (one DNS lookup on the final URL)", async () => {
    const fetchImpl: SearxngFetch = async () => {
      const res = new Response("<html></html>", { status: 200 });
      Object.defineProperty(res, "url", { value: "http://localhost:9/product" });
      return res;
    };
    const result = await scrapeProduct("http://localhost:9/product", { userAgent: "UA/1.0", fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("private-ip");
  });

  test("allowPrivate: true → the local-server scrape path is untouched", async () => {
    const html = await Bun.file(join(FIXTURES, "shopify.html")).text();
    const srv = serve({ port: 0, fetch: () => new Response(html) });
    try {
      const result = await scrapeProduct(`${srv.url}product`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.product.title).toBe("Fresh Kiss Trio");
    } finally {
      srv.stop(true);
    }
  });
});

describe("detectBotWall (wave 14)", () => {
  test("akamai CDN references in a legit page are NOT a bot wall", async () => {
    const html = `<!DOCTYPE html><html><head>
    <link href="https://store.akamai.steamstatic.com/public/css/v6/store.css" rel="stylesheet">
    <title>Some Product</title>
  </head><body></body></html>`;
    expect(detectBotWall(html)).toBeNull();
    // The same negative for a fully-extracting page: none of the four Akamai
    // Bot Manager markers is a substring of an *.akamai.steamstatic.com asset
    // URL, and an Akamai-fronted shop is not a challenge page.
    expect(detectBotWall(await readFixture("amazon-dp.html"))).toBeNull();
  });
});

describe("Akamai bm-verify interstitial (#172)", () => {
  test("detectBotWall: Akamai bm-verify interstitial → 'akamai-bm'", async () => {
    // The measured failure: a plain fetch of the product URL returns HTTP 200
    // with this 2KB challenge body, and detection used to say `null`, so the
    // pipeline stored it as a successful scrape with no price.
    expect(detectBotWall(await readFixture(BM_INTERSTITIAL))).toBe("akamai-bm");
  });

  test("each Akamai marker independently matches 'akamai-bm'", () => {
    // All four markers are present in the capture and each one alone is
    // enough, so deleting one from the table cannot silently keep the suite
    // green through the others.
    const docs = [
      `<meta http-equiv="refresh" content="5; URL='/p?bm-verify=AAQAAAAO1'">`,
      `<script>xhr.open("POST", "/_sec/verify?provider=interstitial", true);</script>`,
      `<script>function triggerInterstitialChallenge() {}</script>`,
      `<noscript><iframe src="/interstitial/ic.html?provider=interstitial"></iframe></noscript>`,
    ];
    for (const doc of docs) expect(detectBotWall(doc)).toBe("akamai-bm");
  });

  test("the interstitial fixture carries every marker inside the 4KB window", async () => {
    // `detectBotWall` samples the first 4,096 bytes (fetch.ts); the live
    // capture has all four markers inside it and the fixture must too, or the
    // pattern would only work against the live byte order.
    const html = await readFixture(BM_INTERSTITIAL);
    const sample = html.slice(0, 4096).toLowerCase();
    for (const marker of BM_MARKERS) expect(sample).toContain(marker);
    // And it must stay a small challenge body, not a page-sized document.
    expect(html.length).toBeLessThan(3072);
  });

  test("the real PDP carries NO Akamai marker and is not a wall", async () => {
    // Measured: the token-fetched product page contains none of the four
    // markers anywhere, and the pre-existing `captcha` pattern does not fire
    // on it either (the word appears beyond the 4KB sample window, if at all).
    const html = await readFixture(BM_PDP);
    const lower = html.toLowerCase();
    for (const marker of BM_MARKERS) expect(lower).not.toContain(marker);
    expect(detectBotWall(html)).toBeNull();
  });

  test("accepted trade-off: the challenge function name in page text IS a wall", () => {
    // The marker is the identifier itself, so a page that merely SPELLS it
    // (here inside JSON-LD) classifies as a wall. Deliberate: the measured
    // interstitial needs the marker, and requiring `function
    // triggerInterstitialChallenge` would be a longer regex with no measured
    // benefit. Pinned so tightening it later is a visible, tested change.
    const html = `<!DOCTYPE html><html><head>
      <script type="application/ld+json">{"@type":"Product","name":"triggerInterstitialChallenge widget"}</script>
    </head><body></body></html>`;
    expect(detectBotWall(html)).toBe("akamai-bm");
  });

  test("the PDP fixture extracts through the existing tiers (no parse.ts change)", async () => {
    // The measured baseline: the challenge body yields a whitespace title and
    // nothing else; the token-fetched page yields the product. Both come out of
    // the tiers that already existed — the bug is transport-only.
    const p = await parseFixture(
      BM_PDP,
      "https://www.bershka.com/gb/example-product-c0p000000000.html",
    );
    expect(p.title).toBe("Fitted short sleeve print T-shirt - Women");
    expect(p.priceCents).toBe(1299);
    expect(p.currency).toBe("GBP");
    // Entity-encoded in the source and handed back verbatim — the known
    // wrong-image-size defect (out of scope for #172, do not tidy the fixture).
    expect(p.image).toBe(
      "https://static.bershka.net/assets/public/abc1/example-product-p.jpg?ts=1789720111100&amp;w=850",
    );
    expect(p.siteName).toBe("bershka.com");

    const wall = await parseFixture(
      BM_INTERSTITIAL,
      "https://www.bershka.com/gb/example-product-c0p000000000.html",
    );
    expect(wall.title).toBe(" ");
    expect(wall.priceCents).toBeNull();
    expect(wall.image).toBeNull();
  });

  test("extractMetaRefreshTarget: relative target returned as written", async () => {
    // RELATIVE, not resolved: the live body ships the target relative to the
    // product page, and `fetch("'/gb/…'")` throws ERR_INVALID_URL without
    // resolution against the page URL the caller holds.
    expect(extractMetaRefreshTarget(await readFixture(BM_INTERSTITIAL))).toBe(BM_TARGET_PATH);
  });

  test("extractMetaRefreshTarget: double-quoted and mixed-case variants", () => {
    const doubleQuoted = `<meta http-equiv="refresh" content='5; URL="https://shop.example.com/p?bm-verify=AAQ1"'>`;
    expect(extractMetaRefreshTarget(doubleQuoted)).toBe(
      "https://shop.example.com/p?bm-verify=AAQ1",
    );
    const mixedCase = `<META HTTP-EQUIV="REFRESH" CONTENT="0; URL='/cart?bm-verify=AAQ1'">`;
    expect(extractMetaRefreshTarget(mixedCase)).toBe("/cart?bm-verify=AAQ1");
  });

  test("extractMetaRefreshTarget: no refresh / no URL → null", () => {
    expect(extractMetaRefreshTarget(`<meta http-equiv="refresh" content="5">`)).toBeNull();
    expect(extractMetaRefreshTarget(`<html><head><title>x</title></head></html>`)).toBeNull();
    // A pure extractor: an ordinary countdown refresh on a shopping page is
    // returned as any other target. Gating on the interstitial is the caller's.
    expect(extractMetaRefreshTarget(`<meta http-equiv="refresh" content="0; url=/cart">`)).toBe(
      "/cart",
    );
  });

  test("extractMetaRefreshTarget: never throws on garbage", () => {
    for (const html of ["", "<meta", `<meta http-equiv=refresh content=`]) {
      expect(extractMetaRefreshTarget(html)).toBeNull();
    }
  });

  test("extractMetaRefreshTarget does not scan a page-sized document", async () => {
    // The window is the first 4KB, like `detectBotWall`: a meta refresh far
    // below the fold of a real page is not a challenge hand-off.
    const buried = `${"<!-- pad -->".repeat(400)}\n<meta http-equiv="refresh" content="5; URL='/x'">`;
    expect(buried.length).toBeGreaterThan(4096);
    expect(extractMetaRefreshTarget(buried)).toBeNull();
  });

  // ---- Group C: the pass-through, over the real fetchPage ----

  /** Both captures. */
  async function captures() {
    return {
      interstitial: await readFixture(BM_INTERSTITIAL),
      pdp: await readFixture(BM_PDP),
    };
  }

  /** A local server that counts every request it sees — the counter is the
   *  no-loop assertion's mechanism, so it must see requests whose response
   *  never arrives too. */
  function akamaiServer(handler: (url: URL) => Response | Promise<Response>) {
    const seen: string[] = [];
    const srv = serve({
      port: 0,
      fetch: (req) => {
        seen.push(req.url);
        return handler(new URL(req.url));
      },
    });
    return { srv, seen };
  }

  const isTokenRequest = (url: URL) => url.searchParams.has("bm-verify");

  test("interstitial → exactly one token refetch returns the PDP", async () => {
    const { interstitial, pdp } = await captures();
    const { srv, seen } = akamaiServer((url) =>
      isTokenRequest(url) ? new Response(pdp) : new Response(interstitial),
    );
    try {
      const page = await fetchPage(`${srv.url}product`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.html).toContain("Fitted short sleeve print T-shirt - Women");
      expect(page.html).not.toContain("interstitial/ic.html");
      // The token request's own final URL, never the URL we started on.
      expect(page.finalUrl).toBe(new URL(BM_TARGET_PATH, srv.url).href);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(`${srv.url}product`);
    } finally {
      srv.stop(true);
    }
  });

  test("absolute meta-refresh target is honoured unchanged", async () => {
    const { interstitial, pdp } = await captures();
    let body = interstitial;
    const { srv, seen } = akamaiServer((url) =>
      isTokenRequest(url) ? new Response(pdp) : new Response(body),
    );
    try {
      const absolute = new URL(BM_TARGET_PATH, srv.url).href;
      body = interstitial.replace(/URL='[^']*'/, `URL='${absolute}'`);
      expect(body).toContain(`URL='${absolute}'`);
      const page = await fetchPage(`${srv.url}product`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.finalUrl).toBe(absolute);
      expect(seen).toHaveLength(2);
    } finally {
      srv.stop(true);
    }
  });

  test("a second interstitial on the token refetch → botwall, NOT a third request", async () => {
    const { interstitial } = await captures();
    const { srv, seen } = akamaiServer(() => new Response(interstitial));
    try {
      const page = await fetchPage(`${srv.url}product`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(page.ok).toBe(false);
      if (page.ok) return;
      expect(page.reason).toBe("botwall");
      expect(page.heuristic).toBe("akamai-bm");
      // THE no-loop assertion: the token is single-use, so the second
      // interstitial is the verdict and there is never a third request.
      expect(seen).toHaveLength(2);
    } finally {
      srv.stop(true);
    }
  });

  test("interstitial with no meta refresh → botwall, no second request", async () => {
    const { interstitial } = await captures();
    const stripped = interstitial.replace(/<meta http-equiv="refresh"[^\n]*\n/, "");
    expect(stripped).not.toContain("http-equiv");
    const { srv, seen } = akamaiServer(() => new Response(stripped));
    try {
      const page = await fetchPage(`${srv.url}product`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(page.ok).toBe(false);
      if (page.ok) return;
      expect(page.reason).toBe("botwall");
      expect(page.heuristic).toBe("akamai-bm");
      expect(seen).toHaveLength(1);
    } finally {
      srv.stop(true);
    }
  });

  test("a meta-refresh target that is not a URL → botwall, no second request", async () => {
    const { interstitial } = await captures();
    const broken = interstitial.replace(/URL='[^']*'/, "URL='not a url'");
    const { srv, seen } = akamaiServer(() => new Response(broken));
    try {
      const page = await fetchPage(`${srv.url}product`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(page.ok).toBe(false);
      if (page.ok) return;
      expect(page.reason).toBe("botwall");
      expect(page.heuristic).toBe("akamai-bm");
      expect(seen).toHaveLength(1);
    } finally {
      srv.stop(true);
    }
  });

  test("marker false positive with an ORDINARY meta refresh → botwall, target NOT followed", async () => {
    // The composed defect (#172 review): `detectBotWall` has a pinned false
    // positive (the marker as plain page text — see the JSON-LD test above) and
    // locale/consent/redirect pages ship an ordinary meta refresh. A
    // pass-through that follows ANY resolvable refresh fetches that page and
    // returns IT as the product — `ok: true`, silently wrong title/price/image.
    // The hand-off is only ever the token-shaped target, so a refresh without
    // `bm-verify` must fall back to the visible verdict with no second request.
    const cartMarker = "CART-PAGE-BODY-MUST-NEVER-BE-RETURNED";
    const markerPage = `<!DOCTYPE html><html><head>
      <script type="application/ld+json">{"@type":"Product","name":"triggerInterstitialChallenge widget"}</script>
      <meta http-equiv="refresh" content="0; url=/cart">
    </head><body>a legit page that merely spells a marker</body></html>`;
    expect(detectBotWall(markerPage)).toBe("akamai-bm");
    expect(extractMetaRefreshTarget(markerPage)).toBe("/cart");
    const { srv, seen } = akamaiServer((url) =>
      url.pathname === "/cart"
        ? new Response(`<html><body>${cartMarker}</body></html>`)
        : new Response(markerPage),
    );
    try {
      const page = await fetchPage(`${srv.url}product`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(page.ok).toBe(false);
      if (page.ok) return;
      expect(page.reason).toBe("botwall");
      expect(page.heuristic).toBe("akamai-bm");
      // EXACTLY ONE request: the refresh target was never followed.
      expect(seen).toHaveLength(1);
      // …and nothing from the /cart body leaked into the result.
      expect(JSON.stringify(page)).not.toContain(cartMarker);
    } finally {
      srv.stop(true);
    }
  });

  test("an interstitial whose refresh target has no bm-verify token → botwall, no second request", async () => {
    // The only measured hand-off shape is the product URL plus the one-shot
    // `bm-verify` token (plan B4/B14). A tokenless target — a plain relative
    // path here — is not this challenge's hand-off and is never followed.
    const { interstitial } = await captures();
    const tokenless = interstitial.replace(/URL='[^']*'/, "URL='/gb/example-product.html'");
    expect(tokenless).toContain("URL='/gb/example-product.html'");
    expect(detectBotWall(tokenless)).toBe("akamai-bm");
    const { srv, seen } = akamaiServer(() => new Response(tokenless));
    try {
      const page = await fetchPage(`${srv.url}product`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(page.ok).toBe(false);
      if (page.ok) return;
      expect(page.reason).toBe("botwall");
      expect(page.heuristic).toBe("akamai-bm");
      expect(seen).toHaveLength(1);
    } finally {
      srv.stop(true);
    }
  });

  test("token refetch 404 → the refetch's own http verdict, not botwall", async () => {
    const { interstitial } = await captures();
    const { srv, seen } = akamaiServer((url) =>
      isTokenRequest(url) ? new Response("gone", { status: 404 }) : new Response(interstitial),
    );
    try {
      const page = await fetchPage(`${srv.url}product`, { userAgent: "UA/1.0", allowPrivate: true });
      expect(page.ok).toBe(false);
      if (page.ok) return;
      expect(page.reason).toBe("http");
      expect(page.status).toBe(404);
      expect(seen).toHaveLength(2);
    } finally {
      srv.stop(true);
    }
  });

  test("token refetch that never responds → network with a named heuristic", async () => {
    const { interstitial } = await captures();
    const { srv, seen } = akamaiServer((url) =>
      isTokenRequest(url) ? new Promise<Response>(() => {}) : new Response(interstitial),
    );
    try {
      const page = await fetchPage(`${srv.url}product`, {
        userAgent: "UA/1.0",
        timeoutMs: 300,
        allowPrivate: true,
      });
      expect(page.ok).toBe(false);
      if (page.ok) return;
      expect(page.reason).toBe("network");
      expect(page.heuristic).toBe("timeout");
      // The counter sees the request whose response never arrived.
      expect(seen).toHaveLength(2);
    } finally {
      srv.stop(true);
    }
  });

  test("SSRF: a meta-refresh target on a literal private host is refused before any I/O", async () => {
    const { interstitial } = await captures();
    // The hostile target must be TOKEN-shaped to be followed at all — the
    // pass-through only follows a `&bm-verify=…` hand-off — so it carries a
    // (bogus) token; that is what makes the second request reach the guard
    // under test rather than being skipped as an ordinary refresh.
    const hostile = interstitial.replace(
      /URL='[^']*'/,
      `URL='http://127.0.0.1:9/steal?bm-verify=${BM_TOKEN}'`,
    );
    const seen: string[] = [];
    const fetchImpl: SearxngFetch = async (input) => {
      seen.push(String(input));
      return new Response(hostile, { status: 200 });
    };
    // The primary URL is a public literal host, so the DEFAULT guard is the one
    // under test: the token URL must be held to the same check, rejected before
    // any request reaches it. (`allowPrivate` opts both requests out — that is
    // how the local-server tests above work.)
    const page = await fetchPage("http://93.184.216.34:80/product", {
      userAgent: "UA/1.0",
      fetchImpl,
    });
    expect(page.ok).toBe(false);
    if (page.ok) return;
    expect(page.reason).toBe("private-ip");
    expect(seen).toEqual(["http://93.184.216.34:80/product"]);
  });

  test("SSRF: the primary private-IP rejection still precedes any interstitial work", async () => {
    const page = await fetchPage("http://127.0.0.1:9/x", { userAgent: "UA/1.0" });
    expect(page.ok).toBe(false);
    if (page.ok) return;
    expect(page.reason).toBe("private-ip");
  });

  // ---- Group D: end to end through scrapeProduct ----

  test("default chain: the interstitial-then-PDP fetch is ONE plain step", async () => {
    const { interstitial, pdp } = await captures();
    const { srv, seen } = akamaiServer((url) =>
      isTokenRequest(url) ? new Response(pdp) : new Response(interstitial),
    );
    try {
      const result = await scrapeProduct(`${srv.url}product`, {
        userAgent: "UA/1.0",
        allowPrivate: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.strategy).toBe("plain");
      // The token refetch is invisible to the chain: one strategy, one step.
      expect(result.steps).toEqual([{ strategy: "plain", ok: true }]);
      expect(result.product.title).toBe("Fitted short sleeve print T-shirt - Women");
      expect(result.product.priceCents).toBe(1299);
      expect(result.product.currency).toBe("GBP");
      expect(seen).toHaveLength(2);
    } finally {
      srv.stop(true);
    }
  });

  test("a persistent Akamai wall is still a botwall verdict end to end", async () => {
    const { interstitial } = await captures();
    const { srv, seen } = akamaiServer(() => new Response(interstitial));
    try {
      const result = await scrapeProduct(`${srv.url}product`, {
        userAgent: "UA/1.0",
        allowPrivate: true,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("botwall");
      expect(result.heuristic).toBe("akamai-bm");
      // No stealth capability → the chain is plain-only: one step, two requests
      // (the interstitial and its single refetch).
      expect(result.steps).toHaveLength(1);
      expect(seen).toHaveLength(2);
    } finally {
      srv.stop(true);
    }
  });

  test("a persistent Akamai wall escalates to stealth when the capability is wired", async () => {
    const { interstitial, pdp } = await captures();
    const { srv } = akamaiServer(() => new Response(interstitial));
    const runner: StealthRunner = async () => ({
      stdout: JSON.stringify({ ok: true, html: pdp, finalUrl: `${srv.url}product`, status: 200 }),
      exitCode: 0,
      signal: undefined,
    });
    try {
      const result = await scrapeProduct(`${srv.url}product`, {
        userAgent: "UA/1.0",
        allowPrivate: true,
        stealth: {
          pythonBin: "/bin/true",
          scriptPath: "/s",
          profilesDir: "/tmp/p",
          timeoutMs: 1000,
          runner,
          allowPrivate: true,
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // `botwall` is already escalatable, so no learned.ts change is needed.
      expect(result.steps).toEqual([
        { strategy: "plain", ok: false, reason: "botwall", heuristic: "akamai-bm" },
        { strategy: "stealth-browser", ok: true },
      ]);
      expect(result.product.priceCents).toBe(1299);
      expect(result.product.currency).toBe("GBP");
    } finally {
      srv.stop(true);
    }
  });
});

describe("scrapeProduct strategy pipeline (wave 13)", () => {
  test("registered host: stealth stub returns html → extract + strategy recorded", async () => {
    const html = await Bun.file(join(FIXTURES, "shopify.html")).text();
    const runner: StealthRunner = async () => ({
      stdout: JSON.stringify({
        ok: true,
        html,
        finalUrl: "https://www.smythstoys.com/p/x",
        status: 200,
      }),
      exitCode: 0,
      signal: undefined,
    });
    const result = await scrapeProduct("https://www.smythstoys.com/en-gb/p/248662", {
      userAgent: "UA/1.0",
      allowPrivate: true,
      stealth: {
        pythonBin: "/bin/true",
        scriptPath: "/s",
        profilesDir: "/tmp/p",
        timeoutMs: 1000,
        runner,
        allowPrivate: true,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.product.title).toBe("Fresh Kiss Trio");
      expect(result.strategy).toBe("stealth-browser");
    }
  });

  test("stealth failure falls through to plain; final failure carries last strategy", async () => {
    const runner: StealthRunner = async () => ({
      stdout: JSON.stringify({ ok: false, reason: "timeout" }),
      exitCode: 0,
      signal: undefined,
    });
    const fetchImpl: SearxngFetch = async () => {
      const res = new Response("<html>hi</html>", { status: 403 });
      Object.defineProperty(res, "url", { value: "https://www.smythstoys.com/p/1" });
      return res;
    };
    const result = await scrapeProduct("https://www.smythstoys.com/p/1", {
      userAgent: "UA/1.0",
      fetchImpl,
      allowPrivate: true,
      stealth: {
        pythonBin: "/bin/true",
        scriptPath: "/s",
        profilesDir: "/tmp/p",
        timeoutMs: 1000,
        runner,
        allowPrivate: true,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.strategy).toBe("plain");
      expect(result.reason).toBe("http");
    }
  });

  test("unregistered host never invokes the stealth runner", async () => {
    let called = 0;
    const runner: StealthRunner = async () => {
      called++;
      return { stdout: "{}", exitCode: 0, signal: undefined };
    };
    const html = await Bun.file(join(FIXTURES, "shopify.html")).text();
    const fetchImpl: SearxngFetch = async () => {
      const res = new Response(html);
      Object.defineProperty(res, "url", { value: "https://colourpop.com/products/x" });
      return res;
    };
    const result = await scrapeProduct("https://colourpop.com/products/x", {
      userAgent: "UA/1.0",
      fetchImpl,
      allowPrivate: true,
      stealth: {
        pythonBin: "/bin/true",
        scriptPath: "/s",
        profilesDir: "/tmp/p",
        timeoutMs: 1000,
        runner,
        allowPrivate: true,
      },
    });
    expect(result.ok).toBe(true);
    expect(called).toBe(0);
  });

  test("no stealth deps → chain filters stealth-browser (plain-only)", async () => {
    const html = await Bun.file(join(FIXTURES, "shopify.html")).text();
    const fetchImpl: SearxngFetch = async () => {
      const res = new Response(html);
      Object.defineProperty(res, "url", { value: "https://www.smythstoys.com/p/1" });
      return res;
    };
    const result = await scrapeProduct("https://www.smythstoys.com/p/1", {
      userAgent: "UA/1.0",
      fetchImpl,
      allowPrivate: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.strategy).toBe("plain");
  });

  test("incapsula interstitial → reason 'botwall', heuristic 'incapsula'", async () => {
    const fetchImpl: SearxngFetch = async () =>
      new Response(await Bun.file(join(FIXTURES, "incapsula.html")).text(), { status: 403 });
    const result = await scrapeProduct("https://www.smythstoys.com/p/1", {
      userAgent: "UA/1.0",
      fetchImpl,
      allowPrivate: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("botwall");
      expect(result.heuristic).toBe("incapsula");
    }
  });

  test("custom-headers: extraHeaders merge + override semantics through fetchPage", async () => {
    const seen: string[] = [];
    const srv = serve({
      port: 0,
      fetch: (req) => {
        seen.push(req.headers.get("user-agent") ?? "");
        return new Response(
          "<html><head><title>t</title></head></html>",
        );
      },
    });
    try {
      const page = await fetchPage(`${srv.url}x`, {
        userAgent: "default-ua",
        extraHeaders: {
          "User-Agent": "override-ua",
          "Accept-Language": "de-DE,de;q=0.9",
        },
        allowPrivate: true,
      });
      expect(page.ok).toBe(true);
      expect(seen[0]).toBe("override-ua");
    } finally {
      srv.stop(true);
    }
  });

  test("never-responding server: plain step carries heuristic 'timeout' and escalates (#173)", async () => {
    const html = await Bun.file(join(FIXTURES, "shopify.html")).text();
    // No fetchImpl injection — this is the REAL fetchPage path, so the
    // classification is exercised end-to-end.
    const srv = serve({
      port: 0,
      fetch: async () => {
        await new Promise(() => {});
        return new Response("never");
      },
    });
    let calls = 0;
    const runner: StealthRunner = async () => {
      calls++;
      return {
        stdout: JSON.stringify({ ok: true, html, finalUrl: `${srv.url}product`, status: 200 }),
        exitCode: 0,
        signal: undefined,
      };
    };
    try {
      const result = await scrapeProduct(`${srv.url}hang`, {
        userAgent: "UA/1.0",
        timeoutMs: 300,
        allowPrivate: true,
        stealth: {
          pythonBin: "/bin/true",
          scriptPath: "/s",
          profilesDir: "/tmp/p",
          timeoutMs: 1000,
          runner,
          allowPrivate: true,
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.strategy).toBe("stealth-browser");
      expect(result.steps[0]).toEqual({
        strategy: "plain",
        ok: false,
        reason: "network",
        heuristic: "timeout",
      });
      expect(calls).toBe(1);
    } finally {
      srv.stop(true);
    }
  });
});

describe("scrapeProduct Steam pipeline (wave 14)", () => {
  test("custom-headers sends the age cookie; clean title + price extracted", async () => {
    const html = await Bun.file(join(FIXTURES, "steam-discounted.html")).text();
    const seenCookies: string[] = [];
    const fetchImpl: SearxngFetch = async (_input, init) => {
      seenCookies.push(new Headers(init?.headers).get("cookie") ?? "");
      const res = new Response(html);
      Object.defineProperty(res, "url", {
        value: "https://store.steampowered.com/app/1086940/",
      });
      return res;
    };
    const result = await scrapeProduct("https://store.steampowered.com/app/1086940/", {
      userAgent: "UA/1.0",
      fetchImpl,
      allowPrivate: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strategy).toBe("custom-headers");
      expect(result.product.title).toBe("Baldur's Gate 3");
      expect(result.product.priceCents).toBe(3499);
      expect(result.product.currency).toBe("GBP");
    }
    expect(seenCookies[0]).toContain("birthtime=");
  });
});
