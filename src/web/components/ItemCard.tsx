import type { ReactNode } from "react";
import type { OwnedItem, PriceStats, PublicItem } from "../../shared/types";
import { centsToDecimal, formatPrice, toCents } from "../format";
import { navigate } from "../router";
import { S } from "../strings";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";
import { DotsIcon } from "./IconButton";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";
import { PriceCluster } from "./PriceCluster";
import { ProductImage } from "./ProductImage";
import { ProductRow } from "./ProductRow";
import { StatusBadge } from "./StatusBadge";

interface ItemCardProps {
  item: OwnedItem | PublicItem;
  viewerIsOwner: boolean;
  onDelete?: (id: string) => void | Promise<void>;
  onClaim?: (id: string) => void | Promise<void>;
  onUnclaim?: (id: string) => void | Promise<void>;
  onRefresh?: (id: string) => void | Promise<void>;

  /** Owner-only: clear the blind share-link purchased mark (204, no body). */
  onResetPurchased?: (id: string) => void | Promise<void>;

  /** #76: set the owner's own purchased mark (confirm lives here). */
  onMarkOwnerPurchased?: (id: string) => void | Promise<void>;
  /** #76: clear the owner's own purchased mark (no confirm). */
  onUnmarkOwnerPurchased?: (id: string) => void | Promise<void>;

  /** Owner rows: opens the item page at /items/:id (#62). */
  onOpenDetails?: (id: string) => void;
  /** Drag handle slot, rendered only in explicit reorder mode. */
  dragHandle?: ReactNode;
  /** True while this card is lifted by the reorder state machine. */
  dragging?: boolean;
  /** True while this card is settling into its final slot after a drop. */
  dropping?: boolean;
}

/** Owner + public row, composed from the shared primitives. The price helper
 *  stays here; the layout is ProductRow, the price surface PriceCluster, the
 *  actions one OverflowMenu trigger (owner) or the inline claim control
 *  (public). Editing is a route (#62), not a stacked sheet. */
export function ItemCard({
  item,
  viewerIsOwner,
  onDelete,
  onClaim,
  onUnclaim,
  onRefresh,
  onResetPurchased,
  onMarkOwnerPurchased,
  onUnmarkOwnerPurchased,
  onOpenDetails,
  dragHandle,
  dragging,
  dropping,
}: ItemCardProps) {
  const confirm = useConfirm();
  const toast = useToast();

  async function handleDelete(item: OwnedItem) {
    if (!onDelete) return;
    const ok = await confirm({
      title: S.confirm.deleteItem(item.title),
      body: S.confirm.deleteItemBody,
    });
    if (ok) await onDelete(item.id);
  }

  /** Blind reset: the owner clears a mark they cannot see. The copy says so
   *  explicitly ("without telling you who set it"). */
  async function handleResetPurchased() {
    if (!onResetPurchased) return;
    const ok = await confirm({
      title: S.share.resetConfirmTitle,
      body: S.share.resetConfirmBody,
      confirmLabel: S.share.resetPurchased,
      danger: false,
    });
    if (ok) await onResetPurchased(item.id);
  }

  /** #76: the owner's own mark — confirm-guarded like the share flow. */
  async function handleMarkOwnerPurchased() {
    if (!onMarkOwnerPurchased) return;
    const ok = await confirm({
      title: S.owner.markTitle,
      body: S.owner.markBody,
      confirmLabel: S.owner.mark,
      danger: false,
    });
    if (ok) await onMarkOwnerPurchased(item.id);
  }

  async function copyProductLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast(S.item.copied);
    } catch {
      toast(S.errors.generic, "danger");
    }
  }


  const ownerItem = item as OwnedItem;
  const price = formatPrice(item.priceCents, item.currency);
  const hintPrice = viewerIsOwner
    ? formatPrice(ownerItem.hintPriceCents, ownerItem.hintCurrency)
    : null;
  // #130: both projections carry the ledger summary now, so owner and guest
  // rows run ONE Lowest rule instead of two.
  const stats = item.priceStats;
  const delta = priceDelta(item.priceCents, item.currency, stats);
  const lowest = lowestState(item.priceCents, item.currency, stats);
  const publicItem = item as PublicItem;
  function ownerMenuItems(): OverflowItem[] {
    const menu: OverflowItem[] = [];
    if (viewerIsOwner) {
      // #62: editing is the /items/:id/edit route, not a stacked sheet.
      menu.push({
        id: "edit",
        label: S.item.edit,
        onSelect: () => navigate(`/items/${item.id}/edit`),
      });
    }
    if (item.fetchState === "failed" && onRefresh) {
      menu.push({
        id: "retry",
        label: S.item.retry,
        onSelect: () => onRefresh(item.id),
      });
    } else if (item.url && onRefresh && item.fetchState !== "pending") {
      menu.push({
        id: "recheck",
        label: S.item.recheckPrice,
        onSelect: () => onRefresh(item.id),
      });
    }
    if (item.url) {
      menu.push({
        id: "copy-link",
        label: S.item.copyProductLink,
        onSelect: () => copyProductLink(item.url as string),
      });
    }
    if (onMarkOwnerPurchased && ownerItem.ownerPurchased === true) {
      menu.push({
        id: "unmark-owner-purchased",
        label: S.owner.unmark,
        onSelect: () => onUnmarkOwnerPurchased?.(item.id),
      });
    } else if (onMarkOwnerPurchased) {
      menu.push({
        id: "mark-owner-purchased",
        label: S.owner.mark,
        onSelect: handleMarkOwnerPurchased,
      });
    }
    if (onResetPurchased) {
      menu.push({
        id: "reset-purchased",
        label: S.share.resetPurchased,
        onSelect: handleResetPurchased,
      });
    }
    if (onDelete) {
      menu.push({
        id: "delete",
        label: S.item.delete,
        danger: true,
        onSelect: () => handleDelete(item as OwnedItem),
      });
    }
    return menu;
  }

  // #130: the meta line only exists when the current price sits ABOVE the
  // lowest — at the lowest it becomes the quiet chip (PriceCluster's
  // atLowest), and with no history there is no line at all.
  const metaParts: string[] = lowest?.kind === "below" ? [S.item.lowestSeen(lowest.lowest)] : [];

  const ownerActions =
    viewerIsOwner && ownerMenuItems().length > 0 ? (
      <OverflowMenu
        triggerLabel={S.item.moreActions}
        triggerIcon={<DotsIcon />}
        menuLabel={S.item.moreActions}
        items={ownerMenuItems()}
      />
    ) : undefined;

  const ownerRowActions = dragHandle ? undefined : ownerActions;

  const publicActions = !viewerIsOwner ? (
    <>
      {!publicItem.claimed && onClaim && (
        <button className="claim-btn" onClick={() => void onClaim(publicItem.id)}>
          {S.claims.claim}
        </button>
      )}
      {publicItem.claimed && !publicItem.claimedByYou && (
        <StatusBadge variant="claimed">{S.claims.claimedBySomeone}</StatusBadge>
      )}
      {publicItem.claimedByYou && (
        <span className="claimed-badge">
          <StatusBadge variant="claimed">{S.claims.claimedByYou}</StatusBadge>
          {onUnclaim && (
            <button className="claim-btn" onClick={() => void onUnclaim(publicItem.id)}>
              {S.claims.unclaim}
            </button>
          )}
        </span>
      )}
    </>
  ) : undefined;

  return (
    <ProductRow
      id={item.id}
      title={item.title}
      fetchState={viewerIsOwner ? item.fetchState : undefined}
      onOpen={onOpenDetails ? () => onOpenDetails(item.id) : undefined}
      reorderHandle={dragHandle}
      dragging={dragging}
      dropping={dropping}
      purchased={viewerIsOwner && ownerItem.ownerPurchased === true}
      image={
        item.imagePath ? (
          <ProductImage src={`/api/wishlist/items/${item.id}/image`} />
        ) : (
          // #119: every row reserves the thumb frame, so a no-image row's
          // title/price column lines up with its imaged neighbours. Pending
          // rows pulse through [data-fetch="pending"] on the <li> (see
          // styles.css) — this is the same well the detail heroes use.
          <span className="product-img-fallback" aria-hidden="true" />
        )
      }
      actions={viewerIsOwner ? ownerRowActions : publicActions}
      body={
        <>
          {item.siteName && <span className="item-site">{item.siteName}</span>}
          {item.fetchState === "pending" && (
            <StatusBadge variant="fetching">{S.item.fetching}</StatusBadge>
          )}
          {item.fetchState === "failed" && (
            <StatusBadge variant="failed">{S.item.unavailable}</StatusBadge>
          )}
          {viewerIsOwner && ownerItem.ownerPurchased === true && (
            <span className="status status--purchased owner-purchased-badge">
              {S.owner.badge}
            </span>
          )}
        </>
      }
      price={
        <PriceCluster
          price={price}
          hintPrice={hintPrice}
          metaParts={metaParts}
          atLowest={lowest?.kind === "equal"}
        />
      }
      delta={
        delta && (
          <span className="price-delta" data-direction={delta.direction}>
            <span className="delta-arrow" aria-hidden="true">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path
                  d={delta.direction === "down" ? "M5 1.5v7M1.5 5 5 8.5 8.5 5" : "M5 8.5v-7M1.5 5 5 1.5 8.5 5"}
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="visually-hidden">
              {delta.direction === "down" ? "Down " : "Up "}
            </span>
            <span className="delta-copy">
              {S.item.deltaSinceAdd(delta.amount)}
            </span>
          </span>
        )
      }
    />
  );
}

/** Direction + amount of the move since the item was added. Integer cents
 *  only — no float money arithmetic. */
export interface PriceDelta {
  direction: "down" | "up";
  amount: string;
}

/** The direction and amount since added, or null when there is
 *  nothing honest to say: no history, no current price, no change, or a
 *  currency mismatch (mixed-currency deltas are not computed). Integer cents
 *  only — no float money arithmetic. */
export function priceDelta(
  currentDecimal: string | null,
  currentCurrency: string | null,
  stats: PriceStats | null,
): PriceDelta | null {
  if (!stats || stats.atAddCents === null || currentDecimal === null) return null;
  const current = toCents(currentDecimal);
  const atAdd = toCents(stats.atAddCents);
  if (current === null || atAdd === null || current === atAdd) return null;
  if ((currentCurrency ?? "").trim().toUpperCase() !== (stats.atAddCurrency ?? "").trim().toUpperCase()) {
    return null;
  }
  const amount = formatPrice(centsToDecimal(Math.abs(current - atAdd)), currentCurrency);
  return { direction: current < atAdd ? "down" : "up", amount };
}

/** #130: how the current price sits against the ledger's lowest.
 *  "equal" collapses the meta line into the quiet "At lowest" chip;
 *  "below" means a real lowest exists BELOW the current price (the ledger's
 *  minimum can never exceed it) and keeps the "Lowest £X" line.
 *  Null when there is nothing honest to compare: no current price, no
 *  history, or a currency mismatch — mixed-currency money is never compared
 *  (the same rule as priceDelta). Integer cents only. */
export type LowestState = { kind: "equal" } | { kind: "below"; lowest: string };

export function lowestState(
  currentDecimal: string | null,
  currentCurrency: string | null,
  stats: PriceStats | null,
): LowestState | null {
  if (!stats || currentDecimal === null) return null;
  if (
    (currentCurrency ?? "").trim().toUpperCase() !==
    (stats.lowestCurrency ?? "").trim().toUpperCase()
  ) {
    return null;
  }
  const current = toCents(currentDecimal);
  const lowest = toCents(stats.lowestCents);
  if (current === null || lowest === null) return null;
  if (current === lowest) return { kind: "equal" };
  return { kind: "below", lowest: formatPrice(stats.lowestCents, stats.lowestCurrency) };
}
