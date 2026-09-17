import { useState } from "react";
import type { OwnedItem, PriceHintState, PricePoint, PriceStats, PriceTrend, PublicItem } from "../../shared/types";
import { centsToDecimal, formatPrice, toCents } from "../format";
import { S } from "../strings";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";
import { ItemForm, type ItemFormValues } from "./ItemForm";
import { DotsIcon } from "./IconButton";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";
import { PriceCluster, type TrendWindow } from "./PriceCluster";
import { ProductImage } from "./ProductImage";
import { ProductRow } from "./ProductRow";
import { Sheet } from "./Sheet";
import { StatusBadge } from "./StatusBadge";

export type { TrendWindow };

interface ItemCardProps {
  item: OwnedItem | PublicItem;
  viewerIsOwner: boolean;
  onEdit?: (id: string, values: ItemFormValues) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
  onClaim?: (id: string) => void | Promise<void>;
  onUnclaim?: (id: string) => void | Promise<void>;
  onRefresh?: (id: string) => void | Promise<void>;
  /** Owner-only: run the on-demand "prices seen elsewhere" lookup. */
  onCheckPrices?: (id: string) => void | Promise<void>;
  /** Owner-only: clear the blind share-link purchased mark (204, no body). */
  onResetPurchased?: (id: string) => void | Promise<void>;
  /** Owner-only: the last candidates result for this item, when a lookup ran. */
  hintState?: PriceHintState;
  /** Owner-row opener; A4 will render the detail surface behind this seam. */
  onOpenDetails?: (id: string) => void;
}

/** Owner + public row, composed from the shared primitives. The props and
 *  the price helpers stay here (unit-tested via sparkline.test.ts); the
 *  layout is ProductRow, the price surface PriceCluster, the actions one
 *  OverflowMenu trigger (owner) or the inline claim control (public). */
export function ItemCard({
  item,
  viewerIsOwner,
  onEdit,
  onDelete,
  onClaim,
  onUnclaim,
  onRefresh,
  onCheckPrices: _onCheckPrices,
  onResetPurchased,
  hintState: _hintState,
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
        onOpen={viewerIsOwner && onOpenDetails ? () => onOpenDetails(item.id) : undefined}
        openLabel={S.item.openDetails}
        image={
          item.imagePath ? (
            <ProductImage src={`/api/wishlist/items/${item.id}/image`} />
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
function priceDelta(
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

const TREND_WINDOW_KEY = "sugarplum.trend-window";

export function readTrendWindow(): TrendWindow {
  try {
    return localStorage.getItem(TREND_WINDOW_KEY) === "90d" ? "90d" : "30d";
  } catch {
    return "30d";
  }
}

/** Advice enum → user-facing label. Every label is informational; none tells
 *  the user to buy now. Exported for tests. */
export function adviceLabel(advice: PriceTrend["advice"]): string {
  switch (advice) {
    case "below-30d-avg":
      return S.trend.below30dAvg;
    case "near-30d-low":
      return S.trend.near30dLow;
    case "near-30d-high":
      return S.trend.near30dHigh;
    case "trending-down":
      return S.trend.trendingDown;
    case "stable":
      return S.trend.stable;
    case "insufficient":
      return S.trend.insufficient;
  }
}

/** True when every series point shares the item's currency (null reads as
 *  "same"). A mixed-currency series is not a comparable series and is never
 *  drawn — same rule as priceDelta. Exported for tests. */
export function sameCurrencySeries(series: PricePoint[], currency: string | null): boolean {
  const code = (currency ?? "").trim().toUpperCase();
  return series.every((p) => (p.currency ?? "").trim().toUpperCase() === code);
}

/** Series → drawable integer cents for the selected window. The server
 *  always sends the 90-day series; the 30d chip slices it client-side.
 *  Empty when a point is unparseable (the sparkline then stays hidden —
 *  never draw a partial series). Exported for tests. */
export function trendCents(series: PricePoint[], window: TrendWindow): number[] {
  const inWindow =
    window === "90d"
      ? series
      : series.filter((p) => {
          const t = new Date(p.observedAt).getTime();
          return Number.isFinite(t) && t >= Date.now() - 30 * 86_400_000;
        });
  const cents = inWindow.map((p) => toCents(p.priceCents));
  return cents.every((c): c is number => c !== null) ? cents : [];
}
