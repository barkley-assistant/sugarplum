import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { serve } from "bun";
import { extractProduct } from "../src/server/scraper/parse";
import { scrapeProduct } from "../src/server/scraper";

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
      const result = await scrapeProduct(`${srv.url}product`, { userAgent: "UA/1.0" });
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
      const result = await scrapeProduct(`${srv.url}product`, { userAgent: "UA/1.0" });
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
      const result = await scrapeProduct(`${srv.url}product`, { userAgent: "UA/1.0" });
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
      const notFound = await scrapeProduct(`${srv.url}404`, { userAgent: "UA/1.0" });
      expect(notFound.ok).toBe(false);
      if (!notFound.ok) expect(notFound.reason).toBe("http");

      const serverError = await scrapeProduct(`${srv.url}500`, { userAgent: "UA/1.0" });
      expect(serverError.ok).toBe(false);
      if (!serverError.ok) expect(serverError.reason).toBe("http");
    } finally {
      srv.stop(true);
    }

    // Connection refused: fetch a just-freed port.
    const probe = serve({ port: 0, fetch: () => new Response("ok") });
    const closedUrl = probe.url.href;
    probe.stop(true);
    const refused = await scrapeProduct(closedUrl, { userAgent: "UA/1.0", timeoutMs: 1000 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("network");
  });

  test("tiny body with no extractable meta → reason 'empty' (research §117)", async () => {
    const srv = serve({ port: 0, fetch: () => new Response("<html><body>hi</body></html>") });
    try {
      const result = await scrapeProduct(`${srv.url}x`, { userAgent: "UA/1.0" });
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
      const result = await scrapeProduct(`${srv.url}start`, { userAgent: "UA/1.0" });
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
      const result = await scrapeProduct(`${srv.url}hang`, { userAgent: "UA/1.0", timeoutMs: 300 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("network");
    } finally {
      srv.stop(true);
    }
  });
});