import { describe, expect, test } from "bun:test";
import { normalizeHostname, resolveOverride, SITE_OVERRIDES } from "../src/server/scraper/overrides";

describe("override registry", () => {
  test("smythstoys.com is registered with stealth-first chain", () => {
    const o = resolveOverride("https://www.smythstoys.com/en-gb/p/248662");
    expect(o?.strategies).toEqual(["stealth-browser", "plain"]);
  });

  test("amazon hosts registered plain-first with stealth fallback", () => {
    for (const host of ["amazon.co.uk", "amazon.com", "amazon.de"]) {
      const o = resolveOverride(`https://www.${host}/dp/B0EXAMPLE1`);
      expect(o?.strategies).toEqual(["plain", "stealth-browser"]);
      expect(o?.notes).toContain("stealth");
    }
  });

  test("amazon matching is exact: other TLDs and look-alike hosts stay unregistered", () => {
    expect(resolveOverride("https://www.amazon.co.jp/dp/B0EXAMPLE1")).toBeUndefined();
    expect(resolveOverride("https://amazon.co.uk.evil.example.com/dp/x")).toBeUndefined();
    expect(resolveOverride("https://www.notamazon.co.uk/dp/x")).toBeUndefined();
  });

  test("hostname normalization: lowercase, strip leading www., ignore port", () => {
    expect(normalizeHostname("https://WWW.Example.com:443/x")).toBe("example.com");
    expect(normalizeHostname("https://blog.example.com/x")).toBe("blog.example.com"); // NOT example.com
    expect(normalizeHostname("not a url")).toBeNull();
  });

  test("unregistered host → undefined", () => {
    expect(resolveOverride("https://colourpop.com/products/x")).toBeUndefined();
  });

  test("registry invariants: lowercase keys, no www., non-empty known strategies", () => {
    for (const [host, o] of Object.entries(SITE_OVERRIDES)) {
      expect(host).toBe(host.toLowerCase());
      expect(host.startsWith("www.")).toBe(false);
      expect(o.strategies.length).toBeGreaterThan(0);
      expect(o.notes.length).toBeGreaterThan(0);
      for (const s of o.strategies)
        expect(["plain", "custom-headers", "stealth-browser"]).toContain(s);
    }
  });
});
