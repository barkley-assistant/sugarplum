import { S } from "../strings";

interface PriceClusterProps {
  /** Current formatted price, or null when there is none. */
  price: string | null;
  /** Unverified search price (owner-only), or null. */
  hintPrice?: string | null;
  /** Compact secondary metadata joined with " · " (lowest / at-add). */
  metaParts?: string[];
  /** #130: the current price IS the lowest seen — renders the quiet chip in
   *  the meta slot instead of a "Lowest £X" line that repeats the price. */
  atLowest?: boolean;
  /** "Down £X since added" / "Up £X since added", or null. */
  delta?: string | null;
}

/** Price information hierarchy: current price primary, lowest/at-add/delta
 *  as compact secondary metadata. Keeps the .price / .price-meta /
 *  .price-delta classes the e2e asserts. Never renders empty: a missing price
 *  shows a dash placeholder (#130) so every row keeps the same price rhythm. */
export function PriceCluster({
  price,
  hintPrice,
  metaParts = [],
  atLowest = false,
  delta,
}: PriceClusterProps) {
  return (
    <>
      <div className="price-cluster">
        {price ? (
          <span className="price">{price}</span>
        ) : hintPrice ? (
          <span className="hint-price">
            ~{hintPrice} <span className="hint-note">({S.item.hintPriceNote})</span>
          </span>
        ) : (
          <span className="price-unavailable">
            <span aria-hidden="true">—</span>
            <span className="visually-hidden">{S.item.priceUnavailable}</span>
          </span>
        )}
        {atLowest && <span className="price-meta price-at-lowest">{S.item.atLowest}</span>}
        {metaParts.length > 0 && <span className="price-meta">{metaParts.join(" · ")}</span>}
        {delta && <span className="price-delta">{delta}</span>}
      </div>
    </>
  );
}
