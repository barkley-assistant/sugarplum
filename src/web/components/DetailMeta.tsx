import { S } from "../strings";
import type { PriceDelta } from "./ItemCard";

interface DetailMetaProps {
  /** "Lowest £9.99" — null when the item has no price history. */
  meta: string | null;
  /** The move since the item was added — null when there is nothing honest
   *  to say (no history, no current price, no change). */
  delta: PriceDelta | null;
}

/** The lowest-observed + since-added row that sits under the price. ONE
 *  component for both detail surfaces — the owner's item page and the
 *  read-only guest sheet — so the two cannot drift apart. Renders nothing
 *  when neither value exists. */
export function DetailMeta({ meta, delta }: DetailMetaProps) {
  if (!meta && !delta) return null;
  return (
    <div className="detail-meta">
      {meta && <span>{meta}</span>}
      {meta && delta && <span className="detail-meta-sep" aria-hidden="true" />}
      {delta && (
        <span className="price-delta" data-direction={delta.direction}>
          <span className="delta-arrow" aria-hidden="true">
            <DeltaArrow direction={delta.direction} />
          </span>
          <span className="visually-hidden">{delta.direction === "down" ? "Down " : "Up "}</span>
          <span className="delta-copy">{S.item.deltaSinceAdd(delta.amount)}</span>
        </span>
      )}
    </div>
  );
}

function DeltaArrow({ direction }: { direction: "down" | "up" }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path
        d={direction === "down" ? "M5 1.5v7M1.5 5 5 8.5 8.5 5" : "M5 8.5v-7M1.5 5 5 1.5 8.5 5"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
