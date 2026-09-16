import { useState, type ReactNode } from "react";
import type { OwnedItem, PriceHintState, PricePoint, PriceStats, PriceTrend, PublicItem } from "../../shared/types";
import { centsToDecimal, formatPrice, toCents, urlHost } from "../format";
import { S } from "../strings";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";
import { ItemForm, type ItemFormValues } from "./ItemForm";
import { ItemLink } from "./ItemLink";
import { DotsIcon } from "./IconButton";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";
import { PriceCluster, TrendBlock, HintsBlock, type TrendWindow } from "./PriceCluster";
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
  /** Drag handle slot (pointer state machine wired by AppPage). */
  dragHandle?: ReactNode;
  /** True while this card is lifted by the drag state machine. */
  dragging?: boolean;
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
  onCheckPrices,
  onResetPurchased,
  hintState,
  dragHandle,
  dragging = false,
}: ItemCardProps) {
  const [editing, setEditing] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(false);
  const [trendWindow, setTrendWindow] = useState<TrendWindow>(readTrendWindow);
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

  /** Fetch on each open: the whole point is fresh evidence, and the route is
   *  display-only. */
  async function toggleHints() {
    const next = !hintsOpen;
    setHintsOpen(next);
    if (next && onCheckPrices) await onCheckPrices(item.id);
  }

  const ownerItem = item as OwnedItem;
  const price = formatPrice(item.priceCents, item.currency);
  const hintPrice = viewerIsOwner
    ? formatPrice(ownerItem.hintPriceCents, ownerItem.hintCurrency)
    : null;
  const stats = viewerIsOwner ? ownerItem.priceStats : null;
  const delta = priceDelta(item.priceCents, item.currency, stats);
  const publicItem = item as PublicItem;
  const showTrend =
    viewerIsOwner &&
    stats !== null &&
    stats.series.length >= 2 &&
    sameCurrencySeries(stats.series, item.currency);
  const trendValues = showTrend ? trendCents(stats.series, trendWindow) : [];

  function chooseWindow(next: TrendWindow) {
    setTrendWindow(next);
    try {
      localStorage.setItem(TREND_WINDOW_KEY, next);
    } catch {
      // Storage may be unavailable (private mode); the chip just won't persist.
    }
  }

  function ownerMenuItems(): OverflowItem[] {
    const menu: OverflowItem[] = [];
    if (onEdit) {
      menu.push({ id: "edit", label: S.item.edit, onSelect: () => setEditing(true) });
    }
    if (item.url && onRefresh) {
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
    if (stats.atAddCents !== null) {
      metaParts.push(S.item.atAddPrice(formatPrice(stats.atAddCents, stats.atAddCurrency)));
    }
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
        <button className="secondary" onClick={() => void onClaim(publicItem.id)}>
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
            <button className="secondary" onClick={() => void onUnclaim(publicItem.id)}>
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
        dragging={dragging}
        dragHandle={dragHandle}
        image={
          item.imagePath ? (
            <ProductImage src={`/api/wishlist/items/${item.id}/image`} />
          ) : undefined
        }
        actions={viewerIsOwner ? ownerActions : publicActions}
        meta={
          <>
            {item.siteName && <span className="item-site">{item.siteName}</span>}
            {/* Provenance note: this item's picture came from a search, not
                from the shop. Owner-only, like the price hint. */}
            {viewerIsOwner && item.imageSource === "search" && (
              <span className="item-image-source">{S.item.imageViaSearch}</span>
            )}
            <PriceCluster
              price={price}
              hintPrice={hintPrice}
              metaParts={metaParts}
              delta={delta}
            />
            {item.url && <ItemLink url={item.url} />}
            {/* The owner's own "found it cheaper at" note: a link they saved,
                carrying no automatic price claim. */}
            {viewerIsOwner && ownerItem.cheaperUrl && (
              <p className="item-cheaper">
                {S.item.cheaperFound}{" "}
                <a href={ownerItem.cheaperUrl} target="_blank" rel="noreferrer">
                  {urlHost(ownerItem.cheaperUrl)}
                </a>
              </p>
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
            {item.fetchState === "pending" && (
              <StatusBadge variant="fetching">{S.item.fetching}</StatusBadge>
            )}
            {item.fetchState === "failed" && (
              <span className="fetch-state">
                <StatusBadge variant="failed">{S.item.unavailable}</StatusBadge>
                {viewerIsOwner && onRefresh && (
                  <button
                    type="button"
                    className="secondary retry-btn"
                    onClick={() => void onRefresh(item.id)}
                  >
                    {S.item.retryShort}
                  </button>
                )}
              </span>
            )}
          </>
        }
        below={
          showTrend && stats ? (
            <>
              <TrendBlock
                window={trendWindow}
                onWindow={chooseWindow}
                values={trendValues}
                advice={stats.trend ? adviceLabel(stats.trend.advice) : null}
              />
              {viewerIsOwner && onCheckPrices && (
                <HintsBlock
                  itemId={item.id}
                  open={hintsOpen}
                  onToggle={() => void toggleHints()}
                  hintState={hintState}
                />
              )}
            </>
          ) : viewerIsOwner && onCheckPrices ? (
            <HintsBlock
              itemId={item.id}
              open={hintsOpen}
              onToggle={() => void toggleHints()}
              hintState={hintState}
            />
          ) : undefined
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

/** "Down £2.50 since added" / "Up £2.50 since added", or null when there is
 *  nothing honest to say: no history, no current price, no change, or a
 *  currency mismatch (mixed-currency deltas are not computed). Integer cents
 *  only — no float money arithmetic. */
function priceDelta(
  currentDecimal: string | null,
  currentCurrency: string | null,
  stats: PriceStats | null,
): string | null {
  if (!stats || stats.atAddCents === null || currentDecimal === null) return null;
  const current = toCents(currentDecimal);
  const atAdd = toCents(stats.atAddCents);
  if (current === null || atAdd === null || current === atAdd) return null;
  if ((currentCurrency ?? "").trim().toUpperCase() !== (stats.atAddCurrency ?? "").trim().toUpperCase()) {
    return null;
  }
  const amount = formatPrice(centsToDecimal(Math.abs(current - atAdd)), currentCurrency);
  return current < atAdd ? S.item.downSinceAdd(amount) : S.item.upSinceAdd(amount);
}

const TREND_WINDOW_KEY = "sugarplum.trend-window";

function readTrendWindow(): TrendWindow {
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
