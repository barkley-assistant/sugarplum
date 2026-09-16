import type { ReactNode } from "react";
import type { OwnedItem, PriceHintState, PublicItem } from "../../shared/types";
import { S } from "../strings";
import { ItemCard } from "./ItemCard";
import type { ItemFormValues } from "./ItemForm";

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
  /** Owner-only: runs the on-demand "prices seen elsewhere" lookup. */
  onCheckPrices?: (id: string) => void | Promise<void>;
  /** Owner-only: clears the blind share-link purchased mark (204, no body). */
  onResetPurchased?: (id: string) => void | Promise<void>;
  /** Owner-only: per-item candidates results, keyed by item id. */
  hintStates?: Record<string, PriceHintState>;
  /** Builds the drag handle for a card (own lists only). */
  renderDragHandle?: (itemId: string) => ReactNode;
  /** Id of the card currently lifted, for the .dragging style. */
  draggingId?: string | null;
}

/** Renders the ordered list of cards. Empty lists return null — the caller
 *  (AppPage) owns the empty-state copy, which differs per context. */
export function ItemList({
  items,
  viewerIsOwner,
  onEdit,
  onDelete,
  onClaim,
  onUnclaim,
  onRefresh,
  onCheckPrices,
  onResetPurchased,
  hintStates,
  renderDragHandle,
  draggingId = null,
}: ItemListProps) {
  if (items.length === 0) return null;

  return (
    <ul className="item-list">
      {items.map((item) => (
        <ItemCard
          key={item.id}
          item={item}
          viewerIsOwner={viewerIsOwner}
          onEdit={onEdit}
          onDelete={onDelete}
          onClaim={onClaim}
          onUnclaim={onUnclaim}
          onRefresh={onRefresh}
          onCheckPrices={onCheckPrices}
          onResetPurchased={onResetPurchased}
          hintState={hintStates?.[item.id]}
          dragHandle={renderDragHandle ? renderDragHandle(item.id) : undefined}
          dragging={draggingId === item.id}
        />
      ))}
    </ul>
  );
}

export function ListHeading({ owner, count }: { owner: OwnerRef; count: number }) {
  return (
    <div className="list-heading">
      <h2>{S.list.heading(owner.displayName)}</h2>
      <span className="count">{S.list.itemCount(count)}</span>
    </div>
  );
}