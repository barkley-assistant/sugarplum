import { useState } from "react";
import type { OwnedItem, PublicItem } from "../../shared/types";
import { formatPrice } from "../format";
import { S } from "../strings";
import { ItemForm, type ItemFormValues } from "./ItemForm";

export interface OwnerRef {
  id: string;
  displayName: string;
}

interface ItemListProps {
  items: OwnedItem[] | PublicItem[];
  viewerIsOwner: boolean;
  onEdit?: (id: string, values: ItemFormValues) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
  onClaim?: (id: string) => void | Promise<void>;
  onUnclaim?: (id: string) => void | Promise<void>;
  onRefresh?: (id: string) => void | Promise<void>;
}

export function ItemList({
  items,
  viewerIsOwner,
  onEdit,
  onDelete,
  onClaim,
  onUnclaim,
  onRefresh,
}: ItemListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);

  async function handleEdit(id: string, values: ItemFormValues) {
    if (onEdit) {
      await onEdit(id, values);
      setEditingId(null);
    }
  }

  function handleDelete(item: OwnedItem) {
    if (onDelete && confirm(S.confirm.deleteItem(item.title))) {
      void onDelete(item.id);
    }
  }

  if (items.length === 0) {
    return <p className="muted empty-note">{S.empty.own}</p>;
  }

  return (
    <ul className="item-list">
      {items.map((item) => {
        const price = formatPrice(item.priceCents, item.currency);
        const hintPrice = viewerIsOwner
          ? formatPrice((item as OwnedItem).hintPriceCents, (item as OwnedItem).hintCurrency)
          : "";
        const publicItem = item as PublicItem;
        return (
          <li key={item.id} className="card item-row">
            <div className="item-row-main">
              {item.imagePath && (
                <img
                  className="item-thumb"
                  src={`/api/wishlist/items/${item.id}/image`}
                  alt=""
                  loading="lazy"
                />
              )}
              <div className="item-row-text">
                <h3>{item.title}</h3>
                {item.url && (
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.url}
                  </a>
                )}
                {item.notes && <p className="muted">{item.notes}</p>}
                {item.tags.length > 0 && (
                  <p className="tags">{item.tags.map((t) => `#${t}`).join(" ")}</p>
                )}
                {item.fetchState === "pending" && (
                  <p className="fetch-state">{S.item.fetching}</p>
                )}
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
                      <button className="danger" onClick={() => handleDelete(item as OwnedItem)}>
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
      })}
    </ul>
  );
}

export function ListHeading({ owner, count }: { owner: OwnerRef; count: number }) {
  return (
    <div className="list-heading">
      <h2>{S.list.heading(owner.displayName)}</h2>
      <span className="muted">{S.list.itemCount(count)}</span>
    </div>
  );
}