import type { OwnedItem, PublicItem, WishlistSummaryRow } from "../shared/types";
import { onNavigateRequest } from "./router";

/** #62 D8: the feed's last-known state, so Back from /add, /items/:id or
 *  /items/:id/edit restores the feed without a skeleton → refetch →
 *  scroll-to-top flash. Module-level (not React state) because AppPage
 *  unmounts on every route change by design (#61 D4) and remounting is
 *  exactly where this snapshot re-hydrates from. Two-user-scale data: a few
 *  dozen rows. Nothing sensitive — the same DTOs the service worker already
 *  caches in sugarplum-data-v1. */
export interface FeedSnapshot {
  /** The feed may only be restored for the SAME user (logout + login as
   *  someone else between routes would otherwise render the wrong list). */
  meId: string;
  ownItems: OwnedItem[];
  otherItems: PublicItem[];
  summary: WishlistSummaryRow[];
  /** #158: WHICH list these rows belong to (null = the own list). Boot uses
   *  it to check that a snapshot describes the list the route names before
   *  restoring it — never as "switch to this list". */
  viewingUserId: string | null;
  activeTag: string | null;
  scrollY: number;
  savedAt: number;
}

const MAX_AGE_MS = 5 * 60_000;
let snapshot: FeedSnapshot | null = null;

/** The feed's scroll offset while it is on screen. It is TRACKED rather than
 *  read when the feed unmounts: navigate() scrolls the incoming view to the
 *  top in the same tick and React runs the unmount cleanup afterwards, so the
 *  naive read would always record 0. Tracking freezes at the navigation
 *  request for the same reason (the router's scroll-to-top fires a scroll
 *  event that must not be recorded). */
let feedScrollY = 0;
let scrollFrozen = false;

/** Starts tracking the feed's scroll offset; returns the cleanup. */
export function trackFeedScroll(): () => void {
  scrollFrozen = false;
  feedScrollY = window.scrollY;
  const onScroll = () => {
    if (!scrollFrozen) feedScrollY = window.scrollY;
  };
  const offNavigate = onNavigateRequest(() => {
    scrollFrozen = true;
  });
  window.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    window.removeEventListener("scroll", onScroll);
    offNavigate();
  };
}

/** The tracked offset — read it when SAVING the snapshot (leaving the feed),
 *  never on mount: mounting resets the tracker to the incoming view's own
 *  position. */
export function trackedFeedScrollY(): number {
  return feedScrollY;
}

export function saveFeedSnapshot(s: Omit<FeedSnapshot, "savedAt">): void {
  snapshot = { ...s, savedAt: Date.now() };
}

/** Reads the snapshot; a stale one is discarded and treated as absent, so the
 *  feed boots normally (the accepted INV-D exception). */
export function takeFeedSnapshot(): FeedSnapshot | null {
  if (!snapshot) return null;
  if (Date.now() - snapshot.savedAt > MAX_AGE_MS) {
    snapshot = null;
    return null;
  }
  return snapshot;
}

/** Post-add handoff: the feed scrolls this row into view after navigating
 *  back from a successful add (an `Add` on the add page cannot scroll the
 *  feed — it is not mounted). Read with peek + clear, not take: the row is
 *  not on screen the instant the feed re-mounts (the restored snapshot
 *  revalidates in the background), so the consumer re-checks on every list
 *  change and clears only once it has scrolled. */
let pendingFocusItemId: string | null = null;

export function setPendingFocusItemId(id: string): void {
  pendingFocusItemId = id;
}

export function peekPendingFocusItemId(): string | null {
  return pendingFocusItemId;
}

export function clearPendingFocusItemId(): void {
  pendingFocusItemId = null;
}

/** Called by the item page after a successful DELETE: the snapshot still
 *  holds the deleted row, and re-hydrating it on the way back would
 *  resurrect the item for the frames until the revalidating fetch lands.
 *  (An edit does not need this: one stale frame of title is harmless and the
 *  item page re-reads the list anyway.) */
export function pruneFeedSnapshotItem(itemId: string): void {
  if (!snapshot) return;
  if (snapshot.viewingUserId !== null) return;
  snapshot = { ...snapshot, ownItems: snapshot.ownItems.filter((i) => i.id !== itemId) };
}
