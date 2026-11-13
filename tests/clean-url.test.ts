import { describe, expect, test } from "bun:test";
import { cleanProductUrl } from "../src/server/net/clean-url";

describe("cleanProductUrl", () => {
  // The URL measured off a real /uk/ search-result paste (2026-11-13): nine
  // tracking params around the ONE selection param. Selection survives
  // (Etsy server-renders the selected variation's price into its JSON-LD),
  // tracking goes.
  test("etsy paste: tracking stripped, variation0 preserved", () => {
    const messy =
      "https://www.etsy.com/uk/listing/4596562701/retro-playstation-2-poster-y2k-gaming" +
      "?ls=s&ga_order=most_relevant&ga_search_type=all&ga_view_type=gallery" +
      "&ga_search_query=ps2+poster&ref=sr_gallery-1-7&pro=1" +
      "&content_source=a654ea9a-d320-4307-9329-0797ddfad61e%3ALT459e3615e16de81aaab87691842039b6151e2111" +
      "&organic_search_click=1" +
      "&logging_key=a654ea9a-d320-4307-9329-0797ddfad61e%3ALT459e3615e16de81aaab87691842039b6151e2111" +
      "&variation0=7281367886";
    expect(cleanProductUrl(messy)).toBe(
      "https://www.etsy.com/uk/listing/4596562701/retro-playstation-2-poster-y2k-gaming?variation0=7281367886",
    );
  });

  test("selection params from other shop families are preserved", () => {
    expect(cleanProductUrl("https://shop.example.com/products/tshirt?variant=4242&utm_source=x")).toBe(
      "https://shop.example.com/products/tshirt?variant=4242",
    );
    expect(cleanProductUrl("https://www.etsy.com/listing/1/x?variation0=1&variation1=2&ref=f")).toBe(
      "https://www.etsy.com/listing/1/x?variation0=1&variation1=2",
    );
    expect(cleanProductUrl("https://amzn.example/dp/B0X?psc=1&th=1&gclid=AAA")).toBe(
      "https://amzn.example/dp/B0X?psc=1&th=1",
    );
  });

  test("utm_* prefix family is stripped case-insensitively; unknown params stay", () => {
    expect(cleanProductUrl("https://s.example/p?UTM_Source=a&utm_campaign=b&keep=1")).toBe(
      "https://s.example/p?keep=1",
    );
    // Unknown params are NOT stripped — the denylist never guesses at
    // selection data (even a suspicious name like `tag`, which is an
    // Amazon affiliate id but a plain filter elsewhere).
    expect(cleanProductUrl("https://s.example/p?size=large&colour=red&tag=filter")).toBe(
      "https://s.example/p?size=large&colour=red&tag=filter",
    );
  });

  test("all params stripped → query removed entirely (dedup-stable URL)", () => {
    expect(cleanProductUrl("https://www.etsy.com/listing/1/x?ref=f&utm_source=t")).toBe(
      "https://www.etsy.com/listing/1/x",
    );
  });

  test("path, fragment and no-query URLs pass through untouched", () => {
    const u = "https://s.example/products/x?variant=1";
    expect(cleanProductUrl(u)).toBe(u);
    expect(cleanProductUrl("https://s.example/products/x")).toBe("https://s.example/products/x");
    // Fragment-embedded params are NOT cleaned: in `#/route?x` the query is
    // part of the fragment (client-side router state, never a product
    // selection param for the shops we track). Rewriting fragments risks
    // mangling router paths, so the whole fragment passes through.
    const frag = "https://s.example/#/product/9?utm_source=a&keep=2";
    expect(cleanProductUrl(frag)).toBe(frag);
  });

  test("unparseable input is returned as-is (validation lives upstream)", () => {
    expect(cleanProductUrl("not a url")).toBe("not a url");
    expect(cleanProductUrl("")).toBe("");
  });

  test("repeated tracking occurrences are all removed", () => {
    expect(cleanProductUrl("https://s.example/p?a=1&utm_source=x&utm_source=y")).toBe(
      "https://s.example/p?a=1",
    );
  });
});
