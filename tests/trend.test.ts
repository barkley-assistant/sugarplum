import { describe, expect, test } from "bun:test";
import { deriveTrend, type TrendPoint } from "../src/server/price/trend";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const DAY_MS = 86_400_000;

/** Point `daysAgo` days before NOW, oldest-first ordering left to the caller. */
function pt(daysAgo: number, priceCents: number): TrendPoint {
  return {
    observedAt: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
    priceCents,
  };
}

describe("deriveTrend", () => {
  test("empty series → null", () => {
    expect(deriveTrend([], NOW)).toBeNull();
  });

  test("one observation → insufficient", () => {
    expect(deriveTrend([pt(2, 1000)], NOW)?.advice).toBe("insufficient");
  });

  test("two identical prices → insufficient (a flat pair is not a trend)", () => {
    expect(deriveTrend([pt(4, 1000), pt(1, 1000)], NOW)?.advice).toBe("insufficient");
  });

  test("two observations within 24h → insufficient (same-day double scrape)", () => {
    const a = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const b = new Date(NOW.getTime() - 1 * 3_600_000).toISOString();
    const trend = deriveTrend(
      [
        { observedAt: a, priceCents: 1200 },
        { observedAt: b, priceCents: 1000 },
      ],
      NOW,
    );
    expect(trend?.advice).toBe("insufficient");
  });

  test("declining with a partial recovery → falling + trending-down", () => {
    const trend = deriveTrend(
      [pt(5, 1200), pt(4, 1100), pt(3, 1000), pt(2, 900), pt(1, 950)],
      NOW,
    );
    expect(trend?.direction).toBe("falling");
    expect(trend?.advice).toBe("trending-down");
    // The last drop (1000 → 900) was observed 2 days ago.
    expect(trend?.daysSinceDrop).toBe(2);
    expect(trend?.deltaFromAvgCents).toBeLessThan(0);
  });

  test("current at the window low → near-30d-low", () => {
    const trend = deriveTrend([pt(4, 1000), pt(3, 1100), pt(2, 1050), pt(1, 900)], NOW);
    expect(trend?.advice).toBe("near-30d-low");
    expect(trend?.direction).toBe("falling");
  });

  test("current at 99% of the window high → near-30d-high", () => {
    const trend = deriveTrend([pt(3, 1000), pt(2, 800), pt(1, 990)], NOW);
    expect(trend?.advice).toBe("near-30d-high");
  });

  test("dip then partial recovery → below-30d-avg", () => {
    const trend = deriveTrend([pt(4, 1100), pt(3, 1100), pt(2, 700), pt(1, 950)], NOW);
    expect(trend?.direction).toBe("stable");
    expect(trend?.advice).toBe("below-30d-avg");
    expect(trend?.daysSinceDrop).toBe(2);
  });

  test("monotonic rise → rising, never a drop, never a 'buy now'", () => {
    const trend = deriveTrend([pt(4, 800), pt(3, 900), pt(2, 1000), pt(1, 1100)], NOW);
    expect(trend?.direction).toBe("rising");
    expect(trend?.daysSinceDrop).toBeNull();
    expect(trend?.deltaFromAvgCents).toBeGreaterThan(0);
    // A high reading stays informational — never urgency-bait.
    expect(trend?.advice).toBe("near-30d-high");
  });

  test("2% band boundary is inclusive to stable", () => {
    // avg = 1000 exactly; current = 1020 = avg × 1.02 exactly.
    const trend = deriveTrend([pt(3, 900), pt(2, 1080), pt(1, 1020)], NOW);
    expect(trend?.direction).toBe("stable");
    expect(trend?.advice).toBe("stable");
  });

  test("observations older than 30 days are excluded from the window", () => {
    const ancient: TrendPoint = {
      observedAt: new Date(NOW.getTime() - 60 * DAY_MS).toISOString(),
      priceCents: 500,
    };
    const trend = deriveTrend([ancient, pt(3, 1000), pt(2, 950), pt(1, 1000)], NOW);
    // Window avg = (1000 + 950 + 1000) / 3 = 983.33 → delta rounds to 17.
    // With the ancient 500 included the delta would be ~138.
    expect(trend?.deltaFromAvgCents).toBe(17);
  });

  test("an all-ancient series → insufficient", () => {
    const ancient = (days: number, cents: number): TrendPoint => ({
      observedAt: new Date(NOW.getTime() - days * DAY_MS).toISOString(),
      priceCents: cents,
    });
    expect(deriveTrend([ancient(60, 1000), ancient(45, 900)], NOW)?.advice).toBe("insufficient");
  });
});
