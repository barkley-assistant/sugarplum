import { useEffect, useRef, useState } from "react";
import type {
  Me,
  OwnedItem,
  PublicItem,
  WishlistSummaryRow,
} from "../../shared/types";
import { S } from "../strings";
import { classifyResponse, classifyWriteFailure } from "../net";
import { useToast } from "../toast";
import { useDragReorder } from "../reorder";
import { parseShareTarget } from "../format";
import { navigate } from "../router";
import {
  clearPendingFocusItemId,
  peekPendingFocusItemId,
  saveFeedSnapshot,
  takeFeedSnapshot,
  takeFeedViewingHandoff,
  trackFeedScroll,
  trackedFeedScrollY,
} from "../feed-handoff";
import {
  readStoredMe,
  readStoredSummary,
  writeStoredMe,
  writeStoredSummary,
} from "../me-store";
import { EmptyState } from "./EmptyState";
import { FilterChips } from "./FilterChips";
import { ItemList, type OwnerRef } from "./ItemList";
import { GuestItemDetailSheet, type GuestItemDetail } from "./GuestItemDetailSheet";
import { AppShell, AppShellLoading } from "./AppShell";
import { ListSwitcher } from "./ListSwitcher";

export function AppPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [summary, setSummary] = useState<WishlistSummaryRow[]>([]);
  const [ownItems, setOwnItems] = useState<OwnedItem[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const [otherItems, setOtherItems] = useState<PublicItem[]>([]);
  const [booted, setBooted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [guestItemId, setGuestItemId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  /** #134: in-flight commit PUTs. A COUNT, not a boolean: a second drag may
   *  start while the first PUT is still out (accepted — see the busy-label
   *  decision), and a boolean would let the first `finally` clear the label
   *  while the second PUT is pending. */
  const [savingPuts, setSavingPuts] = useState(0);
  const reorderToggleRef = useRef<HTMLButtonElement | null>(null);
  /** #134: the order to PUT back if the user taps Undo on the "Order saved"
   *  snackbar (null = nothing to undo). Read at click time, never captured in
   *  a closure — a replaced snackbar must offer the LATEST commit's target. */
  const undoOrderRef = useRef<string[] | null>(null);
  /** #134: mirror of `reorder.isDragging` for the Undo guard. The toast's
   *  action closure is baked when the commit runs, and by then isDragging has
   *  already been flushed false — only a ref sees a drag that started after. */
  const dragLiveRef = useRef(false);
  /** #62 D8: scroll position handed back from feed-handoff, applied after the
   *  restored rows commit (the list must exist before scrollTo can stick). */
  const handoffScrollRef = useRef<number | null>(null);
  /** #69: start of the current "some row is pending" episode, so the poll
   *  window is bounded across effect re-runs (see the convergence effect). */
  const pendingPollStartRef = useRef<number | null>(null);
  const toast = useToast();
  const reorder = useDragReorder(ownItems, onReorder);

  // #134: keep the Undo guard's view of a live drag (or drop settle) current.
  // No dep array: the mirror must follow every render of the hook's state.
  useEffect(() => {
    dragLiveRef.current = reorder.isDragging;
  });

  useEffect(() => {
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // #69: converge pending rows. boot() fetches the list exactly once per mount,
  // so a scrape that commits after that read would leave its row stuck on the
  // provisional hostname title ("Fetching details…") forever — the manual
  // re-check path polls, the add path did not. While any own row is pending,
  // re-read the list after 1.5s (same budget as ItemPage.pollUntilSettled).
  // Each effect run schedules exactly ONE fetch; the setOwnItems commit
  // re-triggers this effect, which re-derives the condition from fresh state —
  // so there is no loop to leak and unmount safety is just clearTimeout.
  useEffect(() => {
    if (!booted || !me || viewing !== null || reorder.isDragging) return;
    if (!ownItems.some((item) => item.fetchState === "pending")) {
      // Converged: a later pending row starts a fresh 30s window.
      pendingPollStartRef.current = null;
      return;
    }
    if (pendingPollStartRef.current === null) pendingPollStartRef.current = Date.now();
    if (Date.now() - pendingPollStartRef.current > 30_000) return; // one 30s window per episode
    const userId = me.id;
    const timer = setTimeout(() => void refreshOwnList(userId), 1500);
    return () => clearTimeout(timer);
    // refreshOwnList is re-created every render, so it is deliberately not a
    // dep: including it would turn this into a fetch-per-render loop.
  }, [booted, me, viewing, reorder.isDragging, ownItems]);

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
    // #125: a list chosen from a SUBPAGE's switcher. Read once, at the top:
    // the handoff is one-shot, and a boot that cannot honour it (share-target
    // redirect, offline fallback) must still consume it rather than let it
    // surprise a later boot. `undefined` means "no handoff"; `null` means
    // "the signed-in user's own list" and overrides the snapshot's viewing
    // user.
    const viewingHandoff = takeFeedViewingHandoff();
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
        setSummary(snap.summary);
        const viewingUser = viewingHandoff === undefined ? snap.viewingUserId : viewingHandoff;
        setViewing(viewingUser);
        // The snapshot's filter, scroll offset and rows belong to the list
        // that was on screen. A handoff that lands on a DIFFERENT list starts
        // it at the top: restoring the old offset would open the new list at
        // a clamped arbitrary position, and its rows would be the wrong
        // list's rows under the new heading (plan D4).
        if (viewingUser === snap.viewingUserId) {
          setActiveTag(snap.activeTag);
          handoffScrollRef.current = snap.scrollY;
          setOtherItems(snap.otherItems);
        }
        setBooted(true); // data is on screen: no skeleton flash
        void Promise.all([refreshSummary(meBody.id), refreshOwnList(meBody.id)]);
        // Revalidate the other user's list only when a handoff put it on
        // screen. A plain snapshot restore is the feed the user left, rows
        // and all — plan D4 invokes viewList for the handoff case only.
        if (viewingHandoff !== undefined && viewingUser !== null) void viewList(viewingUser);
        return;
      }

      await Promise.all([refreshSummary(), refreshOwnList(meBody.id)]);
      setBooted(true);
      if (viewingHandoff) void viewList(viewingHandoff);
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
    let res: Response | null = null;
    try {
      res = await fetch(`/api/wishlist/items/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      if (me) await refreshOwnList(me.id);
      await refreshSummary();
    } catch (err) {
      // #117: the connection's fault is named as such; a real server answer
      // keeps the action's own copy.
      const kind = res ? await classifyResponse(res) : classifyWriteFailure(err);
      toast(kind === "offline" ? S.offline.write : S.errors.deleteItem, "danger");
    }
  }

  /** Blind purchased reset (owner-only route, 204 with no body): the owner
   *  never learns whether a mark existed, when, or who set it. */
  async function resetPurchased(id: string) {
    const res = await fetch(`/api/wishlist/items/${id}/purchased`, { method: "DELETE" });
    if (res.status !== 204) {
      const kind = await classifyResponse(res);
      toast(kind === "offline" ? S.offline.write : S.errors.generic, "danger");
      return;
    }
    if (me) await refreshOwnList(me.id);
  }

  /** #76: the owner's own mark (confirm is in ItemCard). */
  async function markOwnerPurchased(id: string) {
    const res = await fetch(`/api/wishlist/items/${id}/owner-purchased`, { method: "PUT" });
    if (!res.ok) {
      const kind = await classifyResponse(res);
      toast(kind === "offline" ? S.offline.write : S.errors.generic, "danger");
      return;
    }
    if (me) await refreshOwnList(me.id);
  }

  async function unmarkOwnerPurchased(id: string) {
    const res = await fetch(`/api/wishlist/items/${id}/owner-purchased`, { method: "DELETE" });
    if (res.status !== 204) {
      const kind = await classifyResponse(res);
      toast(kind === "offline" ? S.offline.write : S.errors.generic, "danger");
      return;
    }
    if (me) await refreshOwnList(me.id);
  }

  /** Optimistic reorder commit: PUT the full ordered id array. On failure,
   *  restore the pre-commit order and surface a danger toast. On success the
   *  commit is live-saved and (unless `silent`) offers one Undo — the prior
   *  order, captured before the PUT so it is the order the server just
   *  replaced. Undo re-enters this same path, silently: an undo is not itself
   *  undoable (no redo ping-pong). */
  async function onReorder(ids: string[], opts?: { silent?: boolean }) {
    const previousItems = ownItems;
    const previousIds = ownItems.map((item) => item.id);
    setSavingPuts((n) => n + 1);
    let res: Response | null = null;
    try {
      res = await fetch("/api/wishlist/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: ids }),
      });
      if (!res.ok) throw new Error();
      if (!opts?.silent) {
        undoOrderRef.current = previousIds;
        // Keyed: a second commit replaces this snackbar instead of stacking,
        // so its Undo always targets the order before the LATEST commit.
        toast(
          S.list.orderSaved,
          "info",
          { label: S.list.undo, onSelect: undoReorder },
          "reorder",
        );
      }
      if (me) await refreshOwnList(me.id);
    } catch (err) {
      // A failed COMMIT rolls back to the last server-known order. A failed
      // UNDO must not: it never applied an optimistic order of its own, so the
      // list already shows what the server holds — restoring the stale
      // `ownItems` here would diverge from the server until the next refresh.
      // #117: the rollback stays on the offline path — the server never
      // received the new order, so the old one is the honest state, and only
      // the copy names the connection.
      if (!opts?.silent) setOwnItems(previousItems);
      const kind = res ? await classifyResponse(res) : classifyWriteFailure(err);
      toast(kind === "offline" ? S.offline.write : S.errors.reorder, "danger");
    } finally {
      setSavingPuts((n) => Math.max(0, n - 1));
    }
  }

  /** #134: restore the order the last commit replaced. Ignored while a drag or
   *  its drop settle is live: that settle owns the in-flight commit PUT, and
   *  two racing PUTs would decide the order non-deterministically. A failed
   *  undo leaves the list at the order the server still holds (this path never
   *  applied one of its own) and toasts honestly. */
  function undoReorder() {
    if (dragLiveRef.current) return;
    const prior = undoOrderRef.current;
    undoOrderRef.current = null;
    if (!prior) return;
    void onReorder(prior, { silent: true });
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
      const kind = await classifyResponse(res);
      toast(kind === "offline" ? S.offline.write : S.errors.retryItem, "danger");
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
      const kind = await classifyResponse(res);
      toast(kind === "offline" ? S.offline.write : S.errors.claimItem, "danger");
      return;
    }
    await viewList(viewing);
    await refreshSummary();
  }

  async function unclaim(id: string) {
    if (!viewing) return;
    const res = await fetch(`/api/wishlist/items/${id}/unclaim`, { method: "POST" });
    if (!res.ok) {
      const kind = await classifyResponse(res);
      toast(kind === "offline" ? S.offline.write : S.errors.unclaimItem, "danger");
      return;
    }
    await viewList(viewing);
    await refreshSummary();
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
    // #125 C.3: seed the boot shell with the cached identity so the header
    // does not morph (52 → 66px) when /api/auth/me answers. The guest share
    // boot does not pass it — anonymous stays anonymous.
    return <AppShellLoading me={readStoredMe()} />;
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
        onMarkOwnerPurchased={reordering ? undefined : markOwnerPurchased}
        onUnmarkOwnerPurchased={reordering ? undefined : unmarkOwnerPurchased}
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
        draggingId={reordering ? reorder.draggingId : undefined}
        droppingId={reordering ? reorder.droppingId : undefined}
      />
    );
  }

  /** #125: the feed keeps its own rules about WHICH actions apply — Add and
   *  Share only while the own list is on screen and non-empty (the issue
   *  freezes the feed) — but the cluster itself is the shared one every other
   *  page now renders. */
  const showOwnerActions = !viewing && ownItems.length > 0;

  return (
    <AppShell
      refreshing={refreshing}
      me={me}
      hideHeaderActions={!showOwnerActions}
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
                  aria-busy={reordering && savingPuts > 0 ? true : undefined}
                  onClick={reordering ? exitReorderMode : enterReorderMode}
                >
                  {reordering
                    ? savingPuts > 0
                      ? S.list.saving
                      : S.list.doneReordering
                    : S.list.reorder}
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
          {!viewing && reordering && ownItems.length > 0 && (
            <p className="reorder-hint">{S.list.reorderHint}</p>
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
 *  owner-only field (hints, cheaperUrl, priceSource) is not even addressable
 *  here, so nothing can reach the sheet by omission. #130 gave PublicItem the
 *  price ledger summary, so the sheet's history card and lowest line light up
 *  for other-user items exactly as #90's contract says they should. The image
 *  stays on the session-scoped route the public rows already use; there is no
 *  claim state in this shape (it lives on the row) and no purchased state,
 *  because the other-user projection has none. */
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
    priceStats: item.priceStats,
    imageSource: item.imageSource,
  };
}