import { describe, expect, test } from "bun:test";
import {
  adviceLabel,
  graphScale,
  gridlineValues,
  sameCurrencySeries,
  trendCents,
  xLabels,
} from "../src/web/components/PriceHistoryCard";
import type { PricePoint } from "../src/shared/types";

function point(daysAgo: number, priceCents: string, currency: string | null = "GBP"): PricePoint {
  return {
    observedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    priceCents,
    currency,
  };
}

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
    expect(sameCurrencySeries([point(2, "10.00", "gbp"), point(1, "9.00", "GBP")], "GBP")).toBe(true);
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

  test("an unparseable point hides the graph (never a partial series)", () => {
    expect(trendCents([point(2, "10.00"), point(1, "nonsense")], "90d")).toEqual([]);
  });
});

describe("graphScale", () => {
  test("adds headroom and maps lower values below higher values", () => {
    const scale = graphScale([100, 200, 300], 280, 100, 6);
    expect(scale.min).toBeLessThan(100);
    expect(scale.max).toBeGreaterThan(300);
    expect(scale.yFor(100)).toBeGreaterThan(scale.yFor(300));
    expect(scale.xFor(0, 3)).toBeLessThan(scale.xFor(2, 3));
  });

  test("flat series gets one-cent headroom on either side", () => {
    const scale = graphScale([500, 500], 280, 100, 6);
    expect(scale.min).toBe(499);
    expect(scale.max).toBe(501);
    expect(scale.yFor(500)).toBe(50);
  });

  test("empty input is rejected because callers gate it", () => {
    expect(() => graphScale([], 280, 100, 6)).toThrow("at least one");
  });
});

describe("gridlineValues", () => {
  test("returns three to five nice values inside the range", () => {
    const values = gridlineValues(100, 300);
    expect(values.length).toBeGreaterThanOrEqual(3);
    expect(values.length).toBeLessThanOrEqual(5);
    expect(values.every((value) => value >= 100 && value <= 300)).toBe(true);
    expect(values).toEqual([100, 150, 200, 250, 300]);
  });

  test("a degenerate range returns the one known value", () => {
    expect(gridlineValues(500, 500)).toEqual([500]);
  });
});

describe("xLabels", () => {
  test("samples evenly, keeps endpoints, and caps labels at five", () => {
    const labels = xLabels(Array.from({ length: 10 }, (_, index) => point(10 - index, `${index + 1}.00`)));
    expect(labels.length).toBeLessThanOrEqual(5);
    expect(labels[0]?.index).toBe(0);
    expect(labels.at(-1)?.index).toBe(9);
  });

  test("suppresses duplicate calendar-day labels", () => {
    const points = [point(1, "10.00"), point(1, "9.50"), point(0, "9.00")];
    const labels = xLabels(points);
    expect(new Set(labels.map(({ label }) => label)).size).toBe(labels.length);
  });
});
