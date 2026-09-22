import { useEffect, useState } from "react";
import type { ShareItem, ShareView } from "../../shared/types";
import { S } from "../strings";
import { useToast } from "../toast";
import { useConfirm } from "../confirm";
import { formatPrice } from "../format";
import { navigate } from "../router";
import { AppShell, AppShellLoading, PageHeader } from "./AppShell";
import { DotsIcon } from "./IconButton";
import { EmptyState } from "./EmptyState";
import { GuestItemDetailSheet, type GuestItemDetail } from "./GuestItemDetailSheet";
import { lowestState } from "./ItemCard";
import { OverflowMenu } from "./OverflowMenu";
import { PriceCluster } from "./PriceCluster";
import { ProductImage } from "./ProductImage";
import { ProductRow } from "./ProductRow";
import { StatusBadge } from "./StatusBadge";

type State =
  | { status: "loading" }
  | { status: "invalid" }
  | { status: "ready"; view: ShareView };

/** Anonymous share view. Renders inside ToastProvider+ConfirmProvider; the
 *  SPA router routes /share/:token here INSTEAD of AppPage, so there is no
 *  /api/auth/me call, no login redirect and no admin surface. The owner may
 *  still open their own link: the server then projects the purchased marks
 *  out and tells us so (viewerIsOwner), and the mark action is hidden. */
export function SharePage({ token }: { token: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/share/${token}`);
        if (res.status === 404) {
          if (!cancelled) setState({ status: "invalid" });
          return;
        }
        if (!res.ok) throw new Error();
        const view = (await res.json()) as ShareView;
        if (!cancelled) setState({ status: "ready", view });
      } catch {
        if (!cancelled) setState({ status: "invalid" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === "loading") {
    return <AppShellLoading />;
  }

  if (state.status === "invalid") {
    return (
      <AppShell>
        <div className="card share-card">
          <p className="error" role="alert">
            {S.share.invalidLink}
          </p>
        </div>
      </AppShell>
    );
  }

  const { view } = state;
  const openItem = view.items.find((item) => item.id === openId) ?? null;

  /** #133: the row menu's read-only "Copy link", the same clipboard+toast
   *  pair ItemCard.copyProductLink and the guest sheet's copyLink use (a
   *  blocked clipboard degrades to the error toast, never a dead end). */
  async function copyProductLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast(S.item.copied);
    } catch {
      toast(S.errors.generic, "danger");
    }
  }

  async function markPurchased(itemId: string) {
    const ok = await confirm({
      title: S.share.markPurchasedTitle,
      body: S.share.markPurchasedBody,
      confirmLabel: S.share.markPurchased,
      danger: false,
    });
    if (!ok) return;
    setBusy(itemId);
    try {
      const res = await fetch(`/api/share/${token}/items/${itemId}/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (res.status === 429) {
        toast(S.share.retryLater, "danger");
        return;
      }
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { id: string; purchased: boolean };
      setState((prev) =>
        prev.status === "ready"
          ? {
              ...prev,
              view: {
                ...prev.view,
                items: prev.view.items.map((i) =>
                  i.id === body.id ? { ...i, purchased: true } : i,
                ),
              },
            }
          : prev,
      );
    } catch {
      toast(S.share.markFailed, "danger");
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell>
      <PageHeader title={S.list.heading(view.ownerDisplayName)} count={view.items.length} />
      <p className="muted share-note">{S.share.sharedByNote}</p>
      {view.viewerIsOwner && <p className="muted share-note">{S.share.ownerViewingOwn}</p>}
      {view.items.length === 0 ? (
        <EmptyState title={S.empty.other(view.ownerDisplayName)} />
      ) : (
        <ul className="item-list">
          {view.items.map((item) => {
            // #130's verdict, computed exactly as owner and other-user rows do
            // (ItemCard) — the guest feed is the third consumer of one rule.
            const lowest = lowestState(item.priceCents, item.currency, item.priceStats ?? null);
            return (
              <ProductRow
                key={item.id}
                id={item.id}
                title={item.title}
                purchased={item.purchased}
                onOpen={() => setOpenId(item.id)}
                image={
                  item.hasImage ? (
                    <ProductImage src={`/api/share/${token}/items/${item.id}/image`} />
                  ) : (
                    // #119: share rows reserve the thumb frame too.
                    <span className="product-img-fallback" aria-hidden="true" />
                  )
                }
                price={
                  <PriceCluster
                    price={formatPrice(item.priceCents, item.currency)}
                    metaParts={lowest?.kind === "below" ? [S.item.lowestSeen(lowest.lowest)] : []}
                    atLowest={lowest?.kind === "equal"}
                  />
                }
                actions={
                  item.purchased ? (
                    <StatusBadge variant="purchased">{S.share.purchasedBadge}</StatusBadge>
                  ) : view.viewerIsOwner ? undefined : (
                    <OverflowMenu
                      triggerLabel={S.item.moreActions}
                      triggerIcon={<DotsIcon />}
                      triggerDisabled={busy === item.id}
                      menuLabel={S.item.moreActions}
                      // #133: the menu is an explicit guest-safe list — never
                      // derived from the owner menu, so no owner action can
                      // reach this surface. The write stays a ROW interaction
                      // (spec 15e's pin); the sheet is read-only by design.
                      items={[
                        ...(item.url
                          ? [
                              {
                                id: "open-product",
                                label: S.detail.openProduct,
                                onSelect: () => {
                                  window.open(item.url as string, "_blank", "noopener,noreferrer");
                                },
                              },
                              {
                                id: "copy-link",
                                label: S.item.copyLink,
                                onSelect: () => copyProductLink(item.url as string),
                              },
                            ]
                          : []),
                        {
                          id: "mark-purchased",
                          label: S.share.markPurchased,
                          onSelect: () => markPurchased(item.id),
                        },
                      ]}
                    />
                  )
                }
                body={item.siteName ? <span className="item-site">{item.siteName}</span> : undefined}
              />
            );
          })}
        </ul>
      )}
      {openItem && (
        <GuestItemDetailSheet
          item={toGuestDetail(openItem, token)}
          onClose={() => setOpenId(null)}
        />
      )}
      {!view.viewerIsOwner && (
        <p className="muted share-signin">
          <a
            href="/login?next=/"
            onClick={(e) => {
              // The Brand's in-app link contract (AppShell.tsx:32-40): a plain
              // left-click navigates through the router; modified clicks keep
              // the browser's own behaviour.
              if (
                e.defaultPrevented ||
                e.button !== 0 ||
                e.metaKey ||
                e.ctrlKey ||
                e.shiftKey ||
                e.altKey
              ) {
                return;
              }
              e.preventDefault();
              navigate("/login?next=/");
            }}
          >
            {S.share.signInHook}
          </a>
        </p>
      )}
    </AppShell>
  );
}

/** Maps the anonymous share projection (ShareItem) into the guest detail
 *  sheet's normalized shape. Every field read here exists on ShareItem, which
 *  carries the added date and the derived price stats (product facts, sent to
 *  every viewer) but no owner data and no claim state. The image stays
 *  token-scoped: a share viewer must never reach the session-scoped item
 *  image route. */
function toGuestDetail(item: ShareItem, token: string): GuestItemDetail {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    priceCents: item.priceCents,
    currency: item.currency,
    notes: item.notes,
    tags: item.tags,
    siteName: item.siteName,
    imageSrc: item.hasImage ? `/api/share/${token}/items/${item.id}/image` : undefined,
    createdAt: item.createdAt,
    priceStats: item.priceStats,
    imageSource: item.imageSource,
    purchased: item.purchased,
  };
}
