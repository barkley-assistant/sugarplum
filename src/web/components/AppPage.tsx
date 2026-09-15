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
import { parseShareTarget } from "../format";
import { useInstallPrompt } from "../pwa/install";
import { AdminPanel } from "./AdminPanel";
import { EmptyState } from "./EmptyState";
import { FilterChips } from "./FilterChips";
import { ItemForm, type ItemFormValues } from "./ItemForm";
import { ItemList, ListHeading, type OwnerRef } from "./ItemList";
import { SkeletonList } from "./SkeletonList";
import { UserMenu } from "./UserMenu";

/** localStorage keys. The cached `me` lets boot() render offline using the
 *  last known identity (so the SW's cached list bytes — keyed by user id —
 *  can be requested by URL). `summary` powers the user-switcher chips. */
const STORAGE_KEY_ME = "sugarplum.me";
const STORAGE_KEY_SUMMARY = "sugarplum.summary";

function readStoredMe(): Me | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Me>;
    if (typeof parsed.id === "string" && parsed.id.length > 0) {
      return {
        id: parsed.id,
        username: parsed.username ?? "",
        displayName: parsed.displayName ?? "",
        isAdmin: Boolean(parsed.isAdmin),
      };
    }
  } catch {
    // Corrupted entry — ignore and fall through to no-identity error.
  }
  return null;
}

function writeStoredMe(me: Me): void {
  try {
    localStorage.setItem(STORAGE_KEY_ME, JSON.stringify(me));
  } catch {
    // Storage may be unavailable (private mode); offline fallback just won't work.
  }
}

function readStoredSummary(): WishlistSummaryRow[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SUMMARY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as WishlistSummaryRow[];
  } catch {
    // Ignore.
  }
  return null;
}

function writeStoredSummary(rows: WishlistSummaryRow[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_SUMMARY, JSON.stringify(rows));
  } catch {
    // Ignore.
  }
}

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
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const toast = useToast();
  const reorder = useDragReorder(ownItems, onReorder);
  const install = useInstallPrompt();

  useEffect(() => {
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function boot() {
    try {
      const meRes = await fetch("/api/auth/me");
      if (meRes.status === 401) {
        // Carry share-target prefill through the login hop.
        const here = location.pathname + location.search;
        location.href = `/login?next=${encodeURIComponent(here)}`;
        return;
      }
      if (!meRes.ok) {
        // Offline (or any non-401 network failure). Fall back to the last-known
        // identity cached from a prior successful boot so we can request the
        // SW-cached list bytes by the right URL.
        const stored = readStoredMe();
        if (!stored) {
          setError(S.errors.loadWishlist);
          setBooted(true);
          return;
        }
        setMe(stored);
        const cachedSummary = readStoredSummary();
        if (cachedSummary) setSummary(cachedSummary);
        const share = parseShareTarget(new URLSearchParams(location.search));
        setPrefill({ url: share.url, title: share.title });
        if (share.url || share.title) setAddOpen(true);
        await Promise.all([refreshSummary(stored.id), refreshOwnList(stored.id)]);
        setBooted(true);
        return;
      }
      const meBody = (await meRes.json()) as Me;
      setMe(meBody);
      writeStoredMe(meBody);

      // Share Target seam: /add?url=&title=&text= prefills the add form.
      // title falls back to the first line of text; url to the first
      // http(s) token in text (D8).
      const share = parseShareTarget(new URLSearchParams(location.search));
      setPrefill({ url: share.url, title: share.title });
      if (share.url || share.title) setAddOpen(true);

      await Promise.all([refreshSummary(), refreshOwnList(meBody.id)]);
      if (meBody.isAdmin) await refreshUsers();
      setBooted(true);
    } catch {
      const stored = readStoredMe();
      if (!stored) {
        setError(S.errors.loadWishlist);
        setBooted(true);
        return;
      }
      setMe(stored);
      const cachedSummary = readStoredSummary();
      if (cachedSummary) setSummary(cachedSummary);
      setBooted(true);
    }
  }

  async function refreshSummary(forUserId?: string) {
    setRefreshing(true);
    try {
      const res = await fetch("/api/wishlist/summary");
      if (res.ok) {
        const rows = (await res.json()) as WishlistSummaryRow[];
        setSummary(rows);
        // Only persist rows that match a known identity — when the viewer
        // impersonates, we don't want to clobber the owner's chips with
        // an unfiltered fetch.
        if (!forUserId || rows.some((r) => r.userId === forUserId)) {
          writeStoredSummary(rows);
        }
      }
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
    try {
      localStorage.removeItem(STORAGE_KEY_ME);
      localStorage.removeItem(STORAGE_KEY_SUMMARY);
    } catch {
      // Ignore.
    }
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

  const allTags = Array.from(new Set(ownItems.flatMap((i) => i.tags))).sort();
  const tagCounts: Record<string, number> = {};
  for (const item of ownItems) {
    for (const t of item.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  }

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
      .filter((i): i is OwnedItem => i !== undefined)
      .filter((i) => !activeTag || i.tags.includes(activeTag));

    if (orderedOwn.length === 0 && activeTag) {
      return (
        <EmptyState
          title={S.empty.filtered(activeTag)}
          action={
            <button className="secondary" onClick={() => setActiveTag(null)}>
              {S.empty.clearFilter}
            </button>
          }
        />
      );
    }

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
            extra={
              install.canInstall ? (
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={install.promptInstall}
                >
                  {S.pwa.install}
                </button>
              ) : undefined
            }
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
          {!viewing && !addOpen && ownItems.length > 0 && (
            <button className="primary" onClick={() => setAddOpen(true)}>
              {S.list.addItem}
            </button>
          )}
          {!viewing && ownItems.length > 0 && (
            <FilterChips
              tags={allTags}
              counts={tagCounts}
              active={activeTag}
              onSelect={setActiveTag}
            />
          )}
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
                autoFocusUrl
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