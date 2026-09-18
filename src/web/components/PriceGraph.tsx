import { useId } from "react";
import type { PricePoint } from "../../shared/types";
import { centsToDecimal, formatDate, formatPrice } from "../format";

export interface GraphScale {
  min: number;
  max: number;
  yFor: (cents: number) => number;
  xFor: (index: number, count: number) => number;
}

/** Map integer-cent values into a padded plot rectangle. */
export function graphScale(values: number[], width: number, height: number, pad: number): GraphScale {
  if (values.length === 0) throw new Error("graphScale needs at least one value");
  const low = Math.min(...values);
  const high = Math.max(...values);
  const headroom = Math.max(1, Math.ceil((high - low) / 6));
  const min = low - headroom;
  const max = high + headroom;
  const span = max - min;
  return {
    min,
    max,
    yFor: (cents) => pad + ((max - cents) / span) * (height - pad * 2),
    xFor: (index, count) => count <= 1 ? width / 2 : pad + (index / (count - 1)) * (width - pad * 2),
  };
}

/** Return three to five human-friendly gridline values within a range. */
export function gridlineValues(min: number, max: number): number[] {
  if (min === max) return [min];
  const range = Math.abs(max - min);
  let step = niceStep(range / 4);
  let values = valuesAtStep(min, max, step);
  while (values.length > 5) {
    step *= 2;
    values = valuesAtStep(min, max, step);
  }
  while (values.length < 3) {
    step /= 2;
    values = valuesAtStep(min, max, step);
    if (step < Number.EPSILON) break;
  }
  return values;
}

function niceStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const ratio = raw / magnitude;
  if (ratio <= 1) return magnitude;
  if (ratio <= 2) return 2 * magnitude;
  if (ratio <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function valuesAtStep(min: number, max: number, step: number): number[] {
  const first = Math.ceil(min / step - Number.EPSILON) * step;
  const values: number[] = [];
  for (let value = first; value <= max + step * 0.000001; value += step) {
    values.push(Number(value.toFixed(6)));
  }
  return values;
}

/** Select up to five evenly spaced, unique calendar-day labels. */
export function xLabels(points: PricePoint[]): { index: number; label: string }[] {
  if (points.length === 0) return [];
  const count = Math.min(5, points.length);
  const candidates = count === 1
    ? [0]
    : Array.from({ length: count }, (_, index) => Math.round(index * (points.length - 1) / (count - 1)));
  const seenDates = new Set<string>();
  const labels: { index: number; label: string }[] = [];
  for (const index of candidates) {
    const date = new Date(points[index].observedAt);
    const time = date.getTime();
    const dateKey = Number.isFinite(time) ? date.toISOString().slice(0, 10) : `invalid-${index}`;
    if (seenDates.has(dateKey)) continue;
    seenDates.add(dateKey);
    labels.push({
      index,
      label: Number.isFinite(time)
        ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date)
        : "",
    });
  }
  return labels;
}

interface PriceGraphProps {
  points: PricePoint[];
  values: number[];
  currency: string | null;
  ariaLabel: string;
}

export function PriceGraph({ points, values, currency, ariaLabel }: PriceGraphProps) {
  const generatedId = useId().replace(/:/g, "");
  const width = 320;
  const height = 140;
  const left = 38;
  const top = 8;
  const plotWidth = width - left - 6;
  const plotHeight = 106;
  const scale = graphScale(values, plotWidth, plotHeight, 6);
  const coordinates = values.map((value, index) => ({
    x: left + scale.xFor(index, values.length),
    y: top + scale.yFor(value),
  }));
  const linePoints = coordinates.map(({ x, y }) => `${x},${y}`).join(" ");
  const baseline = top + plotHeight - 6;
  const areaPoints = `${left},${baseline} ${linePoints} ${width - 6},${baseline}`;
  const current = values.at(-1) ?? values[0];
  const endpoint = coordinates.at(-1) ?? coordinates[0];
  const currentLabel = formatPrice(centsToDecimal(current), currency);
  const tooltipWidth = 78;
  const tooltipHeight = 34;
  const tooltipX = Math.max(left, Math.min(endpoint.x - tooltipWidth + 8, width - tooltipWidth - 2));
  const tooltipY = Math.max(2, endpoint.y - tooltipHeight - 7);
  const yLines = gridlineValues(scale.min, scale.max);
  const labels = xLabels(points);

  return (
    <svg className="price-graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
      <defs>
        <linearGradient id={`price-area-${generatedId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--plum-500)" stopOpacity="0.24" />
          <stop offset="100%" stopColor="var(--plum-500)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {yLines.map((value) => {
        const y = top + scale.yFor(value);
        return (
          <g key={value}>
            <line className="price-graph-gridline" x1={left} x2={width - 6} y1={y} y2={y} />
            <text className="price-graph-y-label" x={left - 5} y={y + 3} textAnchor="end">
              {formatPrice(centsToDecimal(Math.round(value)), currency)}
            </text>
          </g>
        );
      })}
      <line className="price-graph-baseline" x1={left} x2={width - 6} y1={baseline} y2={baseline} />
      <polygon className="price-graph-area" points={areaPoints} fill={`url(#price-area-${generatedId})`} />
      <polyline className="price-graph-line" points={linePoints} />
      {labels.map(({ index, label }) => {
        const coordinate = coordinates[index];
        return (
          <g key={`${index}-${label}`}>
            <line className="price-graph-tick" x1={coordinate.x} x2={coordinate.x} y1={baseline} y2={baseline + 4} />
            <text
              className="price-graph-x-label"
              x={coordinate.x}
              y={baseline + 16}
              textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
            >
              {label}
            </text>
          </g>
        );
      })}
      <g className="price-graph-tooltip" aria-hidden="true">
        <rect x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} rx="6" />
        <text className="price-graph-tooltip-price" x={tooltipX + tooltipWidth / 2} y={tooltipY + 14} textAnchor="middle">
          {currentLabel}
        </text>
        <text className="price-graph-tooltip-date" x={tooltipX + tooltipWidth / 2} y={tooltipY + 27} textAnchor="middle">
          {formatDate(points.at(-1)?.observedAt ?? "")}
        </text>
      </g>
      <circle className="price-graph-endpoint-ring" cx={endpoint.x} cy={endpoint.y} r="5" />
      <circle className="price-graph-endpoint" cx={endpoint.x} cy={endpoint.y} r="2.5" />
    </svg>
  );
}
