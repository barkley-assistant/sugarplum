import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { serve } from "bun";
import { extractProduct } from "../src/server/scraper/parse";
import { scrapeProduct } from "../src/server/scraper";
import { fetchPage } from "../src/server/scraper/fetch";
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
