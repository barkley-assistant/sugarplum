import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { serve } from "bun";
import {
  extractProduct,
  parseSymbolPriceToCents,
  stripStoreTitleNoise,
} from "../src/server/scraper/parse";
import { scrapeProduct } from "../src/server/scraper";
import { fetchPage, detectBotWall } from "../src/server/scraper/fetch";
import type { StealthRunner } from "../src/server/scraper/stealth";
import type { SearxngFetch } from "../src/server/searxng";

const FIXTURES = join(import.meta.dir, "fixtures");
const PAGE_URL = "https://colourpop.example.com/products/fresh-kiss-trio";

async function parseFixture(name: string, pageUrl = PAGE_URL) {
  const html = await Bun.file(join(FIXTURES, name)).text();
  return extractProduct(html, pageUrl);
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
});
