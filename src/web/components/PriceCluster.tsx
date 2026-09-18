import { S } from "../strings";

interface PriceClusterProps {
  /** Current formatted price, or null when there is none. */
  price: string | null;
  /** Unverified search price (owner-only), or null. */
  hintPrice?: string | null;
  /** Compact secondary metadata joined with " · " (lowest / at-add). */
  metaParts?: string[];
  /** "Down £X since added" / "Up £X since added", or null. */
  delta?: string | null;
}

/** Price information hierarchy: current price primary, lowest/at-add/delta
 *  as compact secondary metadata. Keeps the .price / .price-meta /
 *  .price-delta classes the e2e asserts. */
export function PriceCluster({ price, hintPrice, metaParts = [], delta }: PriceClusterProps) {
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
    </>
  );
}
