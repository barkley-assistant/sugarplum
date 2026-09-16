import type { ReactNode } from "react";

interface ProductRowProps {
  id: string;
  title: string;
  /** Share view: dimmed + struck title + badge treatment. */
  purchased?: boolean;
  /** True while lifted by the drag state machine. */
  dragging?: boolean;
  /** Drag handle slot (owner rows only). */
  dragHandle?: ReactNode;
  /** Thumbnail slot (ProductImage). */
  image?: ReactNode;
  /** Single compact trigger: owner overflow, public claim control, or
   *  share overflow. The only permanently visible per-item control. */
  actions?: ReactNode;
  /** Title-supporting column: site, price cluster, link, notes, tags,
   *  fetch state. */
  meta?: ReactNode;
  /** Full-width blocks below the row: trend, hints disclosure. */
  below?: ReactNode;
}

/** One row primitive for every list surface (owner, public, share). Keeps
 *  .item-card + .item-title + data-item-id: the drag machine and the e2e
 *  select them. Layout: [handle] [thumb] [body] [trigger]; meta wraps
 *  under the title on narrow widths. */
export function ProductRow({
  id,
  title,
  purchased = false,
  dragging = false,
  dragHandle,
  image,
  actions,
  meta,
  below,
}: ProductRowProps) {
  return (
    <li
      className={`card item-card${dragging ? " dragging" : ""}${purchased ? " is-purchased" : ""}`}
      data-item-id={id}
    >
      <div className="item-card-row product-row-grid">
        {dragHandle}
        {image}
        <div className="item-card-text product-row-body">
          <div className="product-row-title-row">
            <h3 className="item-title">{title}</h3>
          </div>
          {meta}
        </div>
        {actions && <div className="product-row-actions">{actions}</div>}
      </div>
      {below && <div className="product-row-detail">{below}</div>}
    </li>
  );
}
