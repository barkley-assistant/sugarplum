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
  /** Tooltip for the row opener; the button's accessible name stays the title. */
  openLabel?: string;
  /** Title-supporting column: retailer, pending/failed badges. */
  body?: ReactNode;
  /** Price column: current price + lowest. */
  price?: ReactNode;
  /** Delta line, positioned by the responsive grid. */
  delta?: ReactNode;
  /** One compact trigger per row. */
  actions?: ReactNode;
  /** Owner-only enrichment state; omitted on public/share rows. */
  fetchState?: "pending" | "complete" | "failed";
}

/** One row primitive for every list surface (owner, public, share). Owner
 *  rows use a stretched title button; public/share rows keep a plain title. */
export function ProductRow({
  id,
  title,
  purchased = false,
  image,
  onOpen,
  openLabel,
  body,
  price,
  delta,
  actions,
  fetchState,
}: ProductRowProps) {
  return (
    <li
      className={`card item-card${purchased ? " is-purchased" : ""}`}
      data-item-id={id}
      data-fetch={fetchState && fetchState !== "complete" ? fetchState : undefined}
    >
      <div className="product-row-grid">
        {image}
        <h3 className="item-title product-row-title">
          {onOpen ? (
            <button
              type="button"
              className="row-open"
              onClick={onOpen}
              title={openLabel}
              aria-haspopup="dialog"
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
