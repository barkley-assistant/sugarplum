import type { OwnedItem, PublicItem } from "../../shared/types";
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

  /** Owner-only: clears the blind share-link purchased mark (204, no body). */
  onResetPurchased?: (id: string) => void | Promise<void>;

  /** Opens the detail surface for an owner row (A4 fills the surface). */
  onOpenDetails?: (id: string) => void;
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
  onResetPurchased,
  onOpenDetails,
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
          onResetPurchased={onResetPurchased}
          onOpenDetails={onOpenDetails}
        />
      ))}
    </ul>
  );
}