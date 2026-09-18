import { useState } from "react";
import type { OwnedItem, PriceStats, PublicItem } from "../../shared/types";
import { centsToDecimal, formatPrice, toCents } from "../format";
import { S } from "../strings";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";
import { ItemForm, type ItemFormValues } from "./ItemForm";
import { DotsIcon } from "./IconButton";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";
import { PriceCluster } from "./PriceCluster";
import { ProductImage } from "./ProductImage";
import { ProductRow } from "./ProductRow";
import { Sheet } from "./Sheet";
import { StatusBadge } from "./StatusBadge";

interface ItemCardProps {
  item: OwnedItem | PublicItem;
  viewerIsOwner: boolean;
  onEdit?: (id: string, values: ItemFormValues) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
  onClaim?: (id: string) => void | Promise<void>;
  onUnclaim?: (id: string) => void | Promise<void>;
  onRefresh?: (id: string) => void | Promise<void>;

  /** Owner-only: clear the blind share-link purchased mark (204, no body). */
  onResetPurchased?: (id: string) => void | Promise<void>;

  /** Owner-row opener; A4 will render the detail surface behind this seam. */
  onOpenDetails?: (id: string) => void;
}

/** Owner + public row, composed from the shared primitives. The price helper
 *  stays here; the layout is ProductRow, the price surface PriceCluster, the actions one
 *  OverflowMenu trigger (owner) or the inline claim control (public). */
export function ItemCard({
  item,
  viewerIsOwner,
  onEdit,
  onDelete,
  onClaim,
  onUnclaim,
  onRefresh,
  onResetPurchased,
  onOpenDetails,
}: ItemCardProps) {
  const [editing, setEditing] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();

  async function handleEdit(id: string, values: ItemFormValues) {
    if (onEdit) {
      await onEdit(id, values);
      setEditing(false);
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
  const stats = viewerIsOwner ? ownerItem.priceStats : null;
  const delta = priceDelta(item.priceCents, item.currency, stats);
  const publicItem = item as PublicItem;
  function ownerMenuItems(): OverflowItem[] {
    const menu: OverflowItem[] = [];
    if (onEdit) {
      menu.push({ id: "edit", label: S.item.edit, onSelect: () => setEditing(true) });
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

  const metaParts: string[] = [];
  if (stats) {
    metaParts.push(S.item.lowestSeen(formatPrice(stats.lowestCents, stats.lowestCurrency)));
  }

  const ownerActions =
    viewerIsOwner && ownerMenuItems().length > 0 ? (
      <OverflowMenu
        triggerLabel={S.item.moreActions}
        triggerIcon={<DotsIcon />}
        menuLabel={S.item.moreActions}
        items={ownerMenuItems()}
      />
    ) : undefined;

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
    <>
      <ProductRow
        id={item.id}
        title={item.title}
        fetchState={viewerIsOwner ? item.fetchState : undefined}
        onOpen={viewerIsOwner && onOpenDetails ? () => onOpenDetails(item.id) : undefined}
        openLabel={S.item.openDetails}
        image={
          item.imagePath ? (
            <ProductImage src={`/api/wishlist/items/${item.id}/image`} />
          ) : viewerIsOwner && item.fetchState === "pending" ? (
            <span className="product-img-fallback" aria-hidden="true" />
          ) : undefined
        }
        actions={viewerIsOwner ? ownerActions : publicActions}
        body={
          <>
            {item.siteName && <span className="item-site">{item.siteName}</span>}
            {item.fetchState === "pending" && (
              <StatusBadge variant="fetching">{S.item.fetching}</StatusBadge>
            )}
            {item.fetchState === "failed" && (
              <StatusBadge variant="failed">{S.item.unavailable}</StatusBadge>
            )}
          </>
        }
        price={<PriceCluster price={price} hintPrice={hintPrice} metaParts={metaParts} />}
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
      {viewerIsOwner && onEdit && (
        <Sheet open={editing} onClose={() => setEditing(false)} ariaLabel={S.item.edit}>
          <h2>{S.item.edit}</h2>
          <ItemForm
            initial={item}
            submitLabel={S.form.save}
            onSubmit={(values) => handleEdit(item.id, values)}
            onCancel={() => setEditing(false)}
          />
        </Sheet>
      )}
    </>
  );
}

/** The direction and amount since added, or null when there is
 *  nothing honest to say: no history, no current price, no change, or a
 *  currency mismatch (mixed-currency deltas are not computed). Integer cents
 *  only — no float money arithmetic. */
export function priceDelta(
  currentDecimal: string | null,
  currentCurrency: string | null,
  stats: PriceStats | null,
): { direction: "down" | "up"; amount: string } | null {
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
