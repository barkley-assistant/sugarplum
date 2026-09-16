import { useState, type ReactNode } from "react";
import type { OwnedItem, PriceHintState, PricePoint, PriceStats, PriceTrend, PublicItem } from "../../shared/types";
import { centsToDecimal, formatPrice, toCents, urlHost } from "../format";
import { S } from "../strings";
import { useConfirm } from "../confirm";
import { ItemForm, type ItemFormValues } from "./ItemForm";
import { ItemLink } from "./ItemLink";
import { Sparkline } from "./Sparkline";

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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [hintsOpen, setHintsOpen] = useState(false);
  const [trendWindow, setTrendWindow] = useState<TrendWindow>(readTrendWindow);
  const confirm = useConfirm();

  async function handleEdit(id: string, values: ItemFormValues) {
    if (onEdit) {
      await onEdit(id, values);
      setEditingId(null);
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
    : "";
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

  return (
    <li className={`card item-card${dragging ? " dragging" : ""}`} data-item-id={item.id}>
      <div className="item-card-row">
        {dragHandle}
        <div className="item-card-main">
          {item.imagePath && (
            <img
              className="item-thumb"
              src={`/api/wishlist/items/${item.id}/image`}
              alt=""
              loading="lazy"
            />
          )}
          <div className="item-card-text">
            <h3 className="item-title">{item.title}</h3>
            {item.siteName && <span className="item-site">{item.siteName}</span>}
            {/* Provenance note: this item's picture came from a search, not
                from the shop. Owner-only, like the price hint. */}
            {viewerIsOwner && item.imageSource === "search" && (
              <span className="item-image-source">{S.item.imageViaSearch}</span>
            )}
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
            {item.fetchState === "pending" && <p className="fetch-state">{S.item.fetching}</p>}
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
          <div className="price-row">
            {price ? (
              <span className="price">{price}</span>
            ) : (
              hintPrice && (
                <span className="hint-price">
                  ~{hintPrice} <span className="hint-note">({S.item.hintPriceNote})</span>
                </span>
              )
            )}
            {stats && (
              <span className="price-meta">
                {S.item.lowestSeen(formatPrice(stats.lowestCents, stats.lowestCurrency))}
                {stats.atAddCents !== null && (
                  <> · {S.item.atAddPrice(formatPrice(stats.atAddCents, stats.atAddCurrency))}</>
                )}
              </span>
            )}
            {delta && <span className="price-delta">{delta}</span>}
          </div>
        </div>
      </div>

      {showTrend && stats && (
        <div className="price-trend">
          <div className="window-chip" role="group" aria-label={S.trend.windowLabel}>
            <button
              type="button"
              aria-pressed={trendWindow === "30d"}
              className={trendWindow === "30d" ? "active" : ""}
              onClick={() => chooseWindow("30d")}
            >
              {S.trend.window30d}
            </button>
            <button
              type="button"
              aria-pressed={trendWindow === "90d"}
              className={trendWindow === "90d" ? "active" : ""}
              onClick={() => chooseWindow("90d")}
            >
              {S.trend.window90d}
            </button>
          </div>
          {trendValues.length >= 2 && (
            <div className="sparkline-wrap">
              <Sparkline values={trendValues} />
            </div>
          )}
          {stats.trend && <span className="advice-label">{adviceLabel(stats.trend.advice)}</span>}
        </div>
      )}

      {viewerIsOwner && onCheckPrices && (
        <div className="hint-block">
          <button
            type="button"
            className="secondary hints-toggle"
            aria-expanded={hintsOpen}
            aria-controls={`hints-${item.id}`}
            onClick={() => void toggleHints()}
          >
            {S.item.pricesElsewhere}
          </button>
          {hintsOpen && (
            <div className="hint-candidates" id={`hints-${item.id}`}>
              {(!hintState || hintState.status === "loading") && (
                <p className="muted">{S.item.checkingPrices}</p>
              )}
              {hintState?.status === "error" && <p className="muted">{S.errors.checkPrices}</p>}
              {hintState?.status === "done" && hintState.disabled && (
                <p className="muted">{S.item.hintsDisabled}</p>
              )}
              {hintState?.status === "done" && !hintState.disabled && hintState.hints.length === 0 && (
                <p className="muted">{S.item.hintsNone}</p>
              )}
              {hintState?.status === "done" && !hintState.disabled && hintState.hints.length > 0 && (
                <ul className="hint-list">
                  {hintState.hints.map((candidate) => (
                    <li key={candidate.sourceUrl}>
                      <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">
                        {formatPrice(candidate.priceCents, candidate.currency)} at{" "}
                        {urlHost(candidate.sourceUrl)}
                      </a>
                      <span className="hint-note"> — {S.item.hintCandidateNote}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="hint-footnote">{S.item.hintsFootnote}</p>
            </div>
          )}
        </div>
      )}

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
              {item.url && onRefresh && (
                <button className="secondary" onClick={() => void onRefresh(item.id)}>
                  {S.item.recheckPrice}
                </button>
              )}
              {onEdit && (
                <button className="secondary" onClick={() => setEditingId(item.id)}>
                  {S.item.edit}
                </button>
              )}
              {onResetPurchased && (
                <button className="secondary" onClick={() => void handleResetPurchased()}>
                  {S.share.resetPurchased}
                </button>
              )}
              {onDelete && (
                <button className="danger" onClick={() => void handleDelete(item as OwnedItem)}>
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

/** Sparkline window chip state. Display-only (it never changes what the
 *  server tracks), so localStorage is the right home — no server round-trip. */
export type TrendWindow = "30d" | "90d";

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
