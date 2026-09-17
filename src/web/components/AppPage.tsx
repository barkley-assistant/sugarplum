import { useEffect, useState } from "react";
import type {
  Me,
  OwnedItem,
  PriceHintState,
  PriceHintsResponse,
  PublicItem,
  WishlistSummaryRow,
} from "../../shared/types";
import { S } from "../strings";
import { useToast } from "../toast";
import { useDragReorder } from "../reorder";
import { parseShareTarget } from "../format";
import { useInstallPrompt } from "../pwa/install";
import {
  clearStoredIdentity,
  readStoredMe,
  readStoredSummary,
  writeStoredMe,
  writeStoredSummary,
} from "../me-store";
import { EmptyState } from "./EmptyState";
import { FilterChips } from "./FilterChips";
import { ItemForm, type ItemFormValues } from "./ItemForm";
import { ItemList, type OwnerRef } from "./ItemList";
import { SharePanel } from "./SharePanel";
import { Sheet } from "./Sheet";
import { ItemDetailSheet } from "./ItemDetailSheet";
import { AppShell, AppShellLoading } from "./AppShell";
import { IconButton, PlusIcon, ShareIcon } from "./IconButton";
import { ListSwitcher } from "./ListSwitcher";
import { UserMenu } from "./UserMenu";

export function AppPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [summary, setSummary] = useState<WishlistSummaryRow[]>([]);
  const [ownItems, setOwnItems] = useState<OwnedItem[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const [otherItems, setOtherItems] = useState<PublicItem[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [prefill, setPrefill] = useState<{ url: string; title: string }>({ url: "", title: "" });
  const [booted, setBooted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [hintStates, setHintStates] = useState<Record<string, PriceHintState>>({});
  const [openItemId, setOpenItemId] = useState<string | null>(null);
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
    if (values.cheaperUrl) payload.cheaperUrl = values.cheaperUrl;

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
    if (values.priceCents) payload.priceCents = values.priceCents;
    if (values.currency) payload.currency = values.currency;
    if (values.notes) payload.notes = values.notes;
    if (values.tags.length) payload.tags = values.tags;
    // Emptied link fields clear the stored value (null), never a stale one.
    payload.url = values.url || null;
    payload.cheaperUrl = values.cheaperUrl || null;

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

  /** Blind purchased reset (owner-only route, 204 with no body): the owner
   *  never learns whether a mark existed, when, or who set it. */
  async function resetPurchased(id: string) {
    const res = await fetch(`/api/wishlist/items/${id}/purchased`, { method: "DELETE" });
    if (res.status !== 204) {
      toast(S.errors.generic, "danger");
      return;
    }
    if (me) await refreshOwnList(me.id);
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
    if (me) {
      await refreshOwnList(me.id);
      // The 202 means "queued": poll so a moved price and the new snapshot
      // render without a manual reload.
      void pollAfterCreate(me.id);
    }
  }

  /** On-demand, display-only candidate hints for one item (owner-only route).
   *  Nothing here is persisted or verified. */
  async function checkPrices(id: string) {
    setHintStates((prev) => ({ ...prev, [id]: { status: "loading", hints: [], disabled: false } }));
    let res: Response;
    try {
      res = await fetch(`/api/wishlist/items/${id}/hints`, { method: "POST" });
    } catch {
      setHintStates((prev) => ({ ...prev, [id]: { status: "error", hints: [], disabled: false } }));
      toast(S.errors.checkPrices, "danger");
      return;
    }
    if (!res.ok) {
      setHintStates((prev) => ({ ...prev, [id]: { status: "error", hints: [], disabled: false } }));
      toast(S.errors.checkPrices, "danger");
      return;
    }
    const body = (await res.json()) as PriceHintsResponse;
    setHintStates((prev) => ({
      ...prev,
      [id]: { status: "done", hints: body.hints, disabled: body.disabled },
    }));
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
    clearStoredIdentity();
    location.href = "/login";
  }

  function goToSettings() {
    location.href = "/settings";
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
    return <AppShellLoading />;
  }

  const ownRef: OwnerRef = { id: me.id, displayName: me.displayName || me.username };

  const switcherRows = [
    { userId: me.id, displayName: ownRef.displayName, itemCount: ownItems.length },
    ...summary
      .filter((row) => row.userId !== me.id)
      .map((row) => ({ userId: row.userId, displayName: row.displayName, itemCount: row.itemCount }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  ];

  const allTags = Array.from(new Set(ownItems.flatMap((i) => i.tags))).sort();
  const detailItem = ownItems.find((item) => item.id === openItemId) ?? null;

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
        onCheckPrices={checkPrices}
        onResetPurchased={resetPurchased}
        hintStates={hintStates}
        onOpenDetails={setOpenItemId}
      />
    );
  }

  const showOwnerActions = !viewing && ownItems.length > 0;
  const ownerActions = showOwnerActions ? (
    <>
      <IconButton variant="ghost" label={S.list.addItem} onClick={() => setAddOpen(true)}>
        <PlusIcon />
      </IconButton>
      <IconButton variant="ghost" label={S.share.shareList} onClick={() => setShareOpen((v) => !v)} aria-expanded={shareOpen}>
        <ShareIcon />
      </IconButton>
    </>
  ) : null;

  const userMenu = (
    <UserMenu
      displayName={me.displayName || me.username}
      onLogout={logout}
      onSettings={goToSettings}
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
  );

  return (
    <AppShell
      refreshing={refreshing}
      headerActions={ownerActions}
      headerRight={userMenu}
    >
      {error && <p className="error" role="alert">{error}</p>}

      <div className="list-layout">
        <section className="list-section">
          <ListSwitcher
            currentName={viewing ? ownerRefFor(viewing).displayName : ownRef.displayName}
            rows={switcherRows}
            currentUserId={viewing}
            count={viewing ? otherItems.length : ownItems.length}
            onSelect={(userId) => (userId === null ? backToOwnList() : void viewList(userId))}
          />
          {!viewing && ownItems.length > 0 && (
            <FilterChips
              tags={allTags}
              active={activeTag}
              onSelect={setActiveTag}
            />
          )}
          {renderList()}
        </section>

        {!viewing && showOwnerActions && (
          <Sheet open={shareOpen} onClose={() => setShareOpen(false)} ariaLabel={S.share.shareList}>
            <SharePanel />
          </Sheet>
        )}
      </div>

      {!viewing && (
        <Sheet open={addOpen} onClose={() => setAddOpen(false)} ariaLabel={S.list.addItem}>
          <h2>{S.list.addItem}</h2>
          <ItemForm
            submitLabel={S.list.addItem}
            initialValues={prefill}
            onSubmit={createItem}
            onCancel={() => setAddOpen(false)}
            autoFocusUrl
          />
        </Sheet>
      )}
      {!viewing && detailItem && (
        <ItemDetailSheet
          item={detailItem}
          onClose={() => setOpenItemId(null)}
          onEdit={editItem}
          onDelete={deleteItem}
          onRefresh={refreshItem}
          onResetPurchased={resetPurchased}
          onCheckPrices={checkPrices}
          hintState={hintStates[detailItem.id]}
        />
      )}
    </AppShell>
  );
}