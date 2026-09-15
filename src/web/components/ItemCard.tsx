import { useState, type ReactNode } from "react";
import type { OwnedItem, PublicItem } from "../../shared/types";
import { formatPrice } from "../format";
import { S } from "../strings";
import { useConfirm } from "../confirm";
import { ItemForm, type ItemFormValues } from "./ItemForm";

interface ItemCardProps {
  item: OwnedItem | PublicItem;
  viewerIsOwner: boolean;
  onEdit?: (id: string, values: ItemFormValues) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
  onClaim?: (id: string) => void | Promise<void>;
  onUnclaim?: (id: string) => void | Promise<void>;
  onRefresh?: (id: string) => void | Promise<void>;
  /** Drag handle slot (pointer state machine wired by AppPage). */
  dragHandle?: ReactNode;
  /** True while this card is lifted by the drag state machine. */
  dragging?: boolean;
}

export function ItemCard({
  item,
  viewerIsOwner,
  onEdit,
  onDelete,
  onClaim,
  onUnclaim,
  onRefresh,
  dragHandle,
  dragging = false,
}: ItemCardProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const confirm = useConfirm();

  async function handleEdit(id: string, values: ItemFormValues) {
    if (onEdit) {
      await onEdit(id, values);
      setEditingId(null);
    }
  }

  async function handleDelete(item: OwnedItem) {
    if (!onDelete) return;
    const ok = await confirm({
      title: S.confirm.deleteItem(item.title),
      body: S.confirm.deleteItemBody,
    });
    if (ok) await onDelete(item.id);
  }

  const price = formatPrice(item.priceCents, item.currency);
  const hintPrice = viewerIsOwner
    ? formatPrice((item as OwnedItem).hintPriceCents, (item as OwnedItem).hintCurrency)
    : "";
  const publicItem = item as PublicItem;

  return (
    <li className={`card item-card${dragging ? " dragging" : ""}`} data-item-id={item.id}>
      <div className="item-card-row">
        {dragHandle}
        <div className="item-card-main">
          {item.imagePath && (
            <img
              className="item-thumb"
              src={`/api/wishlist/items/${item.id}/image`}
              alt=""
              loading="lazy"
            />
          )}
          <div className="item-card-text">
            <h3 className="item-title">{item.title}</h3>
            {item.siteName && <span className="item-site">{item.siteName}</span>}
            {/* Provenance note: this item's picture came from a search, not
                from the shop. Owner-only, like the price hint. */}
            {viewerIsOwner && item.imageSource === "search" && (
              <span className="item-image-source">{S.item.imageViaSearch}</span>
            )}
            {item.url && (
              <a className="item-link" href={item.url} target="_blank" rel="noreferrer">
                {item.url}
              </a>
            )}
            {item.notes && <p className="item-notes">{item.notes}</p>}
            {item.tags.length > 0 && (
              <div className="tags">
                {item.tags.map((t) => (
                  <span key={t} className="tag-pill">
                    #{t}
                  </span>
                ))}
              </div>
            )}
            {item.fetchState === "pending" && <p className="fetch-state">{S.item.fetching}</p>}
            {item.fetchState === "failed" && (
              <p className="fetch-state">
                {S.item.unavailable}
                {viewerIsOwner && onRefresh && (
                  <button
                    type="button"
                    className="secondary retry-btn"
                    onClick={() => void onRefresh(item.id)}
                  >
                    {S.item.retryShort}
                  </button>
                )}
              </p>
            )}
          </div>
          <div className="price-row">
            {price ? (
              <span className="price">{price}</span>
            ) : (
              hintPrice && (
                <span className="hint-price">
                  ~{hintPrice} <span className="hint-note">({S.item.hintPriceNote})</span>
                </span>
              )
            )}
          </div>
        </div>
      </div>

      {viewerIsOwner ? (
        <div className="item-row-actions">
          {editingId === item.id ? (
            <ItemForm
              initial={item}
              submitLabel={S.form.save}
              onSubmit={(values) => handleEdit(item.id, values)}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <>
              {onEdit && (
                <button className="secondary" onClick={() => setEditingId(item.id)}>
                  {S.item.edit}
                </button>
              )}
              {onDelete && (
                <button className="danger" onClick={() => void handleDelete(item as OwnedItem)}>
                  {S.item.delete}
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="item-row-actions">
          {!publicItem.claimed && onClaim && (
            <button onClick={() => void onClaim(publicItem.id)}>{S.claims.claim}</button>
          )}
          {publicItem.claimed && !publicItem.claimedByYou && (
            <span className="muted">{S.claims.claimedBySomeone}</span>
          )}
          {publicItem.claimedByYou && (
            <span className="claimed-badge">
              {S.claims.claimedByYou}
              {onUnclaim && (
                <button className="secondary" onClick={() => void onUnclaim(publicItem.id)}>
                  {S.claims.unclaim}
                </button>
              )}
            </span>
          )}
        </div>
      )}
    </li>
  );
}