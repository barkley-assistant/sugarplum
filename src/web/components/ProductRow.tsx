import type { ReactNode } from "react";

interface ProductRowProps {
  id: string;
  title: string;
  /** Share view: dimmed + struck title + badge treatment. */
  purchased?: boolean;
  /** Thumbnail slot (ProductImage). */
  image?: ReactNode;
  /** The whole row opens details (owner rows). */
  onOpen?: () => void;
  /** Title-supporting column: retailer, pending/failed badges. */
  body?: ReactNode;
  /** Price column: current price + lowest. */
  price?: ReactNode;
  /** Delta line, positioned by the responsive grid. */
  delta?: ReactNode;
  /** One compact trigger per row. */
  actions?: ReactNode;
  /** Optional leading drag handle shown in reorder mode. */
  reorderHandle?: ReactNode;
  /** True while this row is lifted by the reorder state machine. */
  dragging?: boolean;
  /** Owner-only enrichment state; omitted on public/share rows. */
  fetchState?: "pending" | "complete" | "failed";
}

/** One row primitive for every list surface (owner, public, share). Owner
 *  rows use a stretched title button that NAVIGATES to the item page (#62) —
 *  no dialog semantics, it is an ordinary in-app link-button. */
export function ProductRow({
  id,
  title,
  purchased = false,
  image,
  onOpen,
  body,
  price,
  delta,
  actions,
  reorderHandle,
  dragging = false,
  fetchState,
}: ProductRowProps) {
  return (
    <li
      className={`card item-card${purchased ? " is-purchased" : ""}${dragging ? " dragging" : ""}${reorderHandle ? " is-reordering" : ""}`}
      data-item-id={id}
      data-fetch={fetchState && fetchState !== "complete" ? fetchState : undefined}
    >
      <div className="product-row-grid">
        {reorderHandle && <div className="product-row-handle">{reorderHandle}</div>}
        {image}
        <h3 className="item-title product-row-title">
          {onOpen ? (
            <button
              type="button"
              className="row-open"
              onClick={onOpen}
            >
              {title}
            </button>
          ) : title}
        </h3>
        <div className="product-row-body">{body}</div>
        {price && <div className="product-row-price">{price}</div>}
        {delta && <div className="product-row-delta">{delta}</div>}
        {actions && <div className="product-row-actions">{actions}</div>}
      </div>
    </li>
  );
}
