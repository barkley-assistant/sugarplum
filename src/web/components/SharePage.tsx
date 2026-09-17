import { useEffect, useState } from "react";
import type { ShareView } from "../../shared/types";
import { S } from "../strings";
import { useToast } from "../toast";
import { useConfirm } from "../confirm";
import { formatPrice } from "../format";
import { AppShell, AppShellLoading, PageHeader } from "./AppShell";
import { DotsIcon } from "./IconButton";
import { ItemLink } from "./ItemLink";
import { OverflowMenu } from "./OverflowMenu";
import { PriceCluster } from "./PriceCluster";
import { ProductImage } from "./ProductImage";
import { ProductRow } from "./ProductRow";
import { StatusBadge } from "./StatusBadge";

type State =
  | { status: "loading" }
  | { status: "invalid" }
  | { status: "ready"; view: ShareView };

/** Anonymous share view. Renders inside ToastProvider+ConfirmProvider;
 *  app.tsx routes /share/:token here BEFORE AppPage, so there is no
 *  /api/auth/me call, no login redirect and no admin surface. The owner may
 *  still open their own link: the server then projects the purchased marks
 *  out and tells us so (viewerIsOwner), and the mark action is hidden. */
export function SharePage({ token }: { token: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
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
        <p className="muted">{S.empty.other(view.ownerDisplayName)}</p>
      ) : (
        <ul className="item-list">
          {view.items.map((item) => (
            <ProductRow
              key={item.id}
              id={item.id}
              title={item.title}
              purchased={item.purchased}
              image={
                item.hasImage ? (
                  <ProductImage src={`/api/share/${token}/items/${item.id}/image`} />
                ) : undefined
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
                    items={[
                      {
                        id: "mark-purchased",
                        label: S.share.markPurchased,
                        onSelect: () => markPurchased(item.id),
                      },
                    ]}
                  />
                )
              }
              body={
                <>
                  {item.siteName && <span className="item-site">{item.siteName}</span>}
                  <PriceCluster price={formatPrice(item.priceCents, item.currency)} />
                  {item.url && <ItemLink url={item.url} />}
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
                </>
              }
            />
          ))}
        </ul>
      )}
    </AppShell>
  );
}
