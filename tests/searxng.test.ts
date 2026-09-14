// tests/searxng.test.ts — fetcher ALWAYS injected; zero network
import { describe, expect, test } from "bun:test";
import { buildSearchQuery, searchPriceHint, type SearxngFetch } from "../src/server/searxng";

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