import { useEffect, useRef, useState } from "react";
import type {
  Me,
  OwnedItem,
  PublicItem,
  WishlistSummaryRow,
} from "../../shared/types";
import { S } from "../strings";
import { useToast } from "../toast";
import { useDragReorder } from "../reorder";
import { parseShareTarget } from "../format";
import { navigate } from "../router";
import {
  clearPendingFocusItemId,
  peekPendingFocusItemId,
  saveFeedSnapshot,
  takeFeedSnapshot,
  trackFeedScroll,
  trackedFeedScrollY,
} from "../feed-handoff";
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
import { ItemList, type OwnerRef } from "./ItemList";
import { ShareMenu } from "./ShareMenu";
import { GuestItemDetailSheet, type GuestItemDetail } from "./GuestItemDetailSheet";
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
  const [shareOpen, setShareOpen] = useState(false);
  const [booted, setBooted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [guestItemId, setGuestItemId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const reorderToggleRef = useRef<HTMLButtonElement | null>(null);
  const shareTriggerRef = useRef<HTMLButtonElement | null>(null);
  /** #62 D8: scroll position handed back from feed-handoff, applied after the
   *  restored rows commit (the list must exist before scrollTo can stick). */
  const handoffScrollRef = useRef<number | null>(null);
  const toast = useToast();
  const reorder = useDragReorder(ownItems, onReorder);
  const install = useInstallPrompt();

  useEffect(() => {
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The feed snapshot is written on UNMOUNT (leaving the feed), from a ref of
  // the latest committed state — reading it on every render would flip this
  // into a save-per-keystroke without any benefit.
  const feedStateRef = useRef<{
    me: Me | null;
    ownItems: OwnedItem[];
    otherItems: PublicItem[];
    summary: WishlistSummaryRow[];
    viewing: string | null;
    activeTag: string | null;
  }>({ me: null, ownItems: [], otherItems: [], summary: [], viewing: null, activeTag: null });
  useEffect(() => {
    feedStateRef.current = { me, ownItems, otherItems, summary, viewing, activeTag };
  });

  useEffect(() => {
    return () => {
      const state = feedStateRef.current;
      if (!state.me) return;
      saveFeedSnapshot({
        meId: state.me.id,
        ownItems: state.ownItems,
        otherItems: state.otherItems,
        summary: state.summary,
        viewingUserId: state.viewing,
        activeTag: state.activeTag,
        scrollY: trackedFeedScrollY(),
      });
    };
  }, []);

  // The scroll offset is part of the handoff, and it must be tracked while
  // the feed is on screen (see feed-handoff: the unmount read is too late).
  useEffect(() => trackFeedScroll(), []);

  // Applied after the feed content commits: a just-added row (add flow) wins
  // over the plain scroll restore. Re-runs when the list changes because the
  // revalidating fetch — not the mount — is what puts the new row on screen.
  useEffect(() => {
    if (!booted) return;
    const focusId = peekPendingFocusItemId();
    if (focusId) {
      const row = document.querySelector(`.item-card[data-item-id="${focusId}"]`);
      if (!row) return; // not rendered yet: keep waiting, no scroll restore
      clearPendingFocusItemId();
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      row.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
      return;
    }
    const restoreY = handoffScrollRef.current;
    handoffScrollRef.current = null;
    if (restoreY !== null) window.scrollTo(0, restoreY);
  }, [booted, ownItems]);

  async function boot() {
    try {
      // Share-target seam: the server maps /add (the manifest action) to the
      // shell, so a share arrival normally renders AddPage directly. This
      // still catches the one path that reaches the feed with share params:
      // the offline SW shell serves "/" for any navigation. Redirect rather
      // than render the feed with an add sheet — the sheet is gone (#62).
      const share = parseShareTarget(new URLSearchParams(location.search));
      if (share.url || share.title) {
        navigate(`/add${location.search}`, { replace: true });
        return;
      }

      const meRes = await fetch("/api/auth/me");
      if (meRes.status === 401) {
        // Carry share-target prefill through the login hop.
        const here = location.pathname + location.search;
        navigate(`/login?next=${encodeURIComponent(here)}`);
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
        await Promise.all([refreshSummary(stored.id), refreshOwnList(stored.id)]);
        setBooted(true);
        return;
      }
      const meBody = (await meRes.json()) as Me;
      setMe(meBody);
      writeStoredMe(meBody);

      // #62 D8: restore the snapshot taken when the user left the feed, so
      // Back from /add, /items/:id or /items/:id/edit lands on the feed they
      // left — same list context, same scroll — and only then revalidates.
      // Guarded by meId: a logout/login-as-someone-else between routes must
      // never render the previous user's rows.
      const snap = takeFeedSnapshot();
      if (snap && snap.meId === meBody.id) {
        setOwnItems(snap.ownItems);
        setOtherItems(snap.otherItems);
        setSummary(snap.summary);
        setViewing(snap.viewingUserId);
        setActiveTag(snap.activeTag);
        handoffScrollRef.current = snap.scrollY;
        setBooted(true); // data is on screen: no skeleton flash
        void Promise.all([refreshSummary(meBody.id), refreshOwnList(meBody.id)]);
        return;
      }

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

  async function refreshOwnList(userId: string): Promise<OwnedItem[] | null> {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/users/${userId}/wishlist`);
      if (res.ok) {
        const items = (await res.json()) as OwnedItem[];
        setOwnItems(items);
        return items;
      }
      return null;
    } finally {
      setRefreshing(false);
    }
  }

  async function viewList(userId: string) {
    setReordering(false);
    setGuestItemId(null);
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
    setReordering(false);
    setGuestItemId(null);
    setViewing(null);
    setOtherItems([]);
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

  function exitReorderMode() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setReordering(false);
    reorderToggleRef.current?.focus();
  }

  useEffect(() => {
    if (!reordering) return;

    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || reorder.isDragging) return;
      if (document.querySelector(".sheet-overlay, .confirm-overlay, .detail-overlay, .menu-sheet")) return;
      event.preventDefault();
      exitReorderMode();
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [reordering, reorder.isDragging]);

  function enterReorderMode() {
    setActiveTag(null);
    setReordering(true);
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".item-list .drag-handle")?.focus();
    });
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
      void pollEnrichment(me.id, id);
    }
  }

  /** Poll while an item is still enriching. The response is returned by
   *  refreshOwnList so the stop condition never reads stale render state. */
  async function pollEnrichment(userId: string, itemId: string) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const items = await refreshOwnList(userId);
      const item = items?.find((candidate) => candidate.id === itemId);
      if (!item || item.fetchState !== "pending") return;
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
    navigate("/login");
  }

  function goToSettings() {
    navigate("/settings");
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
  const guestItem = otherItems.find((item) => item.id === guestItemId) ?? null;

  function ownerRefFor(userId: string): OwnerRef {
    const row = summary.find((r) => r.userId === userId);
    return row ? { id: row.userId, displayName: row.displayName } : ownRef;
  }

  const renderPeekGrip = (id: string) => {
    const props = reorder.getHandleProps(id);
    return (
      <button
        type="button"
        {...props}
        tabIndex={-1}
        className={`${props.className} drag-handle--peek`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    );
  };

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
          onOpenDetails={setGuestItemId}
        />
      );
    }

    if (ownItems.length === 0) {
      return (
        <EmptyState
          title={S.empty.own}
          body={S.empty.ownHint}
          action={
            <button className="primary" onClick={() => navigate("/add")}>
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
        onDelete={reordering ? undefined : deleteItem}
        onRefresh={reordering ? undefined : refreshItem}
        onResetPurchased={reordering ? undefined : resetPurchased}
        onOpenDetails={reordering ? undefined : (id) => navigate(`/items/${id}`)}
        renderDragHandle={
          reordering && !activeTag
            ? (id) => (
                <button type="button" {...reorder.getHandleProps(id)}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              )
            : undefined
        }
        renderPeekGrip={!reordering && !activeTag && ownItems.length > 1 ? renderPeekGrip : undefined}
        draggingId={reordering ? reorder.draggingId : undefined}
      />
    );
  }

  const showOwnerActions = !viewing && ownItems.length > 0;
  const ownerActions = showOwnerActions ? (
    <>
      <IconButton variant="ghost" label={S.list.addItem} onClick={() => navigate("/add")}>
        <PlusIcon />
      </IconButton>
      <div className="share-anchor">
        <IconButton
          ref={shareTriggerRef}
          variant="ghost"
          label={S.share.shareList}
          onClick={() => setShareOpen((v) => !v)}
          aria-expanded={shareOpen}
          aria-haspopup="dialog"
        >
          <ShareIcon />
        </IconButton>
        <ShareMenu open={shareOpen} onClose={() => setShareOpen(false)} triggerRef={shareTriggerRef} />
      </div>
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
            action={
              !viewing && ownItems.length > 1 ? (
                <button
                  ref={reorderToggleRef}
                  type="button"
                  className="secondary compact-action"
                  aria-pressed={reordering}
                  onClick={reordering ? exitReorderMode : enterReorderMode}
                >
                  {reordering ? S.list.doneReordering : S.list.reorder}
                </button>
              ) : undefined
            }
          />
          {!viewing && ownItems.length > 0 && !reordering && (
            <FilterChips
              tags={allTags}
              active={activeTag}
              onSelect={setActiveTag}
            />
          )}
          {renderList()}
        </section>

      </div>

      {viewing && guestItem && (
        <GuestItemDetailSheet
          item={toGuestDetail(guestItem)}
          onClose={() => setGuestItemId(null)}
        />
      )}
    </AppShell>
  );
}

/** Maps the other-user projection (PublicItem) into the guest detail sheet's
 *  normalized shape. Only fields PublicItem actually carries are read — an
 *  owner-only field (hints, priceStats, cheaperUrl) is not even addressable
 *  here, so nothing can reach the sheet by omission. The image stays on the
 *  session-scoped route the public rows already use; there is no claim
 *  state in this shape (it lives on the row) and no purchased state, because
 *  the other-user projection has none. */
function toGuestDetail(item: PublicItem): GuestItemDetail {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    priceCents: item.priceCents,
    currency: item.currency,
    notes: item.notes,
    tags: item.tags,
    siteName: item.siteName,
    imageSrc: item.imagePath ? `/api/wishlist/items/${item.id}/image` : undefined,
    createdAt: item.createdAt,
  };
}