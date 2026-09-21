import { useState } from "react";
import type { PricePoint, PriceStats, PriceTrend } from "../../shared/types";
import { centsToDecimal, formatPrice, toCents } from "../format";
import { S } from "../strings";
import { PriceGraph } from "./PriceGraph";

export { graphScale, gridlineValues, xLabels } from "./PriceGraph";

export type TrendWindow = "30d" | "90d";

const TREND_WINDOW_KEY = "sugarplum.trend-window";
const WINDOW_DAYS: Record<TrendWindow, number> = { "30d": 30, "90d": 90 };

export function readTrendWindow(): TrendWindow {
  try {
    return localStorage.getItem(TREND_WINDOW_KEY) === "90d" ? "90d" : "30d";
  } catch {
    return "30d";
  }
}

/** Advice enum → user-facing label. Informational, never buy/sell signaling. */
export function adviceLabel(advice: PriceTrend["advice"]): string {
  switch (advice) {
    case "below-30d-avg": return S.trend.below30dAvg;
    case "near-30d-low": return S.trend.near30dLow;
    case "near-30d-high": return S.trend.near30dHigh;
    case "trending-down": return S.trend.trendingDown;
    case "stable": return S.trend.stable;
    case "insufficient": return S.trend.insufficient;
  }
}

/** Caption under a DRAWN chart: the advice label when the server derived a
 *  real signal, the watching copy when it did not (null trend or the
 *  insufficient advice). #118: "Not enough history yet" renders ONLY in the
 *  no-chart empty state, never under a drawn chart. */
export function trendCaption(trend: PriceTrend | null): string {
  if (!trend || trend.advice === "insufficient") return S.trend.watching;
  return adviceLabel(trend.advice);
}

/** A mixed-currency series is not comparable and is never drawn. */
export function sameCurrencySeries(series: PricePoint[], currency: string | null): boolean {
  const code = (currency ?? "").trim().toUpperCase();
  return series.every((point) => (point.currency ?? "").trim().toUpperCase() === code);
}

/** Return drawable integer cents for the selected client-side window. */
export function trendCents(series: PricePoint[], window: TrendWindow): number[] {
  const inWindow = pointsInWindow(series, window);
  const cents = inWindow.map((point) => toCents(point.priceCents));
  return cents.every((value): value is number => value !== null) ? cents : [];
}

function pointsInWindow(series: PricePoint[], window: TrendWindow): PricePoint[] {
  if (window === "90d") return series;
  const cutoff = Date.now() - WINDOW_DAYS[window] * 86_400_000;
  return series.filter((point) => {
    const time = new Date(point.observedAt).getTime();
    return Number.isFinite(time) && time >= cutoff;
  });
}

interface PriceHistoryCardProps {
  stats: PriceStats;
  currency: string | null;
}

export function PriceHistoryCard({ stats, currency }: PriceHistoryCardProps) {
  const [window, setWindow] = useState<TrendWindow>(() => readTrendWindow());
  const windowPoints = pointsInWindow(stats.series, window);
  const values = trendCents(stats.series, window);
  const drawable = stats.series.length >= 2
    && sameCurrencySeries(stats.series, currency)
    && windowPoints.length >= 2
    && values.length === windowPoints.length;
  const current = values.at(-1) ?? values[0] ?? 0;
  const lowest = values.length > 0 ? Math.min(...values) : 0;
  const currentLabel = formatPrice(centsToDecimal(current), currency);
  const lowestLabel = formatPrice(centsToDecimal(lowest), currency);
  const windowLabel = window === "30d" ? "30 days" : "90 days";

  function selectWindow(next: TrendWindow) {
    setWindow(next);
    try {
      localStorage.setItem(TREND_WINDOW_KEY, next);
    } catch {
      // A blocked localStorage should not prevent the chart from switching.
    }
  }

  return (
    <section className="detail-card detail-history-card">
      <div className="detail-card-head">
        <h3 className="detail-card-title">{S.priceHistory.title}</h3>
        {drawable && (
          <div className="window-seg" role="group" aria-label={S.trend.windowLabel}>
            <button type="button" className={window === "30d" ? "active" : ""} aria-pressed={window === "30d"} onClick={() => selectWindow("30d")}>
              {S.trend.window30d}
            </button>
            <button type="button" className={window === "90d" ? "active" : ""} aria-pressed={window === "90d"} onClick={() => selectWindow("90d")}>
              {S.trend.window90d}
            </button>
          </div>
        )}
      </div>
      {drawable ? (
        <>
          <PriceGraph
            points={windowPoints}
            values={values}
            currency={currency}
            ariaLabel={S.priceHistory.graphLabel(windowLabel, currentLabel, lowestLabel)}
          />
          <p className="price-graph-caption">{trendCaption(stats.trend)}</p>
        </>
      ) : (
        <p className="price-history-empty">{S.trend.insufficient}</p>
      )}
    </section>
  );
}
