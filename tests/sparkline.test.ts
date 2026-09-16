import { describe, expect, test } from "bun:test";
import { adviceLabel, sameCurrencySeries, trendCents } from "../src/web/components/ItemCard";
import { mapPointsToViewBox } from "../src/web/components/Sparkline";
import type { PricePoint } from "../src/shared/types";

function point(daysAgo: number, priceCents: string, currency: string | null = "GBP"): PricePoint {
  return {
    observedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    priceCents,
    currency,
  };
}

describe("mapPointsToViewBox", () => {
  test("empty → empty", () => {
    expect(mapPointsToViewBox([], 120, 36)).toEqual([]);
  });

  test("single point → a dot at mid-height", () => {
    expect(mapPointsToViewBox([500], 120, 36)).toEqual([{ x: 0, y: 18 }]);
  });

  test("flat series → a flat line at mid-height", () => {
    expect(mapPointsToViewBox([1000, 1000, 1000], 120, 36)).toEqual([
      { x: 0, y: 18 },
      { x: 60, y: 18 },
      { x: 120, y: 18 },
    ]);
  });

  test("rising series maps low→bottom, high→top with integer pixels", () => {
    expect(mapPointsToViewBox([100, 200, 300], 100, 36)).toEqual([
      { x: 0, y: 34 },
      { x: 50, y: 18 },
      { x: 100, y: 2 },
    ]);
  });
});

describe("adviceLabel", () => {
  test("every advice maps to honest, non-urgent copy", () => {
    expect(adviceLabel("below-30d-avg")).toBe("Below 30-day average");
    expect(adviceLabel("near-30d-low")).toBe("At 30-day low");
    expect(adviceLabel("near-30d-high")).toBe("Near 30-day high");
    expect(adviceLabel("trending-down")).toBe("Trending down — could wait");
    expect(adviceLabel("stable")).toBe("Stable");
    expect(adviceLabel("insufficient")).toBe("Not enough history yet");
  });
});

describe("sameCurrencySeries", () => {
  test("matching and null currencies draw; mixed never draws", () => {
    expect(sameCurrencySeries([point(2, "10.00"), point(1, "9.00")], "GBP")).toBe(true);
    expect(sameCurrencySeries([point(2, "10.00", "gbp"), point(1, "9.00", "GBP")], "GBP")).toBe(
      true,
    );
    expect(sameCurrencySeries([point(2, "10.00", null)], null)).toBe(true);
    expect(sameCurrencySeries([point(2, "10.00"), point(1, "9.00", "USD")], "GBP")).toBe(false);
  });
});

describe("trendCents", () => {
  test("90d passes the whole series through as integer cents", () => {
    expect(trendCents([point(60, "12.00"), point(10, "10.00"), point(1, "9.50")], "90d")).toEqual([
      1200, 1000, 950,
    ]);
  });

  test("30d slices off older points", () => {
    expect(trendCents([point(60, "12.00"), point(10, "10.00"), point(1, "9.50")], "30d")).toEqual([
      1000, 950,
    ]);
  });

  test("an unparseable point hides the sparkline (never a partial series)", () => {
    expect(trendCents([point(2, "10.00"), point(1, "nonsense")], "90d")).toEqual([]);
  });
});
