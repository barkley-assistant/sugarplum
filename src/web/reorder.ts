import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { flushSync } from "react-dom";
import { S } from "./strings";

/** Hand-rolled drag-reorder state machine (#91: fluid, frozen-DOM transforms).
 *
 *  - Mouse: lift immediately on pointerdown on the handle.
 *  - Touch: 300ms long-press to lift (haptic via navigator.vibrate), with an
 *    8px movement tolerance so scrolls are never hijacked.
 *  - While dragging the DOM is FROZEN — the list never re-renders. The lifted
 *    card follows the pointer through an inline translate written in a rAF
 *    loop, and the rows it passes slide out of the way through inline
 *    translates of their own (compositor-only: no layout, no React render).
 *    Every measurement is in DOCUMENT coordinates, so an auto-scroll step near
 *    a viewport edge never detaches the card from the pointer (both inputs to
 *    the offset shift together with the scroll).
 *  - Release: the card settles into the slot the siblings already opened, then
 *    the ONE PUT commits the order (optimistic, rollback on failure). The
 *    locally-ordered override is held until that PUT resolves, so neither the
 *    drop nor a failed commit flashes the stale order.
 *  - Keyboard fallback: ArrowUp/ArrowDown on the focused handle moves the
 *    item; the move is committed on blur or Enter (one PUT per batch).
 *  - prefers-reduced-motion: no follow, no transforms, no auto-scroll, no drop
 *    animation — the list re-renders per crossing exactly as it did before.
 *
 *  Listeners are attached once on mount and read mutable refs, so no
 *  add/remove dance is needed while a drag is in flight.
 */

const LONG_PRESS_MS = 300;
const MOVE_TOLERANCE_PX = 8;

/** Auto-scroll: a pointer inside this band of a viewport edge scrolls the page,
 *  at most this many pixels per frame. */
const EDGE_ZONE_PX = 48;
const MAX_SCROLL_PER_FRAME_PX = 12;

/** Safety net: hand the order over even if `transitionend` never arrives. */
const SETTLE_FALLBACK_MS = 200;

/** Lift scale. JS composes it into the inline transform (CSS cannot: an inline
 *  transform would replace a class-level one) so the drop can animate the scale
 *  away in the same motion as the translate. */
const LIFT_SCALE = 1.02;

export interface HandleProps {
  className: string;
  "aria-label": string;
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onBlur: () => void;
}

export interface DragReorderHandle {
  /** The order currently displayed (source order, locally reordered after
   *  arrow-key moves and through the in-flight PUT after a drop). */
  orderedIds: string[];
  /** True while a pointer drag is active, including the drop settle. */
  isDragging: boolean;
  /** Id of the card currently lifted, if any. */
  draggingId: string | null;
  /** Id of the card currently settling into its slot (~150ms between release
   *  and the order's handoff to React). */
  droppingId: string | null;
  /** Spread these on each card's drag-handle button. */
  getHandleProps: (id: string) => HandleProps;
}

interface PressState {
  id: string;
  element: HTMLButtonElement;
  pointerId: number;
  x: number;
  y: number;
}

/** Everything the pointer drag needs, captured ONCE at lift. The DOM does not
 *  re-render during a drag and transforms do not affect layout, so these rects
 *  stay true for the whole gesture. */
interface DragState {
  listEl: HTMLElement;
  dragEl: HTMLElement;
  dragId: string;
  /** Every row of the list, in frozen DOM order. */
  cards: HTMLElement[];
  /** Row ids in frozen DOM order — the drag's base order. */
  ids: string[];
  /** Document-space top of each slot (viewport top + scrollY, at lift). */
  tops: number[];
  /** Slot heights at lift. */
  heights: number[];
  /** Slot the card was lifted from. */
  from: number;
  /** Pointer position inside the card, measured from its top edge. */
  offsetY: number;
  /** Latest pointer viewport Y. */
  pointerY: number;
  /** Slot the lifted card currently occupies, driven by the pointer. */
  virtualIndex: number;
  reduced: boolean;
}

/** The handoff window: the card is animating into its slot and the commit has
 *  not run yet. Kept beside DragState so a late rAF tick cannot touch it. */
interface SettleState {
  dragEl: HTMLElement;
  cards: HTMLElement[];
  finalOrder: string[];
  timer: ReturnType<typeof setTimeout> | null;
  onTransitionEnd: ((event: TransitionEvent) => void) | null;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** `ids` with `id` moved to `toIndex` (clamped). Returns a new array. */
function withMoved(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from === -1) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, id);
  return next;
}

/** Which slot the pointer is over, from the SNAPSHOT alone — no DOM reads, so
 *  no layout thrash. `docY` is document-space; mixing viewport Y in here while
 *  the follow offset uses docY is what corrupts the index during auto-scroll. */
function virtualIndexAt(s: DragState, docY: number): number {
  let skipped = 0;
  let slot = s.ids.length - 1;
  for (let i = 0; i < s.ids.length; i++) {
    if (i === s.from) {
      skipped++;
      continue;
    }
    if (docY < s.tops[i] + s.heights[i] / 2) {
      slot = i - skipped;
      break;
    }
  }
  return slot;
}

export function useDragReorder(
  items: readonly { id: string; title: string }[],
  onCommit: (orderedIds: string[]) => void | Promise<void>,
): DragReorderHandle {
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [droppingId, setDroppingId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const itemsRef = useRef(items);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    itemsRef.current = items;
    onCommitRef.current = onCommit;
  });

  const orderRef = useRef<string[] | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const pressStartRef = useRef<PressState | null>(null);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommitRef = useRef<string[] | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const settleRef = useRef<SettleState | null>(null);

  const baseIds = items.map((i) => i.id);
  const orderedIds = orderOverride ?? baseIds;

  const clearPress = useCallback(() => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    pressStartRef.current = null;
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const clearTransforms = useCallback((cards: readonly HTMLElement[]) => {
    for (const card of cards) card.style.transform = "";
  }, []);

  /** PUT the order, or null when it did not actually change. The promise
   *  settles on the failure path too — rollback is a resolve, not an error. */
  const commitOrder = useCallback((ids: string[]): Promise<void> | null => {
    if (sameIds(ids, itemsRef.current.map((i) => i.id))) return null;
    return Promise.resolve(onCommitRef.current(ids)).then(
      () => undefined,
      () => undefined,
    );
  }, []);

  /** Commit an order while KEEPING the local order displayed until the PUT
   *  resolves. Without the hold the still-stale items array renders the old
   *  order the instant the drag ends (and again on a rollback) — the old-order
   *  flash #91 removes. The release is guarded by array equality, so a second
   *  drag whose own hold began before this PUT resolved cannot have its
   *  override wiped by this one's release. */
  const commitHolding = useCallback(
    (ids: string[]) => {
      orderRef.current = ids;
      setOrderOverride(ids);
      const pending = commitOrder(ids);
      const release = () => {
        if (!orderRef.current || !sameIds(orderRef.current, ids)) return;
        orderRef.current = null;
        setOrderOverride(null);
      };
      if (pending) void pending.then(release, release);
      else release();
    },
    [commitOrder],
  );

  const commitPending = useCallback(() => {
    if (!pendingCommitRef.current) return;
    const next = pendingCommitRef.current;
    pendingCommitRef.current = null;
    commitHolding(next);
  }, [commitHolding]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const ids = orderRef.current ?? itemsRef.current.map((i) => i.id);
        const from = ids.indexOf(id);
        if (from === -1) return;
        const to = e.key === "ArrowUp" ? Math.max(0, from - 1) : Math.min(ids.length - 1, from + 1);
        if (to === from) return;
        const next = withMoved(ids, id, to);
        orderRef.current = next;
        setOrderOverride(next);
        pendingCommitRef.current = next;
      } else if (e.key === "Enter") {
        commitPending();
      }
    },
    [commitPending],
  );

  /** Write the other rows' translates for `target`, and return the lifted
   *  card's own landing offset. Row pitches come from the snapshot, so rows of
   *  different heights land exactly where the re-render will put them — the
   *  drop never assumes rows are uniform. */
  const paintTargetLayout = useCallback((s: DragState, target: readonly string[]): number => {
    const slotOf = new Map(s.ids.map((id, i) => [id, i] as const));
    let cursor = s.tops[0];
    let landing = 0;
    for (const id of target) {
      const slot = slotOf.get(id) as number;
      const dy = Math.round(cursor - s.tops[slot]);
      if (id === s.dragId) {
        landing = dy;
      } else {
        s.cards[slot].style.transform = dy ? `translate3d(0, ${dy}px, 0)` : "";
      }
      cursor += s.heights[slot];
    }
    return landing;
  }, []);

  /** One frame of the drag: the card follows the pointer, and crossing a row
   *  midpoint slides the rows in between out of the way. */
  const syncDrag = useCallback(
    (s: DragState) => {
      const docY = s.pointerY + window.scrollY;
      const index = virtualIndexAt(s, docY);
      if (index !== s.virtualIndex) {
        s.virtualIndex = index;
        paintTargetLayout(s, withMoved(s.ids, s.dragId, index));
      }
      const dy = Math.round(docY - s.offsetY - s.tops[s.from]);
      s.dragEl.style.transform = `translate3d(0, ${dy}px, 0) scale(${LIFT_SCALE})`;
    },
    [paintTargetLayout],
  );

  /** Pre-#91 behaviour, kept for prefers-reduced-motion: no transforms, no
   *  follow — the list re-renders in the new order as the pointer crosses a
   *  midpoint. Index math runs against the LIVE rows, which is correct here
   *  because that path does re-render. */
  const reorderOnMove = useCallback((s: DragState, clientY: number) => {
    const cards = Array.from(s.listEl.querySelectorAll<HTMLElement>(".item-card"));
    let skipped = 0;
    let insertBefore = cards.length - 1;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (card.dataset.itemId === s.dragId) {
        skipped++;
        continue;
      }
      const rect = card.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        insertBefore = i - skipped;
        break;
      }
    }
    const current = orderRef.current ?? itemsRef.current.map((i) => i.id);
    const next = withMoved(current, s.dragId, insertBefore);
    if (!sameIds(next, current)) {
      orderRef.current = next;
      setOrderOverride(next);
    }
  }, []);

  /** Near an edge the page scrolls itself, proportionally to how deep the
   *  pointer is into the band. Document coordinates keep the card glued. */
  const autoScroll = useCallback((pointerY: number) => {
    const bottom = window.innerHeight - EDGE_ZONE_PX;
    if (pointerY < EDGE_ZONE_PX) {
      const ratio = Math.min(1, (EDGE_ZONE_PX - pointerY) / EDGE_ZONE_PX);
      window.scrollBy(0, -Math.ceil(MAX_SCROLL_PER_FRAME_PX * ratio));
    } else if (pointerY > bottom) {
      const ratio = Math.min(1, (pointerY - bottom) / EDGE_ZONE_PX);
      window.scrollBy(0, Math.ceil(MAX_SCROLL_PER_FRAME_PX * ratio));
    }
  }, []);

  /** The frame loop runs CONTINUOUSLY while a drag is live, not only on
   *  pointermove: auto-scroll has to keep stepping while the pointer holds
   *  still near an edge. Held in a ref so it can reschedule itself. */
  const frameRef = useRef<() => void>(() => {});
  useEffect(() => {
    frameRef.current = () => {
      rafRef.current = null;
      const s = dragRef.current;
      if (!s) return;
      syncDrag(s);
      autoScroll(s.pointerY);
      rafRef.current = requestAnimationFrame(() => frameRef.current());
    };
  });

  const startLoop = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(() => frameRef.current());
  }, []);

  /** Hand the visual order over to React in ONE frame. The transforms are
   *  cleared in the same task as the re-render and the drop class is removed in
   *  the same commit, so the reordered layout is pixel-identical to what the
   *  transforms were already showing: no flash, and no transition left armed to
   *  animate the layout move. flushSync is what makes that atomic — a
   *  default-lane update would commit a frame later, after the transforms had
   *  already been cleared. */
  const handOver = useCallback(
    (s: DragState, settle: SettleState) => {
      if (settleRef.current !== settle) return; // transitionend and the fallback raced
      settleRef.current = null;
      if (settle.timer) clearTimeout(settle.timer);
      if (settle.onTransitionEnd) {
        settle.dragEl.removeEventListener("transitionend", settle.onTransitionEnd);
      }
      orderRef.current = settle.finalOrder;
      dragRef.current = null;
      flushSync(() => {
        setOrderOverride(settle.finalOrder);
        setDraggingId(null);
        setDroppingId(null);
        setIsDragging(false);
      });
      clearTransforms(s.cards);
      commitHolding(settle.finalOrder);
    },
    [clearTransforms, commitHolding],
  );

  /** End a pointer gesture. `cancelled` is pointercancel: the browser took the
   *  gesture over (touch scroll takeover), so the move is discarded and
   *  nothing is committed. */
  const endDrag = useCallback(
    (cancelled: boolean) => {
      stopLoop();
      clearPress();
      const dragged = draggingIdRef.current;
      if (!dragged) return; // no drag in flight (also: during the drop settle)
      const s = dragRef.current;
      draggingIdRef.current = null;
      pointerIdRef.current = null;
      if (!s) {
        setDraggingId(null);
        setIsDragging(false);
        return;
      }

      if (cancelled) {
        dragRef.current = null;
        clearTransforms(s.cards);
        flushSync(() => {
          setDraggingId(null);
          setIsDragging(false);
        });
        return;
      }

      // Re-evaluate synchronously: a synthetic drag (Playwright's dragTo) or a
      // fast flick can move and release inside one frame, before a tick ran.
      syncDrag(s);
      const finalOrder = withMoved(s.ids, s.dragId, s.virtualIndex);

      if (s.reduced) {
        dragRef.current = null;
        orderRef.current = finalOrder;
        flushSync(() => {
          setOrderOverride(finalOrder);
          setDraggingId(null);
          setIsDragging(false);
        });
        clearTransforms(s.cards);
        commitHolding(finalOrder);
        return;
      }

      // Settle: the rows are already where they belong; the lifted card slides
      // from the pointer into the slot they opened for it.
      const landing = paintTargetLayout(s, finalOrder);
      flushSync(() => {
        setDraggingId(null);
        setDroppingId(s.dragId);
      });
      s.dragEl.style.transform = `translate3d(0, ${landing}px, 0)`;

      const settle: SettleState = {
        dragEl: s.dragEl,
        cards: s.cards,
        finalOrder,
        timer: null,
        onTransitionEnd: null,
      };
      settle.onTransitionEnd = (event) => {
        if (event.target === s.dragEl && event.propertyName === "transform") handOver(s, settle);
      };
      s.dragEl.addEventListener("transitionend", settle.onTransitionEnd);
      settle.timer = setTimeout(() => handOver(s, settle), SETTLE_FALLBACK_MS);
      settleRef.current = settle;
      // isDragging stays true through the settle (~150ms): the pending-row poll
      // must not re-render the list under the animation, and Escape stays
      // ignored because this is still a drag.
    },
    [clearPress, clearTransforms, commitHolding, handOver, paintTargetLayout, stopLoop, syncDrag],
  );

  const lift = useCallback(
    (state: PressState) => {
      clearPress();
      const listEl = state.element.closest<HTMLElement>(".item-list");
      const cards = listEl ? Array.from(listEl.querySelectorAll<HTMLElement>(".item-card")) : [];
      const from = cards.findIndex((card) => card.dataset.itemId === state.id);
      if (!listEl || from === -1) {
        // Detached list, or a row that is not part of one: nothing to drag.
        return;
      }
      try {
        state.element.setPointerCapture(state.pointerId);
      } catch {
        // pointer already released; the window listeners still drive the drag
      }

      const rects = cards.map((card) => card.getBoundingClientRect());
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      dragRef.current = {
        listEl,
        dragEl: cards[from],
        dragId: state.id,
        cards,
        ids: cards.map((card) => card.dataset.itemId ?? ""),
        tops: rects.map((rect) => rect.top + window.scrollY),
        heights: rects.map((rect) => rect.height),
        from,
        offsetY: state.y - rects[from].top,
        pointerY: state.y,
        virtualIndex: from,
        reduced,
      };

      pointerIdRef.current = state.pointerId;
      draggingIdRef.current = state.id;
      setDraggingId(state.id);
      setIsDragging(true);
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate?.(10);
      }
      if (!reduced) startLoop();
    },
    [clearPress, startLoop],
  );

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLButtonElement>, id: string) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (draggingIdRef.current || settleRef.current) return;

      const state: PressState = {
        id,
        element: e.currentTarget,
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
      };
      pressStartRef.current = state;

      if (e.pointerType === "touch") {
        pressTimerRef.current = setTimeout(() => {
          if (pressStartRef.current === state) lift(state);
        }, LONG_PRESS_MS);
      } else {
        lift(state);
      }
    },
    [lift],
  );

  const getHandleProps = useCallback(
    (id: string): HandleProps => {
      // Name each handle after its row: with a bare "Move item" a screen
      // reader hears the same label on every card.
      const title = items.find((item) => item.id === id)?.title ?? "";
      return {
        className: `drag-handle${draggingId === id ? " is-active" : ""}`,
        "aria-label": title ? S.dnd.moveItemNamed(title) : S.dnd.moveItem,
        onPointerDown: (e) => handlePointerDown(e, id),
        onKeyDown: (e) => handleKeyDown(e, id),
        onBlur: commitPending,
      };
    },
    [draggingId, items, handleKeyDown, handlePointerDown, commitPending],
  );

  // Permanent window listeners: the state machine lives in refs, so the
  // handlers act only when a drag is actually in flight.
  useEffect(() => {
    function onWindowPointerMove(e: globalThis.PointerEvent) {
      const pressed = pressStartRef.current;
      if (pressed && !draggingIdRef.current) {
        const dx = Math.abs(e.clientX - pressed.x);
        const dy = Math.abs(e.clientY - pressed.y);
        if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) clearPress();
        return;
      }
      const s = dragRef.current;
      if (!s) return;
      s.pointerY = e.clientY;
      // The rAF loop owns the animated path; reduced motion re-orders here.
      if (s.reduced) reorderOnMove(s, e.clientY);
    }

    function onWindowPointerUp() {
      endDrag(false);
    }

    function onWindowPointerCancel() {
      endDrag(true);
    }

    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerCancel);
    return () => {
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerCancel);
    };
  }, [clearPress, endDrag, reorderOnMove]);

  // Unmount mid-drag (navigation, mode exit): leave no rAF loop, no timer and
  // no inline transform behind.
  useEffect(
    () => () => {
      stopLoop();
      const settle = settleRef.current;
      if (settle) {
        if (settle.timer) clearTimeout(settle.timer);
        if (settle.onTransitionEnd) {
          settle.dragEl.removeEventListener("transitionend", settle.onTransitionEnd);
        }
        clearTransforms(settle.cards);
        settleRef.current = null;
      }
      const s = dragRef.current;
      if (s) {
        clearTransforms(s.cards);
        dragRef.current = null;
      }
      if (pressTimerRef.current) {
        clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
    },
    [clearTransforms, stopLoop],
  );

  return { orderedIds, isDragging, draggingId, droppingId, getHandleProps };
}
