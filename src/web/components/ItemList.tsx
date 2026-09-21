import type { ReactNode } from "react";
import type { OwnedItem, PublicItem } from "../../shared/types";
import { ItemCard } from "./ItemCard";

export interface OwnerRef {
  id: string;
  displayName: string;
}

interface ItemListProps {
  items: OwnedItem[] | PublicItem[];
  viewerIsOwner: boolean;
  onDelete?: (id: string) => void | Promise<void>;
  onClaim?: (id: string) => void | Promise<void>;
  onUnclaim?: (id: string) => void | Promise<void>;
  onRefresh?: (id: string) => void | Promise<void>;

  /** Owner-only: clears the blind share-link purchased mark (204, no body). */
  onResetPurchased?: (id: string) => void | Promise<void>;

  /** #76: the owner's own purchased mark (set is confirm-guarded in ItemCard). */
  onMarkOwnerPurchased?: (id: string) => void | Promise<void>;
  onUnmarkOwnerPurchased?: (id: string) => void | Promise<void>;

  /** Owner rows open the item page (#62); guest rows open the guest sheet. */
  onOpenDetails?: (id: string) => void;
  /** Owner-only reorder handle rendered in explicit reorder mode. */
  renderDragHandle?: (id: string) => ReactNode;
  /** Id of the card currently lifted by the reorder state machine. */
  draggingId?: string | null;
  /** Id of the card currently settling into its slot after a drop. */
  droppingId?: string | null;
}

/** Renders the ordered list of cards. Empty lists return null — the caller
 *  (AppPage) owns the empty-state copy, which differs per context. */
export function ItemList({
  items,
  viewerIsOwner,
  onDelete,
  onClaim,
  onUnclaim,
  onRefresh,
  onResetPurchased,
  onMarkOwnerPurchased,
  onUnmarkOwnerPurchased,
  onOpenDetails,
  renderDragHandle,
  draggingId,
  droppingId,
}: ItemListProps) {
  if (items.length === 0) return null;

  return (
    // #91: `.is-dragging` scopes the row transform transitions to a live drag
    // (styles.css) — that is what lets the drop handoff clear every inline
    // transform in the same frame the list re-renders, with nothing armed to
    // animate the layout move.
    <ul className={`item-list${draggingId ? " is-dragging" : ""}`}>
      {items.map((item) => (
        <ItemCard
          key={item.id}
          item={item}
          viewerIsOwner={viewerIsOwner}
          onDelete={onDelete}
          onClaim={onClaim}
          onUnclaim={onUnclaim}
          onRefresh={onRefresh}
          onResetPurchased={onResetPurchased}
          onMarkOwnerPurchased={onMarkOwnerPurchased}
          onUnmarkOwnerPurchased={onUnmarkOwnerPurchased}
          onOpenDetails={onOpenDetails}
          dragHandle={renderDragHandle?.(item.id)}
          dragging={draggingId === item.id}
          dropping={droppingId === item.id}
        />
      ))}
    </ul>
  );
}