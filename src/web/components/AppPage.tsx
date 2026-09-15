import { useEffect, useState } from "react";
import type {
  AdminUser,
  Me,
  OwnedItem,
  PublicItem,
  WishlistSummaryRow,
} from "../../shared/types";
import { S } from "../strings";
import { AdminPanel } from "./AdminPanel";
import { ItemForm, type ItemFormValues } from "./ItemForm";
import { ItemList, ListHeading, type OwnerRef } from "./ItemList";

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
    const res = await fetch("/api/wishlist/summary");
    if (res.ok) setSummary((await res.json()) as WishlistSummaryRow[]);
  }

  async function refreshOwnList(userId: string) {
    const res = await fetch(`/api/users/${userId}/wishlist`);
    if (res.ok) setOwnItems((await res.json()) as OwnedItem[]);
  }

  async function refreshUsers() {
    const res = await fetch("/api/users");
    if (res.ok) setUsers((await res.json()) as AdminUser[]);
  }

  async function viewList(userId: string) {
    setViewing(userId);
    const res = await fetch(`/api/users/${userId}/wishlist`);
    if (res.ok) setOtherItems((await res.json()) as PublicItem[]);
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
    const res = await fetch(`/api/wishlist/items/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(S.errors.deleteItem);
    if (me) await refreshOwnList(me.id);
    await refreshSummary();
  }

  async function refreshItem(id: string) {
    const res = await fetch(`/api/wishlist/items/${id}/refresh`, { method: "POST" });
    if (!res.ok) {
      setError(S.errors.retryItem);
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
      setError(S.errors.claimItem);
      return;
    }
    await viewList(viewing);
    await refreshSummary();
  }

  async function unclaim(id: string) {
    if (!viewing) return;
    const res = await fetch(`/api/wishlist/items/${id}/unclaim`, { method: "POST" });
    if (!res.ok) {
      setError(S.errors.unclaimItem);
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

  if (!booted || !me) {
    return <main className="auth-page"><p className="muted">{S.app.loading}</p></main>;
  }

  const others = summary.filter((row) => row.userId !== me.id);
  const ownRef: OwnerRef = { id: me.id, displayName: me.username };

  function ownerRefFor(userId: string): OwnerRef {
    const row = summary.find((r) => r.userId === userId);
    return row ? { id: row.userId, displayName: row.displayName } : ownRef;
  }

  return (
    <main className="app-page">
      <header className="topbar">
        <h1>{S.app.name}</h1>
        <div className="topbar-right">
          <span className="muted">{me.username}</span>
          <button className="secondary" onClick={() => void logout()}>
            {S.auth.signOut}
          </button>
        </div>
      </header>

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
        {viewing ? (
          <>
            <ListHeading
              owner={ownerRefFor(viewing)}
              count={otherItems.length}
            />
            <ItemList
              items={otherItems}
              viewerIsOwner={false}
              onClaim={claim}
              onUnclaim={unclaim}
            />
          </>
        ) : (
          <>
            <ListHeading owner={ownRef} count={ownItems.length} />
            {addOpen ? (
              <ItemForm
                submitLabel={S.list.addItem}
                initialValues={prefill}
                onSubmit={createItem}
                onCancel={() => setAddOpen(false)}
              />
            ) : (
              <button className="primary" onClick={() => setAddOpen(true)}>
                {S.list.addItem}
              </button>
            )}
            <ItemList
              items={ownItems}
              viewerIsOwner
              onEdit={editItem}
              onDelete={deleteItem}
              onRefresh={refreshItem}
            />
          </>
        )}
      </section>

      {me.isAdmin && <AdminPanel users={users} onChanged={adminChanged} />}
    </main>
  );
}