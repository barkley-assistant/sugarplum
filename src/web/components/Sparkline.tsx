/** Hand-rolled price sparkline (wave 25): an inline SVG polyline over a
 *  comparable series, no chart dependency. No axes, no tooltips — the advice
 *  label carries the meaning; this is a glance. Decorative (aria-hidden);
 *  the trend text next to it is the accessible signal. */

export interface SparklineProps {
  /** Integer cents, oldest first. The caller passes a single-currency
   *  series; mixed currencies are never rendered. */
  values: number[];
  /** viewBox width; the SVG stretches to 100% of its wrap via CSS. */
  width?: number;
  /** viewBox height. */
  height?: number;
}

export interface ViewBoxPoint {
  x: number;
  y: number;
}

/** Pure: map values to integer viewBox coords. A flat series (or a single
 *  point) renders as a flat line at mid-height. Exported for tests. */
export function mapPointsToViewBox(
  values: number[],
  width: number,
  height: number,
): ViewBoxPoint[] {
  if (values.length === 0) return [];
  const pad = 2;
  const span = Math.max(0, height - pad * 2);
  if (values.length === 1) {
    return [{ x: 0, y: Math.round(pad + span / 2) }];
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  return values.map((v, i) => {
    const x = Math.round((i / (values.length - 1)) * width);
    const y = max === min ? Math.round(pad + span / 2) : Math.round(pad + (1 - (v - min) / (max - min)) * span);
    return { x, y };
  });
}

export function Sparkline({ values, width = 120, height = 36 }: SparklineProps) {
  const coords = mapPointsToViewBox(values, width, height);
  if (coords.length === 0) return null;

  let lowIdx = 0;
  values.forEach((v, i) => {
    if (v < values[lowIdx]) lowIdx = i;
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="sparkline"
      aria-hidden="true"
    >
      {coords.length === 1 ? (
        <circle cx={coords[0].x} cy={coords[0].y} r={2} className="sparkline-dot" />
      ) : (
        <>
          <polyline
            points={coords.map((c) => `${c.x},${c.y}`).join(" ")}
            className="sparkline-line"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={coords[lowIdx].x} cy={coords[lowIdx].y} r={2} className="sparkline-low" />
        </>
      )}
    </svg>
  );
}
