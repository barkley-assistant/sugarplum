// tests/searxng.test.ts — fetcher ALWAYS injected; zero network
import { describe, expect, test } from "bun:test";
import {
  buildSearchQuery,
  buildTitleQuery,
  isLandingShapedUrl,
  queryTerms,
  searchImageHint,
  searchPriceCandidates,
  searchPriceHint,
  titleOverlapsQuery,
  type SearxngFetch,
} from "../src/server/searxng";

describe("searchPriceHint", () => {
  test("happy path: first result with a parseable price wins", async () => {
    const fake: SearxngFetch = async (input) => {
      expect(String(input)).toContain("format=json"); // lock the wire format
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Teapot 123 — Cool Shop",
              url: "https://cool.example.com/p/1",
              content: "Buy the Teapot 123 for £25.00 delivered",
            },
            { title: "irrelevant", url: "https://noise.example.com/x", content: "no price here" },
          ],
        }),
      );
    };
    const hint = await searchPriceHint("teapot 123", {
      baseUrl: "http://searx.example",
      fetchImpl: fake,
    });
    expect(hint?.priceCents).toBe(2500);
    expect(hint?.currency).toBe("GBP");
    expect(hint?.sourceUrl).toBe("https://cool.example.com/p/1");
  });

  test("self-host result skipped: candidate on the item's own domain is not a 'hint'", async () => {
    const fake: SearxngFetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: "Teapot 123 — Cool Shop", url: "https://coolshop.co.uk/p/1", content: "£25.00" },
            { title: "Teapot elsewhere", url: "https://elsewhere.example.com/p/1", content: "£30.00" },
          ],
        }),
      );
    const hint = await searchPriceHint("coolshop.co.uk teapot 123 buy", {
      baseUrl: "http://searx.example",
      fetchImpl: fake,
    });
    expect(hint?.sourceUrl).toBe("https://elsewhere.example.com/p/1");
    expect(hint?.priceCents).toBe(3000);
  });

  test("#174: lyst designer landing page with stray £8 is NOT returned as a hint", async () => {
    const fake: SearxngFetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              // Measured offender: a brand LANDING page whose snippet carries a
              // stray "from £8" — not a price for the hoodie we searched for.
              title: "Next Designer — Lyst",
              url: "https://www.lyst.co.uk/designer/next/",
              content: "Prices from £8 and up",
            },
            {
              title: "Next Hoodie — Shop Example",
              url: "https://shop.example.com/products/next-hoodie",
              content: "£18.00",
            },
          ],
        }),
      );
    const hint = await searchPriceHint("next.co.uk hoodie buy", {
      baseUrl: "http://searx.example",
      fetchImpl: fake,
    });
    expect(hint?.sourceUrl).toBe("https://shop.example.com/products/next-hoodie");
    expect(hint?.priceCents).toBe(1800);
    expect(hint?.currency).toBe("GBP");
  });

  test("#174: a result whose title shares no query term is skipped", async () => {
    const fake: SearxngFetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            // Both URLs are product-shaped, so only the title-overlap gate
            // separates them.
            { title: "Unrelated Gadget Sale", url: "https://a.example.com/p/x", content: "£5.00" },
            { title: "Teapot 123 — B Shop", url: "https://b.example.com/p/y", content: "£27.00" },
          ],
        }),
      );
    const hint = await searchPriceHint("teapot 123 buy", {
      baseUrl: "http://searx.example",
      fetchImpl: fake,
    });
    expect(hint?.sourceUrl).toBe("https://b.example.com/p/y");
    expect(hint?.priceCents).toBe(2700);
  });

  test("no results / bad JSON / fetch throw → null (never throws)", async () => {
    const empty = await searchPriceHint("x", {
      baseUrl: "http://searx.example",
      fetchImpl: async () => new Response(JSON.stringify({ results: [] })),
    });
    expect(empty).toBeNull();

    const badJson = await searchPriceHint("x", {
      baseUrl: "http://searx.example",
      fetchImpl: async () => new Response("not json"),
    });
    expect(badJson).toBeNull();

    const throws = await searchPriceHint("x", {
      baseUrl: "http://searx.example",
      fetchImpl: async () => {
        throw new Error("boom");
      },
    });
    expect(throws).toBeNull();
  });

  test("comma-thousands guard: £1,200 parses as 120000 cents, not 1200", async () => {
    const fake: SearxngFetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: "Big ticket", url: "https://big.example.com/p/1", content: "£1,200 today" },
          ],
        }),
      );
    const hint = await searchPriceHint("big ticket buy", {
      baseUrl: "http://searx.example",
      fetchImpl: fake,
    });
    expect(hint?.priceCents).toBe(120000);
  });

  test("comma-decimal tolerated: €3,25 → 325 cents", async () => {
    const fake: SearxngFetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: "Euro shop", url: "https://euro.example.com/p/1", content: "Nur €3,25 heute" },
          ],
        }),
      );
    const hint = await searchPriceHint("euro thing buy", {
      baseUrl: "http://searx.example",
      fetchImpl: fake,
    });
    expect(hint?.priceCents).toBe(325);
    expect(hint?.currency).toBe("EUR");
  });
});

describe("buildSearchQuery", () => {
  test("hostname slug + path tokens, noise words stripped, 'buy' appended, ≤ 6 terms", () => {
    expect(buildSearchQuery("https://www.coolshop.co.uk/products/fresh-kiss-trio?ref=x")).toBe(
      "coolshop.co.uk fresh kiss trio buy",
    );
  });
});

describe("buildTitleQuery", () => {
  test("title terms deduped, capped at 6, 'buy' appended", () => {
    expect(buildTitleQuery("LEGO Architecture 21042 Statue of Liberty")).toBe(
      "LEGO Architecture 21042 Statue of Liberty buy",
    );
    expect(buildTitleQuery("Mug mug MUG short")).toBe("Mug short buy");
    expect(buildTitleQuery("one two three four five six seven eight")).toBe(
      "one two three four five six buy",
    );
    expect(buildTitleQuery("   ")).toBe("");
  });
});

describe("queryTerms", () => {
  test("host slug, noise terms and the 'buy' tail are dropped", () => {
    expect(queryTerms("coolshop.co.uk teapot 123 buy")).toEqual(["teapot", "123"]);
    expect(queryTerms("host.com products fresh kiss trio buy")).toEqual(["fresh", "kiss", "trio"]);
    expect(queryTerms("next.co.uk buy")).toEqual([]);
    expect(queryTerms("   ")).toEqual([]);
  });

  test("a query without a host slug keeps all of its terms", () => {
    expect(queryTerms("teapot 123")).toEqual(["teapot", "123"]);
    expect(queryTerms("Teapot 123 buy")).toEqual(["teapot", "123"]);
  });
});

describe("isLandingShapedUrl", () => {
  test("landing/category shapes are rejected", () => {
    expect(isLandingShapedUrl("https://www.lyst.co.uk/designer/next/")).toBe(true); // #174
    expect(isLandingShapedUrl("https://example.com/")).toBe(true);
    expect(isLandingShapedUrl("https://example.com/brands/foo")).toBe(true);
    expect(isLandingShapedUrl("https://example.com/category/shoes")).toBe(true);
  });

  test("product-shaped URLs pass", () => {
    expect(isLandingShapedUrl("https://coolshop.co.uk/products/fresh-kiss-trio")).toBe(false);
    expect(isLandingShapedUrl("https://www.next.co.uk/style/su956648/w13137")).toBe(false);
    expect(isLandingShapedUrl("https://shop.example/lego-21042")).toBe(false);
    expect(isLandingShapedUrl("https://cool.example.com/p/1")).toBe(false);
  });

  test("an unparseable URL is not rejected (it falls through to the other filters)", () => {
    expect(isLandingShapedUrl("not a url")).toBe(false);
    expect(isLandingShapedUrl("")).toBe(false);
  });
});

describe("titleOverlapsQuery", () => {
  test("a shared whole word overlaps; an unrelated title does not", () => {
    expect(titleOverlapsQuery("Teapot 123 — Cool Shop", ["teapot", "123"])).toBe(true);
    expect(titleOverlapsQuery("Next Designer — Lyst", ["hoodie"])).toBe(false);
    expect(titleOverlapsQuery("Unrelated Gadget Sale", ["teapot", "123"])).toBe(false);
  });

  test("substrings are not matches, and an empty term set passes", () => {
    expect(titleOverlapsQuery("Teapotastic deal", ["teapot"])).toBe(false);
    expect(titleOverlapsQuery("Anything", [])).toBe(true);
  });
});

describe("searchPriceCandidates", () => {
  test("up to 3 candidates; own domain, duplicate URLs and price-less noise skipped", async () => {
    const fake: SearxngFetch = async (input) => {
      // Title-derived query, format locked — the URL's path plays no part.
      expect(String(input)).toContain(encodeURIComponent("Statue of Liberty buy"));
      expect(String(input)).toContain("format=json");
      return new Response(
        JSON.stringify({
          results: [
            // Own shop (the item's domain) — excluded from candidates.
            {
              title: "LEGO Architecture 21042 Statue of Liberty — John Lewis",
              url: "https://www.johnlewis.example.com/p/1",
              content: "£50.00",
            },
            { title: "Elsewhere", url: "https://a.example.com/p/1", content: "£44.99" },
            { title: "Elsewhere", url: "https://a.example.com/p/1", content: "£44.99" },
            { title: "Review", url: "https://review.example.com/x", content: "no price here" },
            { title: "Reseller b", url: "https://b.example.com/p/1", content: "Only £42.00" },
            { title: "Reseller c", url: "https://c.example.com/p/1", content: "€39,50" },
            { title: "Reseller d", url: "https://d.example.com/p/1", content: "£38.00" },
          ],
        }),
      );
    };
    const candidates = await searchPriceCandidates("Statue of Liberty", "johnlewis.example.com", {
      baseUrl: "http://searx.example",
      fetchImpl: fake,
    });
    expect(candidates.map((c) => c.sourceUrl)).toEqual([
      "https://a.example.com/p/1",
      "https://b.example.com/p/1",
      "https://c.example.com/p/1",
    ]);
    expect(candidates[0]).toEqual({
      priceCents: 4499,
      currency: "GBP",
      sourceUrl: "https://a.example.com/p/1",
      sourceTitle: "Elsewhere",
    });
    expect(candidates[2].priceCents).toBe(3950); // comma-decimal guard
  });

  test("empty title / no results / bad JSON / fetch throw / non-ok → [] (never throws)", async () => {
    const none = await searchPriceCandidates("", null, {
      baseUrl: "http://searx.example",
      fetchImpl: async () => new Response(JSON.stringify({ results: [] })),
    });
    expect(none).toEqual([]);

    const empty = await searchPriceCandidates("t", null, {
      baseUrl: "http://searx.example",
      fetchImpl: async () => new Response(JSON.stringify({ results: [] })),
    });
    expect(empty).toEqual([]);

    const badJson = await searchPriceCandidates("t", null, {
      baseUrl: "http://searx.example",
      fetchImpl: async () => new Response("not json"),
    });
    expect(badJson).toEqual([]);

    const notOk = await searchPriceCandidates("t", null, {
      baseUrl: "http://searx.example",
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    expect(notOk).toEqual([]);

    const throws = await searchPriceCandidates("t", null, {
      baseUrl: "http://searx.example",
      fetchImpl: async () => {
        throw new Error("boom");
      },
    });
    expect(throws).toEqual([]);
  });
});

describe("searchImageHint", () => {
  test("image category: first result with a usable img_src wins; wire format locked", async () => {
    const seen: string[] = [];
    const fake: SearxngFetch = async (input) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          results: [
            // General-category results carry an EMPTY img_src (verified against
            // the live instance) — skipped, never returned as an empty image.
            { title: "no picture", url: "https://a.example.com/x", img_src: "" },
            { title: "Widget 9000", url: "https://b.example.com/y", img_src: "https://cdn.example.com/widget.jpg" },
          ],
        }),
      );
    };
    const image = await searchImageHint("widget 9000 buy", {
      baseUrl: "http://searx.example",
      fetchImpl: fake,
    });
    expect(image).toBe("https://cdn.example.com/widget.jpg");
    expect(seen[0]).toContain("format=json");
    expect(seen[0]).toContain("categories=images");
  });

  test("no usable img_src / bad JSON / fetch throw → null (never throws)", async () => {
    const none = await searchImageHint("x", {
      baseUrl: "http://searx.example",
      fetchImpl: async () =>
        new Response(JSON.stringify({ results: [{ title: "t", url: "https://a.example.com", img_src: "" }] })),
    });
    expect(none).toBeNull();

    const badJson = await searchImageHint("x", {
      baseUrl: "http://searx.example",
      fetchImpl: async () => new Response("not json"),
    });
    expect(badJson).toBeNull();

    const throws = await searchImageHint("x", {
      baseUrl: "http://searx.example",
      fetchImpl: async () => {
        throw new Error("boom");
      },
    });
    expect(throws).toBeNull();
  });
});