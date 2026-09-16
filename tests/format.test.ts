import { describe, expect, test } from "bun:test";
import { centsToDecimal, formatPrice, formatRelativeTime, parseShareTarget, toCents, urlHost } from "../src/web/format";

describe("formatPrice", () => {
  test("GBP 24.99 → £24.99", () => {
    expect(formatPrice("24.99", "GBP")).toBe("£24.99");
  });

  test("USD 24.99 → $24.99", () => {
    expect(formatPrice("24.99", "USD")).toBe("$24.99");
  });

  test("EUR 24.99 → €24.99", () => {
    expect(formatPrice("24.99", "EUR")).toBe("€24.99");
  });

  test("null cents → empty string", () => {
    expect(formatPrice(null, "GBP")).toBe("");
  });

  test("lowercase currency code is uppercased", () => {
    expect(formatPrice("24.99", "usd")).toBe("$24.99");
  });

  test("invalid code → '<amount> <CODE>' fallback shape", () => {
    expect(formatPrice("24.99", "XYZ")).toBe("24.99 XYZ");
  });

  test("no currency → raw decimal string", () => {
    expect(formatPrice("24.99", null)).toBe("24.99");
  });

  test("large amounts get thousands grouping", () => {
    expect(formatPrice("1234.56", "USD")).toBe("$1,234.56");
  });

  test("single-decimal input pads to two places", () => {
    expect(formatPrice("12.5", "GBP")).toBe("£12.50");
  });
});

describe("toCents / centsToDecimal", () => {
  test("decimal string → integer cents, no float drift", () => {
    expect(toCents("24.99")).toBe(2499);
    expect(toCents("12.50")).toBe(1250);
    expect(toCents("12.5")).toBe(1250);
    expect(toCents("0.05")).toBe(5);
    expect(toCents("1234.56")).toBe(123456);
    expect(toCents(null)).toBeNull();
    expect(toCents("")).toBeNull();
    expect(toCents("abc")).toBeNull();
  });

  test("cents → decimal string round-trips small deltas exactly", () => {
    expect(centsToDecimal(2499)).toBe("24.99");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(centsToDecimal(123456)).toBe("1234.56");
    expect(centsToDecimal(0)).toBe("0.00");
    // 1250 - 1000 = 250 → "2.50": the ItemCard delta path.
    expect(centsToDecimal(Math.abs(1250 - 1000))).toBe("2.50");
    expect(toCents(centsToDecimal(2499))).toBe(2499);
  });
});

describe("urlHost", () => {
  test("strips www. and returns the host", () => {
    expect(urlHost("https://www.johnlewis.example.com/p/1")).toBe("johnlewis.example.com");
    expect(urlHost("https://a.example.com/x")).toBe("a.example.com");
  });

  test("unparseable input is returned unchanged", () => {
    expect(urlHost("not a url")).toBe("not a url");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");

  test("under a minute → just now", () => {
    expect(formatRelativeTime("2026-09-15T11:59:30Z", now)).toBe("just now");
  });

  test("minutes → 5m ago", () => {
    expect(formatRelativeTime("2026-09-15T11:55:00Z", now)).toBe("5m ago");
  });

  test("hours → 2h ago", () => {
    expect(formatRelativeTime("2026-09-15T10:00:00Z", now)).toBe("2h ago");
  });

  test("days → 3d ago", () => {
    expect(formatRelativeTime("2026-09-12T12:00:00Z", now)).toBe("3d ago");
  });

  test("future timestamps clamp to just now", () => {
    expect(formatRelativeTime("2026-09-15T13:00:00Z", now)).toBe("just now");
  });

  test("invalid input → empty string", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });
});

describe("parseShareTarget", () => {
  test("canonical shape: url + title params pass through", () => {
    const p = new URLSearchParams({ url: "https://example.com/x", title: "Test item" });
    expect(parseShareTarget(p)).toEqual({ url: "https://example.com/x", title: "Test item" });
  });

  test("text-only share: URL token + first line become url/title", () => {
    const p = new URLSearchParams({ text: "Check this out\nhttps://example.com/x" });
    expect(parseShareTarget(p)).toEqual({
      url: "https://example.com/x",
      title: "Check this out",
    });
  });

  test("text-only URL: url extracted, title left empty for server auto-fill", () => {
    const p = new URLSearchParams({ text: "https://example.com/x" });
    expect(parseShareTarget(p)).toEqual({ url: "https://example.com/x", title: "" });
  });

  test("title param wins over text line; url param wins over text token", () => {
    const p = new URLSearchParams({
      title: "My title",
      url: "https://param.example.com",
      text: "https://text.example.com\nignored line",
    });
    expect(parseShareTarget(p)).toEqual({
      url: "https://param.example.com",
      title: "My title",
    });
  });

  test("trailing punctuation is stripped from a text URL token", () => {
    const p = new URLSearchParams({ text: "see https://example.com/x, thanks!" });
    expect(parseShareTarget(p).url).toBe("https://example.com/x");
  });

  test("no params → both empty", () => {
    expect(parseShareTarget(new URLSearchParams())).toEqual({ url: "", title: "" });
  });
});