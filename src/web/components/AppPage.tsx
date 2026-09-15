import { useEffect, useState } from "react";
import type {
  AdminUser,
  Me,
  OwnedItem,
  PublicItem,
  WishlistSummaryRow,
} from "../../shared/types";
import { S } from "../strings";
import { useToast } from "../toast";
import { useDragReorder } from "../reorder";
import { AdminPanel } from "./AdminPanel";
import { EmptyState } from "./EmptyState";
import { ItemForm, type ItemFormValues } from "./ItemForm";
import { ItemList, ListHeading, type OwnerRef } from "./ItemList";
import { SkeletonList } from "./SkeletonList";
import { UserMenu } from "./UserMenu";

export function AppPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [summary, setSummary] = useState<WishlistSummaryRow[]>([]);
  const [ownItems, setOwnItems] = useState<OwnedItem[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const [otherItems, setOtherItems] = useState<PublicItem[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [prefill, setPrefill] = useState<{ url: string; title: string }>({ url: "", title: "" });
  const [booted, setBooted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();
  const reorder = useDragReorder(ownItems, onReorder);

  useEffect(() => {
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function boot() {
    try {
      const meRes = await fetch("/api/auth/me");
      if (meRes.status === 401) {
        location.href = "/login";
        return;
      }
      const meBody = (await meRes.json()) as Me;
      setMe(meBody);

      // Share Target seam: /add?url=…&title=… prefills the add form.
      const params = new URLSearchParams(location.search);
      const url = params.get("url") ?? "";
      const title = params.get("title") ?? "";
      setPrefill({ url, title });
      if (url || title) setAddOpen(true);

      await Promise.all([refreshSummary(), refreshOwnList(meBody.id)]);
      if (meBody.isAdmin) await refreshUsers();
      setBooted(true);
    } catch {
      setError(S.errors.loadWishlist);
      setBooted(true);
    }
  }

  async function refreshSummary() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/wishlist/summary");
      if (res.ok) setSummary((await res.json()) as WishlistSummaryRow[]);
    } finally {
      setRefreshing(false);
    }
  }

  async function refreshOwnList(userId: string) {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/users/${userId}/wishlist`);
      if (res.ok) setOwnItems((await res.json()) as OwnedItem[]);
    } finally {
      setRefreshing(false);
    }
  }

  async function refreshUsers() {
    const res = await fetch("/api/users");
    if (res.ok) setUsers((await res.json()) as AdminUser[]);
  }

  async function viewList(userId: string) {
    setViewing(userId);
    setRefreshing(true);
    try {
      const res = await fetch(`/api/users/${userId}/wishlist`);
      if (res.ok) setOtherItems((await res.json()) as PublicItem[]);
    } finally {
      setRefreshing(false);
    }
  }

  function backToOwnList() {
    setViewing(null);
    setOtherItems([]);
  }

  async function createItem(values: ItemFormValues) {
    const payload: Record<string, unknown> = { title: values.title };
    if (values.url) payload.url = values.url;
    if (values.priceCents) payload.priceCents = values.priceCents;
    if (values.currency) payload.currency = values.currency;
    if (values.notes) payload.notes = values.notes;
    if (values.tags.length) payload.tags = values.tags;

    const res = await fetch("/api/wishlist/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(S.errors.addItem);
    setAddOpen(false);
    setPrefill({ url: "", title: "" });
    if (me) {
      await refreshOwnList(me.id);
      if (values.url) void pollAfterCreate(me.id);
    }
    await refreshSummary();
  }

  async function editItem(id: string, values: ItemFormValues) {
    const payload: Record<string, unknown> = { title: values.title };
    if (values.url) payload.url = values.url;
    if (values.priceCents) payload.priceCents = values.priceCents;
    if (values.currency) payload.currency = values.currency;
    if (values.notes) payload.notes = values.notes;
    if (values.tags.length) payload.tags = values.tags;

    const res = await fetch(`/api/wishlist/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(S.errors.saveItem);
    if (me) await refreshOwnList(me.id);
  }

  async function deleteItem(id: string) {
    try {
      const res = await fetch(`/api/wishlist/items/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      if (me) await refreshOwnList(me.id);
      await refreshSummary();
    } catch {
      toast(S.errors.deleteItem, "danger");
    }
  }

  /** Optimistic reorder commit: PUT the full ordered id array. On failure,
   *  restore the pre-drag order and surface a danger toast. */
  async function onReorder(ids: string[]) {
    const previous = ownItems;
    try {
      const res = await fetch("/api/wishlist/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: ids }),
      });
      if (!res.ok) throw new Error();
      if (me) await refreshOwnList(me.id);
    } catch {
      setOwnItems(previous);
      toast(S.errors.reorder, "danger");
    }
  }

  async function refreshItem(id: string) {
    const res = await fetch(`/api/wishlist/items/${id}/refresh`, { method: "POST" });
    if (!res.ok) {
      toast(S.errors.retryItem, "danger");
      return;
    }
    if (me) await refreshOwnList(me.id);
  }

  /** After a URL-only add, poll the list a few times so "Fetching details…"
   *  resolves without user action (reuses the existing list GET; cheap). */
  async function pollAfterCreate(userId: string) {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await refreshOwnList(userId);
    }
  }

  async function claim(id: string) {
    if (!viewing) return;
    const res = await fetch(`/api/wishlist/items/${id}/claim`, { method: "POST" });
    if (!res.ok) {
      toast(S.errors.claimItem, "danger");
      return;
    }
    await viewList(viewing);
    await refreshSummary();
  }

  async function unclaim(id: string) {
    if (!viewing) return;
    const res = await fetch(`/api/wishlist/items/${id}/unclaim`, { method: "POST" });
    if (!res.ok) {
      toast(S.errors.unclaimItem, "danger");
      return;
    }
    await viewList(viewing);
    await refreshSummary();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    location.href = "/login";
  }

  async function adminChanged() {
    await Promise.all([refreshSummary(), refreshUsers()]);
  }

  function scrollToAdmin() {
    document.getElementById("admin-panel")?.scrollIntoView({ behavior: "smooth" });
  }

  if (error && !me) {
    return (
      <main className="auth-page">
        <div className="card auth-card">
          <p className="error" role="alert">{error}</p>
        </div>
      </main>
    );
  }

  if (!booted || !me) {
    return (
      <main className="app-shell">
        <header className="topbar">
          <div className="brand">
            <img className="brand-mark" src="/assets/brand/pwa/favicon-32.png" alt="" />
            <h1 className="brand-name">{S.app.name}</h1>
          </div>
        </header>
        <div className="app-main">
          <SkeletonList />
        </div>
      </main>
    );
  }

  const others = summary.filter((row) => row.userId !== me.id);
  const ownRef: OwnerRef = { id: me.id, displayName: me.username };

  function ownerRefFor(userId: string): OwnerRef {
    const row = summary.find((r) => r.userId === userId);
    return row ? { id: row.userId, displayName: row.displayName } : ownRef;
  }

  function renderList() {
    if (viewing) {
      const owner = ownerRefFor(viewing);
      if (otherItems.length === 0) {
        return <EmptyState title={S.empty.other(owner.displayName)} />;
      }
      return (
        <ItemList
          items={otherItems}
          viewerIsOwner={false}
          onClaim={claim}
          onUnclaim={unclaim}
        />
      );
    }

    if (ownItems.length === 0) {
      return (
        <EmptyState
          title={S.empty.own}
          body={S.empty.ownHint}
          action={
            <button className="primary" onClick={() => setAddOpen(true)}>
              {S.list.addItem}
            </button>
          }
        />
      );
    }

    const orderedOwn = reorder.orderedIds
      .map((id) => ownItems.find((i) => i.id === id))
      .filter((i): i is OwnedItem => i !== undefined);

    return (
      <ItemList
        items={orderedOwn}
        viewerIsOwner
        onEdit={editItem}
        onDelete={deleteItem}
        onRefresh={refreshItem}
        draggingId={reorder.draggingId}
        renderDragHandle={(id) => (
          <button type="button" {...reorder.getHandleProps(id)}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M3 4h10M3 8h10M3 12h10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      />
    );
  }

  return (
    <main className="app-shell">
      {refreshing && <div className="progress-hairline" aria-hidden="true" />}
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/assets/brand/pwa/favicon-32.png" alt="" />
          <h1 className="brand-name">{S.app.name}</h1>
        </div>
        <div className="topbar-right">
          <UserMenu
            displayName={me.displayName || me.username}
            isAdmin={me.isAdmin}
            onLogout={logout}
            onAdmin={scrollToAdmin}
          />
        </div>
      </header>

      <div className="app-main">
        {error && <p className="error" role="alert">{error}</p>}

        <nav className="user-switcher" aria-label={S.list.heading(me.username)}>
          {others.map((row) => (
            <button
              key={row.userId}
              className={viewing === row.userId ? "chip active" : "chip"}
              onClick={() => void viewList(row.userId)}
            >
              {S.list.viewList(row.displayName)}
            </button>
          ))}
          {viewing && (
            <button className="chip" onClick={backToOwnList}>
              {S.list.backToMyList}
            </button>
          )}
        </nav>

        <section className="list-section">
          <ListHeading owner={viewing ? ownerRefFor(viewing) : ownRef} count={viewing ? otherItems.length : ownItems.length} />
          {renderList()}
        </section>

        {!viewing && addOpen && (
          <div
            className="sheet-overlay"
            onClick={(e) => {
              if (e.target === e.currentTarget) setAddOpen(false);
            }}
          >
            <div className="sheet" role="dialog" aria-modal="true" aria-label={S.list.addItem}>
              <h2>{S.list.addItem}</h2>
              <ItemForm
                submitLabel={S.list.addItem}
                initialValues={prefill}
                onSubmit={createItem}
                onCancel={() => setAddOpen(false)}
              />
            </div>
          </div>
        )}

        {me.isAdmin && (
          <section id="admin-panel">
            <AdminPanel users={users} onChanged={adminChanged} />
          </section>
        )}
      </div>
    </main>
  );
}