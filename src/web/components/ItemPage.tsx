import { useEffect, useState, type ReactNode } from "react";
import type { OwnedItem, PriceHintState, PriceHintsResponse } from "../../shared/types";
import { formatDate, formatPrice, urlHost } from "../format";
import { navigate } from "../router";
import { S } from "../strings";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";
import { useBootMe } from "../use-boot-me";
import { usePageFocus } from "../use-page-focus";
import { pruneFeedSnapshotItem } from "../feed-handoff";
import { AppShell } from "./AppShell";
import { DetailMeta } from "./DetailMeta";
import { EmptyState } from "./EmptyState";
import { HintsPanel } from "./HintsPanel";
import { DotsIcon } from "./IconButton";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";
import { ProductImage } from "./ProductImage";
import { PriceHistoryCard } from "./PriceHistoryCard";
import { ItemSkeleton } from "./Skeletons";
import { StatusBadge } from "./StatusBadge";
import { priceDelta } from "./ItemCard";

/** The owner's item detail as a page (#62): the body the detail sheet used to
 *  carry (hero, actions, price history, notes, tags, more information,
 *  footer) in the app column, at one layout for every width. Only the owner
 *  projection (OwnedItem) is ever read here. */
export function ItemPage({ id }: { id: string }) {
  const boot = useBootMe();
  const me = boot.status === "ready" || boot.status === "offline" ? boot.me : null;
  const [item, setItem] = useState<OwnedItem | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(false);
  const [hintState, setHintState] = useState<PriceHintState | undefined>();
  const headingRef = usePageFocus(item?.id);
  const confirm = useConfirm();
  const toast = useToast();

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    void (async () => {
      // No single-item endpoint: the owner list GET (#61's feed read) carries
      // the full OwnedItem projection and is SW stale-while-revalidate cached,
      // so a deep-link boot renders from cache and then revalidates.
      const res = await fetch(`/api/users/${me.id}/wishlist`);
      if (cancelled) return;
      if (!res.ok) {
        setNotFound(true);
        return;
      }
      const items = (await res.json()) as OwnedItem[];
      const found = items.find((candidate) => candidate.id === id) ?? null;
      if (cancelled) return;
      if (found) setItem(found);
      else setNotFound(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [me, id]);

  // History-entry polish: the item's own title, reset per route by Root().
  useEffect(() => {
    if (item) document.title = `${item.title} · sugarplum`;
  }, [item]);

  /** Re-reads the item from the owner list; returns it so callers can branch
   *  on fresh data instead of stale render state. */
  async function reload(): Promise<OwnedItem | null> {
    if (!me) return null;
    const res = await fetch(`/api/users/${me.id}/wishlist`);
    if (!res.ok) return null;
    const items = (await res.json()) as OwnedItem[];
    const found = items.find((candidate) => candidate.id === id) ?? null;
    if (found) setItem(found);
    return found;
  }

  /** Poll while the item is still enriching, so a moved price renders
   *  without a manual reload. Module-level helper: it is plainly not part of
   *  the render path. */
  const pollEnrichment = () => pollUntilSettled(reload);

  async function refreshItem() {
    const res = await fetch(`/api/wishlist/items/${id}/refresh`, { method: "POST" });
    if (!res.ok) {
      toast(S.errors.retryItem, "danger");
      return;
    }
    // The 202 means "queued".
    await reload();
    void pollEnrichment();
  }

  /** Blind purchased reset (owner-only route, 204 with no body): the owner
   *  never learns whether a mark existed, when, or who set it. */
  async function resetPurchased() {
    const res = await fetch(`/api/wishlist/items/${id}/purchased`, { method: "DELETE" });
    if (res.status !== 204) {
      toast(S.errors.generic, "danger");
      return;
    }
    await reload();
  }

  /** #76: the owner's own mark. Confirm-guarded on the way IN (mirrors the
   *  share flow); unmark needs no confirm (non-destructive, reversible). */
  async function markOwnerPurchased() {
    const ok = await confirm({
      title: S.owner.markTitle,
      body: S.owner.markBody,
      confirmLabel: S.owner.mark,
      danger: false,
    });
    if (!ok) return;
    const res = await fetch(`/api/wishlist/items/${id}/owner-purchased`, { method: "PUT" });
    if (!res.ok) {
      toast(S.errors.generic, "danger");
      return;
    }
    setItem((await res.json()) as OwnedItem);
  }

  async function unmarkOwnerPurchased() {
    const res = await fetch(`/api/wishlist/items/${id}/owner-purchased`, { method: "DELETE" });
    if (res.status !== 204) {
      toast(S.errors.generic, "danger");
      return;
    }
    await reload();
  }

  /** On-demand, display-only candidate hints (owner-only route). Nothing here
   *  is persisted or verified. */
  async function checkPrices() {
    setHintState({ status: "loading", hints: [], disabled: false });
    let res: Response;
    try {
      res = await fetch(`/api/wishlist/items/${id}/hints`, { method: "POST" });
    } catch {
      setHintState({ status: "error", hints: [], disabled: false });
      toast(S.errors.checkPrices, "danger");
      return;
    }
    if (!res.ok) {
      setHintState({ status: "error", hints: [], disabled: false });
      toast(S.errors.checkPrices, "danger");
      return;
    }
    const body = (await res.json()) as PriceHintsResponse;
    setHintState({ status: "done", hints: body.hints, disabled: body.disabled });
  }

  async function deleteItem() {
    const ok = await confirm({
      title: S.confirm.deleteItem(item?.title ?? ""),
      body: S.confirm.deleteItemBody,
    });
    if (!ok) return;
    const res = await fetch(`/api/wishlist/items/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast(S.errors.deleteItem, "danger");
      return;
    }
    // The item no longer exists: staying on /items/:id would render the
    // not-found state. Prune the handoff snapshot first so the feed cannot
    // resurrect the deleted row on the way back.
    pruneFeedSnapshotItem(id);
    navigate("/");
  }

  async function copyProductLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast(S.item.copied);
    } catch {
      toast(S.errors.generic, "danger");
    }
  }

  function secondaryMenuItems(): OverflowItem[] {
    const items: OverflowItem[] = [];
    if (!item) return items;
    if (item.fetchState === "failed") {
      items.push({ id: "retry", label: S.item.retry, onSelect: refreshItem });
    } else if (item.url && item.fetchState !== "pending") {
      items.push({ id: "recheck", label: S.item.recheckPrice, onSelect: refreshItem });
    }
    if (item.url) {
      items.push({
        id: "copy-link",
        label: S.item.copyProductLink,
        onSelect: () => copyProductLink(item.url as string),
      });
    }
    if (item.ownerPurchased === true) {
      items.push({ id: "unmark-owner-purchased", label: S.owner.unmark, section: true, onSelect: unmarkOwnerPurchased });
    } else {
      items.push({ id: "mark-owner-purchased", label: S.owner.mark, section: true, onSelect: markOwnerPurchased });
    }
    items.push({ id: "reset-purchased", label: S.share.resetPurchased, onSelect: resetPurchased });
    items.push({ id: "delete", label: S.item.delete, danger: true, onSelect: deleteItem });
    return items;
  }

  function toggleHints() {
    const nextOpen = !hintsOpen;
    setHintsOpen(nextOpen);
    if (nextOpen) void checkPrices();
  }

  if (boot.status === "loading") return <ItemSkeleton />;
  if (boot.status === "error") {
    return (
      <AppShell brandHref="/" brandLinkLabel={S.settings.backToList}>
        <p className="error" role="alert">{boot.message}</p>
      </AppShell>
    );
  }
  if (notFound) {
    return (
      <AppShell brandHref="/" brandLinkLabel={S.settings.backToList}>
        <EmptyState title={S.item.notFound} />
      </AppShell>
    );
  }
  if (!item) return <ItemSkeleton />;

  const stats = item.priceStats;
  const delta = priceDelta(item.priceCents, item.currency, stats);
  const site = item.siteName ?? (item.url ? urlHost(item.url) : null);
  const price = formatPrice(item.priceCents, item.currency);
  const hintPrice = formatPrice(item.hintPriceCents, item.hintCurrency);
  const meta = stats ? S.item.lowestSeen(formatPrice(stats.lowestCents, stats.lowestCurrency)) : null;
  const footerHost = item.url ? urlHost(item.url) : null;
  const editHref = `/items/${item.id}/edit`;

  return (
    <AppShell brandHref="/" brandLinkLabel={S.settings.backToList}>
      <div className="item-page" data-item-id={item.id}>
        <div className="detail-header">
          {/* #72: the close icon is gone — a page is dismissed by the
              browser's own back button (the feed when opened from it, the
              previous site on a cold deep link), same as any web page. */}
          <OverflowMenu
            triggerLabel={S.item.moreActions}
            triggerIcon={<DotsIcon />}
            triggerClassName="icon-btn detail-menu-trigger"
            menuLabel={S.item.moreActions}
            items={secondaryMenuItems()}
          />
        </div>

        <div className="detail-scroll">
          <div className="detail-hero">
            {item.imagePath ? (
              <ProductImage src={`/api/wishlist/items/${item.id}/image`} />
            ) : (
              <span className="product-img-fallback" aria-hidden="true" />
            )}
            <div className="detail-hero-info">
              <h2 ref={headingRef} tabIndex={-1} className="detail-title">{item.title}</h2>
              {site && <span className="detail-site">{site}</span>}
              {item.fetchState === "pending" && <StatusBadge variant="fetching">{S.item.fetching}</StatusBadge>}
              {item.fetchState === "failed" && <StatusBadge variant="failed">{S.item.unavailable}</StatusBadge>}
              {item.ownerPurchased === true && (
                <span className="status status--purchased owner-purchased-badge">
                  {S.owner.badge}
                </span>
              )}
              {price ? (
                <span className="detail-price">{price}</span>
              ) : (
                hintPrice && <span className="detail-price detail-price--hint">~{hintPrice}</span>
              )}
              {(meta || delta) && <DetailMeta meta={meta} delta={delta} />}
            </div>
          </div>

          <div className={`detail-actions${item.url ? "" : " detail-actions--single"}`}>
            {item.url && (
              <a
                className="detail-open-btn"
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                <ExternalLinkIcon />
                {S.detail.openProduct}
              </a>
            )}
            <button
              type="button"
              className="secondary detail-edit-btn"
              onClick={() => navigate(editHref)}
            >
              <PencilIcon />
              {S.detail.editItem}
            </button>
          </div>

          {item.priceStats && <PriceHistoryCard stats={item.priceStats} currency={item.currency} />}

          {item.notes?.trim() && (
            <section className="detail-card detail-notes-card">
              <div className="detail-card-head">
                <div className="detail-card-heading">
                  <NoteIcon />
                  <h3 className="detail-card-title">{S.detail.notesTitle}</h3>
                </div>
                <button type="button" className="detail-edit-link" onClick={() => navigate(editHref)}>
                  {S.item.edit}
                </button>
              </div>
              <p className="detail-notes-body">{item.notes}</p>
            </section>
          )}

          {item.tags.length > 0 && (
            <section className="detail-card detail-tags-card">
              <div className="detail-card-head">
                <div className="detail-card-heading">
                  <TagIcon />
                  <h3 className="detail-card-title">{S.detail.tagsTitle}</h3>
                </div>
                <button type="button" className="detail-edit-link" onClick={() => navigate(editHref)}>
                  {S.item.edit}
                </button>
              </div>
              <div className="detail-tags">
                {item.tags.map((tag) => <span className="tag-pill" key={tag}>{tag}</span>)}
              </div>
            </section>
          )}

          <section className="detail-card detail-more-card">
            <div className="detail-card-heading">
              <LinkIcon />
              <h3 className="detail-card-title">{S.detail.moreInfoTitle}</h3>
            </div>
            {/* #113: the owner's saved "found it cheaper at" link — read-only,
                above the on-demand hints disclosure. Owner-only data: the
                guest projections never carry cheaperUrl. */}
            {item.cheaperUrl && (
              <a
                className="detail-row"
                href={item.cheaperUrl}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                <ExternalLinkIcon />
                <span>{S.detail.cheaperAt(urlHost(item.cheaperUrl))}</span>
                <ChevronRightIcon />
              </a>
            )}
            <div className="detail-hints">
              <HintsPanel
                itemId={item.id}
                open={hintsOpen}
                onToggle={toggleHints}
                hintState={hintState}
              />
            </div>
          </section>

          <div className="detail-footer">
            <span>{S.detail.addedOn(formatDate(item.createdAt))}</span>
            {(footerHost || item.imageSource === "search") && (
              <span className="detail-footer-source">
                {footerHost}
                {footerHost && item.imageSource === "search" && <span aria-hidden="true"> · </span>}
                {item.imageSource === "search" && S.item.imageViaSearch}
              </span>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/** Polls the item until it stops enriching (30s cap, 1.5s interval). Lives
 *  outside the component: it is a long-running side effect, not a render
 *  function. */
async function pollUntilSettled(reload: () => Promise<OwnedItem | null>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const item = await reload();
    if (!item || item.fetchState !== "pending") return;
  }
}

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">{children}</svg>;
}

function ExternalLinkIcon() {
  return <Icon><path d="M11 4h5v5M16 4l-7 7M14 11v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

function PencilIcon() {
  return <Icon><path d="m5 14.8-.7 2.7 2.7-.7L15.8 8 13 5.2 5 14.8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="m11.8 6.4 2.8 2.8" stroke="currentColor" strokeWidth="1.5" /></Icon>;
}

function ChevronRightIcon() {
  return <Icon size={16}><path d="m7.5 4 5 6-5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

function NoteIcon() {
  return <Icon><path d="M5 3.5h7l3 3V16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M12 3.8V7h3M7 10h6M7 13h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Icon>;
}

function TagIcon() {
  return <Icon><path d="M3.8 4.2h5.5l6.9 6.9-5.1 5.1-6.9-6.9V4.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><circle cx="7.2" cy="7.2" r="1" fill="currentColor" /></Icon>;
}

function LinkIcon() {
  return <Icon><path d="m8.1 11.9 3.8-3.8M6.3 14.3l-1.1 1.1a2.7 2.7 0 0 1-3.8-3.8l2.2-2.2a2.7 2.7 0 0 1 3.8 0M13.7 5.7l1.1-1.1a2.7 2.7 0 0 1 3.8 3.8l-2.2 2.2a2.7 2.7 0 0 1-3.8 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Icon>;
}
