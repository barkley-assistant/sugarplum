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
  /** Owner-only pointer shortcut revealed on desktop row hover. */
  renderPeekGrip?: (id: string) => ReactNode;
  /** Id of the card currently lifted by the reorder state machine. */
  draggingId?: string | null;
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
  renderPeekGrip,
  draggingId,
}: ItemListProps) {
  if (items.length === 0) return null;

  return (
    <ul className="item-list">
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
          peekGrip={renderPeekGrip?.(item.id)}
          dragging={draggingId === item.id}
        />
      ))}
    </ul>
  );
}