import { describe, expect, test } from "bun:test";
import { formatPrice, formatRelativeTime } from "../src/web/format";

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