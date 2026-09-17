import type { ReactNode } from "react";
import type { PriceHintState } from "../../shared/types";
import { formatPrice, urlHost } from "../format";
import { S } from "../strings";
import { Sparkline } from "./Sparkline";

/** Sparkline window-chip state. Display-only, persisted in localStorage. */
export type TrendWindow = "30d" | "90d";

interface PriceClusterProps {
  /** Current formatted price, or null when there is none. */
  price: string | null;
  /** Unverified search price (owner-only), or null. */
  hintPrice?: string | null;
  /** Compact secondary metadata joined with " · " (lowest / at-add). */
  metaParts?: string[];
  /** "Down £X since added" / "Up £X since added", or null. */
  delta?: string | null;
  /** Trend block (window chip + sparkline + advice) when history allows. */
  trend?: ReactNode;
  /** Hints disclosure (owner-only candidates lookup). */
  hints?: ReactNode;
}

/** Price information hierarchy: current price primary, lowest/at-add/delta
 *  as compact secondary metadata, trend + hints slotted below. Keeps the
 *  .price / .price-meta / .price-delta classes the e2e asserts. */
export function PriceCluster({ price, hintPrice, metaParts = [], delta, trend, hints }: PriceClusterProps) {
  return (
    <>
      <div className="price-cluster">
        {price ? (
          <span className="price">{price}</span>
        ) : (
          hintPrice && (
            <span className="hint-price">
              ~{hintPrice} <span className="hint-note">({S.item.hintPriceNote})</span>
            </span>
          )
        )}
        {metaParts.length > 0 && <span className="price-meta">{metaParts.join(" · ")}</span>}
        {delta && <span className="price-delta">{delta}</span>}
      </div>
      {trend}
      {hints}
    </>
  );
}

interface TrendBlockProps {
  window: TrendWindow;
  onWindow: (next: TrendWindow) => void;
  values: number[];
  advice: string | null;
}

/** Wave-25 trend surface, unchanged: 30d/90d chip + sparkline + advice. */
export function TrendBlock({ window, onWindow, values, advice }: TrendBlockProps) {
  return (
    <div className="price-trend">
      <div className="window-chip" role="group" aria-label={S.trend.windowLabel}>
        <button
          type="button"
          aria-pressed={window === "30d"}
          className={window === "30d" ? "active" : ""}
          onClick={() => onWindow("30d")}
        >
          {S.trend.window30d}
        </button>
        <button
          type="button"
          aria-pressed={window === "90d"}
          className={window === "90d" ? "active" : ""}
          onClick={() => onWindow("90d")}
        >
          {S.trend.window90d}
        </button>
      </div>
      {values.length >= 2 && (
        <div className="sparkline-wrap">
          <Sparkline values={values} />
        </div>
      )}
      {advice && <span className="advice-label">{advice}</span>}
    </div>
  );
}

interface HintsBlockProps {
  itemId: string;
  open: boolean;
  onToggle: () => void;
  hintState?: PriceHintState;
  leading?: ReactNode;
  trailing?: ReactNode;
  label?: string;
}

/** Owner-only "prices seen elsewhere" disclosure: on-demand candidates
 *  fetched on each open. Copy and classes verbatim (e2e-anchored). */
export function HintsBlock({ itemId, open, onToggle, hintState, leading, trailing, label = S.item.pricesElsewhere }: HintsBlockProps) {
  return (
    <div className="hint-block">
      <button
        type="button"
        className="secondary hints-toggle"
        aria-expanded={open}
        aria-controls={`hints-${itemId}`}
        onClick={onToggle}
      >
        {leading}
        {label}
        {trailing}
      </button>
      {open && (
        <div className="hint-candidates" id={`hints-${itemId}`}>
          {(!hintState || hintState.status === "loading") && (
            <p className="muted">{S.item.checkingPrices}</p>
          )}
          {hintState?.status === "error" && <p className="muted">{S.errors.checkPrices}</p>}
          {hintState?.status === "done" && hintState.disabled && (
            <p className="muted">{S.item.hintsDisabled}</p>
          )}
          {hintState?.status === "done" && !hintState.disabled && hintState.hints.length === 0 && (
            <p className="muted">{S.item.hintsNone}</p>
          )}
          {hintState?.status === "done" && !hintState.disabled && hintState.hints.length > 0 && (
            <ul className="hint-list">
              {hintState.hints.map((candidate) => (
                <li key={candidate.sourceUrl}>
                  <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">
                    {formatPrice(candidate.priceCents, candidate.currency)} at{" "}
                    {urlHost(candidate.sourceUrl)}
                  </a>
                  <span className="hint-note"> — {S.item.hintCandidateNote}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="hint-footnote">{S.item.hintsFootnote}</p>
        </div>
      )}
    </div>
  );
}
