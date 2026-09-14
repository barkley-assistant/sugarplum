import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { extractProduct } from "../src/server/scraper/parse";

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