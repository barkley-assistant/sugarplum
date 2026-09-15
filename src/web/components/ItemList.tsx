import { useState } from "react";
import type { OwnedItem, PublicItem } from "../../shared/types";
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

const SYMBOLS: Record<string, string> = {
  GBP: "£",
  USD: "$",
  EUR: "€",
};

export function formatPriceDisplay(priceCents: string | null, currency: string | null): string {
  if (priceCents === null) return "";
  const symbol = currency ? SYMBOLS[currency] : "";
  if (symbol) return `${symbol}${priceCents}`;
  return currency ? `${priceCents} ${currency}` : priceCents;
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
    if (onDelete && confirm(`Delete "${item.title}"? This cannot be undone.`)) {
      void onDelete(item.id);
    }
  }

  if (items.length === 0) {
    return <p className="muted empty-note">No items yet.</p>;
  }

  return (
    <ul className="item-list">
      {items.map((item) => {
        const price = formatPriceDisplay(item.priceCents, item.currency);
        const hintPrice = viewerIsOwner
          ? formatPriceDisplay(
              (item as OwnedItem).hintPriceCents,
              (item as OwnedItem).hintCurrency,
            )
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
                  <p className="fetch-state">Fetching details…</p>
                )}
                {item.fetchState === "failed" && (
                  <p className="fetch-state">
                    Details unavailable
                    {viewerIsOwner && onRefresh && (
                      <button
                        type="button"
                        className="secondary retry-btn"
                        onClick={() => void onRefresh(item.id)}
                      >
                        Retry
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
                    ~{hintPrice} <span className="hint-note">(unverified — via search)</span>
                  </span>
                )
              )}
            </div>

            {viewerIsOwner ? (
              <div className="item-row-actions">
                {editingId === item.id ? (
                  <ItemForm
                    initial={item}
                    submitLabel="Save"
                    onSubmit={(values) => handleEdit(item.id, values)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <>
                    {onEdit && (
                      <button className="secondary" onClick={() => setEditingId(item.id)}>
                        Edit
                      </button>
                    )}
                    {onDelete && (
                      <button className="danger" onClick={() => handleDelete(item as OwnedItem)}>
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="item-row-actions">
                {!publicItem.claimed && onClaim && (
                  <button onClick={() => void onClaim(publicItem.id)}>Claim</button>
                )}
                {publicItem.claimed && !publicItem.claimedByYou && (
                  <span className="muted">Claimed by someone</span>
                )}
                {publicItem.claimedByYou && (
                  <span className="claimed-badge">
                    Claimed by you
                    {onUnclaim && (
                      <button className="secondary" onClick={() => void onUnclaim(publicItem.id)}>
                        Unclaim
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
      <h2>{owner.displayName}'s wishlist</h2>
      <span className="muted">{count} item{count === 1 ? "" : "s"}</span>
    </div>
  );
}