/**
 * Buy-time trend signal (wave 25). A PURE function over a capped price
 * series: no DB, no fetch, no IO. All money math is integer cents.
 *
 * The advice labels are informational, never urgent: there is no "buy now"
 * verdict anywhere in this module.
 */

export type TrendDirection = "rising" | "falling" | "stable";

export type TrendAdvice =
  | "below-30d-avg"
  | "near-30d-low"
  | "near-30d-high"
  | "trending-down"
  | "stable"
  | "insufficient";

export interface TrendPoint {
  observedAt: string;
  priceCents: number;
}

export interface PriceTrend {
  direction: TrendDirection;
  /** Current price vs the 30-day average, in integer cents (signed). */
  deltaFromAvgCents: number;
  /** Days since the last observed drop (current < previous); null if no
   *  drop was ever observed. */
  daysSinceDrop: number | null;
  advice: TrendAdvice;
}

const DAY_MS = 86_400_000;
const WINDOW_30D_MS = 30 * DAY_MS;
/** Current vs the 30-day average must move this far to count as a trend. */
const TREND_BAND_PCT = 0.02;
/** Float-noise guard so an exact band boundary reads as stable. */
const EPS = 1e-9;

const INSUFFICIENT: PriceTrend = {
  direction: "stable",
  deltaFromAvgCents: 0,
  daysSinceDrop: null,
  advice: "insufficient",
};

export function deriveTrend(series: TrendPoint[], now: Date): PriceTrend | null {
  if (series.length === 0) return null;

  const nowMs = now.getTime();
  const window = series.filter((p) => {
    const t = new Date(p.observedAt).getTime();
    return Number.isFinite(t) && t <= nowMs + EPS && nowMs - t <= WINDOW_30D_MS;
  });
  if (window.length < 2) return { ...INSUFFICIENT };

  const firstMs = new Date(window[0].observedAt).getTime();
  const lastMs = new Date(window[window.length - 1].observedAt).getTime();
  // Everything observed within one day (add-day double scrape, same-day
  // re-check) carries no trend — saying anything would be hype.
  if (lastMs - firstMs < DAY_MS) return { ...INSUFFICIENT };

  const prices = window.map((p) => p.priceCents);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  // A flat series has no direction and no low/high worth naming.
  if (min === max) return { ...INSUFFICIENT };

  const sum = prices.reduce((a, b) => a + b, 0);
  const avg = sum / prices.length;
  const current = window[window.length - 1].priceCents;

  const direction: TrendDirection =
    current > avg * (1 + TREND_BAND_PCT) + EPS
      ? "rising"
      : current < avg * (1 - TREND_BAND_PCT) - EPS
        ? "falling"
        : "stable";

  let daysSinceDrop: number | null = null;
  for (let i = 1; i < window.length; i++) {
    if (window[i].priceCents < window[i - 1].priceCents) {
      const t = new Date(window[i].observedAt).getTime();
      daysSinceDrop = Math.max(0, Math.floor((nowMs - t) / DAY_MS));
    }
  }

  const deltaFromAvgCents = Math.round(current - avg);

  // Advice priority (first match wins). Being at the low IS below average,
  // so the low check comes first; a high reading is never actionable
  // ("stable", not "buy now before it rises").
  let advice: TrendAdvice;
  if (current <= min * 1.01) {
    advice = "near-30d-low";
  } else if (current >= max * 0.98) {
    advice = "near-30d-high";
  } else if (current < avg * (1 - TREND_BAND_PCT) && direction === "falling") {
    advice = "trending-down";
  } else if (current < avg) {
    advice = "below-30d-avg";
  } else {
    advice = "stable";
  }

  return { direction, deltaFromAvgCents, daysSinceDrop, advice };
}
