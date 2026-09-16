import { useEffect, useState } from "react";
import type { ShareView } from "../../shared/types";
import { S } from "../strings";
import { useToast } from "../toast";
import { useConfirm } from "../confirm";
import { formatPrice } from "../format";
import { ItemLink } from "./ItemLink";

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
    return (
      <main className="app-shell">
        <div className="app-main">
          <p className="muted">{S.app.loading}</p>
        </div>
      </main>
    );
  }

  if (state.status === "invalid") {
    return (
      <main className="app-shell">
        <div className="app-main">
          <div className="card share-card">
            <p className="error" role="alert">
              {S.share.invalidLink}
            </p>
          </div>
        </div>
      </main>
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
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/assets/brand/pwa/favicon-32.png" alt="" />
          <h1 className="brand-name">{S.app.name}</h1>
        </div>
      </header>
      <div className="app-main">
        <div className="list-heading">
          <h2>{S.list.heading(view.ownerDisplayName)}</h2>
          <span className="count">{S.list.itemCount(view.items.length)}</span>
        </div>
        <p className="muted share-note">{S.share.sharedByNote}</p>
        {view.viewerIsOwner && <p className="muted share-note">{S.share.ownerViewingOwn}</p>}
        {view.items.length === 0 ? (
          <p className="muted">{S.empty.other(view.ownerDisplayName)}</p>
        ) : (
          <ul className="item-list">
            {view.items.map((item) => (
              <li className="card item-card" key={item.id} data-item-id={item.id}>
                <div className="item-card-row">
                  <div className="item-card-main">
                    {item.hasImage && (
                      <img
                        className="item-thumb"
                        src={`/api/share/${token}/items/${item.id}/image`}
                        alt=""
                        loading="lazy"
                      />
                    )}
                    <div className="item-card-text">
                      <h3 className="item-title">{item.title}</h3>
                      {item.siteName && <span className="item-site">{item.siteName}</span>}
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
                    </div>
                  </div>
                  <div className="price-row">
                    <span className="price">{formatPrice(item.priceCents, item.currency)}</span>
                  </div>
                </div>
                <div className="item-row-actions">
                  {item.purchased ? (
                    <span className="claimed-badge share-purchased-badge">
                      {S.share.purchasedBadge}
                    </span>
                  ) : view.viewerIsOwner ? null : (
                    <button onClick={() => void markPurchased(item.id)} disabled={busy === item.id}>
                      {S.share.markPurchased}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
